import { DATA_KEY, MESSAGE_KEY, automaticTitle, getTitle, isCustomTitle } from './model.js';
import { ElevatorPanel } from './elevator-ui.js';
import { MessageBatchUI } from './message-batch-ui.js';
import { MessageReorderUI } from './message-reorder-ui.js';
import { SingleMessageActions } from './single-message-actions.js';
import { ExclusiveQuietMenus } from './exclusive-quiet-menus.js';
import { withQuietPreview, previewSwipes, messageTooltipText, QUIET_DETAIL_HEIGHT } from './quiet-preview.js';
import { installExtensionUpdateUI } from './update-ui.js';
import { installDiagnosticsSettings } from './diagnostics-ui.js';
import { installSettingsBackupUI } from './settings-backup-ui.js';
import { installLibraryBackupUI } from './library-backup-ui.js';
import { constrainNavPosition, fromRelativeNavPosition, toRelativeNavPosition } from './position.js';
import { PANEL_MIN_WIDTH, PANEL_MIN_HEIGHT, PANEL_MAX_WIDTH, PANEL_MAX_HEIGHT, fitPanelSize } from './panel-size.js';
import { GROUP_SIZE, MESSAGE_ROW_HEIGHT, buildOutlineRows, filterOutlineEntries, findOutlineRow } from './outline.js';

const BUTTONS = [
    ['first', '처음 메시지', 'chevrons-up'],
    ['previous', '이전 메시지', 'chevron-up'],
    ['outline', '메시지 개요 열기/닫기', 'list'],
    ['next', '다음 메시지', 'chevron-down'],
    ['last', '마지막 메시지', 'chevrons-down'],
];
const PATHS = {
    'chevrons-up': '<path d="m17 11-5-5-5 5"/><path d="m17 18-5-5-5 5"/>',
    'chevron-up': '<path d="m18 15-6-6-6 6"/>',
    'list': '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevrons-down': '<path d="m7 6 5 5 5-5"/><path d="m7 13 5 5 5-5"/>',
    'pencil': '<path d="m16 5 3 3M4 20l4.5-1 10-10a2.12 2.12 0 0 0-3-3l-10 10z"/>',
    'x': '<path d="M18 6 6 18M6 6l12 12"/>',
    'check': '<path d="m20 6-11 11-5-5"/>',
    'search': '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    'star': '<path d="m12 2 3.1 6.4 7 .9-5.1 5 .9 7-5.9-3.3-5.9 3.3.9-7-5.1-5 7-.9z"/>',
    'eye': '<path d="M2 12s3.8-7 10-7 10 7 10 7-3.8 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    'more': '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
};
function icon(name) {
    // Icons are static, authored markup; no chat data is interpolated.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.innerHTML = PATHS[name] || PATHS.list;
    return svg;
}
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
function button(kind, label, iconName) {
    const b = el('button', 'stmn-button');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.dataset.action = kind;
    b.append(icon(iconName));
    return b;
}
function sanitizeAvatarUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
        const url = new URL(value, location.href);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return url.href;
    } catch { return null; }
}

function avatarFor(context, message) {
    if (message?.force_avatar) return sanitizeAvatarUrl(message.force_avatar);
    const groupOrCharacter = !message?.is_user;
    if (groupOrCharacter) {
        const chars = Array.isArray(context.characters) ? context.characters : [];
        const match = chars.find(char => char?.name === message.name && char.avatar && char.avatar !== 'none');
        const active = chars[context.characterId];
        const avatar = match?.avatar || (!context.groupId && active?.avatar !== 'none' ? active?.avatar : null);
        if (avatar && typeof context.getThumbnailUrl === 'function') {
            return sanitizeAvatarUrl(context.getThumbnailUrl('avatar', avatar));
        }
    }
    // For users, SillyTavern normally records a force_avatar if a persona is
    // locked. For other user messages prefer the already rendered ST avatar.
    const example = document.querySelector(message?.is_user
        ? '#chat > .mes[is_user="true"] .avatar img, #user_avatar_block img'
        : '#chat > .mes[is_user="false"] .avatar img');
    return sanitizeAvatarUrl(example?.getAttribute('src'));
}
function avatarElement(context, message) {
    const circle = el('span', 'stmn-avatar');
    const name = String(message?.name ?? (message?.is_user ? 'User' : '?'));
    circle.textContent = name.slice(0, 1).toUpperCase() || '?';
    const url = avatarFor(context, message);
    if (url) {
        const img = el('img', 'stmn-avatar-img');
        img.alt = '';
        img.loading = 'lazy';
        img.referrerPolicy = 'same-origin';
        img.addEventListener('error', () => img.remove(), { once: true });
        img.src = url;
        circle.append(img);
    }
    return circle;
}

const OVERSCAN = 6;

export class NavigatorView {
    constructor(callbacks) {
        this.callbacks = callbacks;
        this.panelOpen = false;
        this.entries = [];
        // Weak keys allow chats removed from memory to be garbage collected.
        this.outlineEntryCache = new WeakMap();
        this.filtered = [];
        this.displayRows = [];
        this.groupCollapsed = new Set();
        this.query = '';
        this.editing = -1;
        this.editValue = '';
        this.expandedPreviewIndex = null;
        this.previewSwipeIndex = null;
        this.previewChat = null;
        this.previewBusy = false;
        this.tooltipTimer = null;
        this.tooltip = null;
        this.raf = null;
        this.lastRange = '';
        this.root = el('div', 'stmn-root');
        this.root.id = 'stmn-root';
        this.nav = el('nav', 'stmn-nav');
        this.nav.setAttribute('aria-label', '메시지 탐색');
        this.navButtons = new Map();
        for (const [kind, label, iconName] of BUTTONS) {
            const b = button(kind, label, iconName);
            b.title = label + ' · 드래그로 버튼 위치 이동';
            b.addEventListener('click', () => kind === 'outline' ? this.toggle() : this.callbacks.navigate(kind));
            this.navButtons.set(kind, b);
            this.nav.append(b);
        }
        this.panel = el('section', 'stmn-outline');
        this.panel.setAttribute('aria-label', '메시지 개요');
        this.panel.hidden = true;
        this.panel.tabIndex = -1;
        const header = el('header', 'stmn-outline-header');
        const heading = el('strong', 'stmn-heading', '메시지 개요');
        const close = button('close', '개요 닫기', 'x');
        close.classList.add('stmn-close');
        close.addEventListener('click', () => this.toggle(false));
        header.append(heading, close);
        this.caption = el('p', 'stmn-count', '');
        const searchbox = el('div', 'stmn-search');
        searchbox.append(icon('search'));
        this.search = el('input', 'stmn-search-input');
        this.search.type = 'search';
        this.search.placeholder = '제목·내용 검색 / #4 정확히 찾기';
        this.search.setAttribute('aria-label', '메시지 검색');
        this.search.addEventListener('input', () => {
            this.query = this.search.value.trim().toLocaleLowerCase();
            this.applyFilter();
        });
        searchbox.append(this.search);
        this.groupTools = el('div', 'stmn-group-actions');
        this.expandAllButton = el('button', 'stmn-group-action', '모두 펼치기');
        this.expandAllButton.type = 'button';
        this.expandAllButton.addEventListener('click', () => {
            this.groupCollapsed.clear();
            this.applyFilter({ resetScroll: true });
        });
        this.collapseAllButton = el('button', 'stmn-group-action', '모두 접기');
        this.collapseAllButton.type = 'button';
        this.collapseAllButton.addEventListener('click', () => {
            this.groupCollapsed = new Set(
                Array.from({ length: Math.ceil(this.entries.length / GROUP_SIZE) }, (_, i) => i * GROUP_SIZE),
            );
            this.applyFilter({ resetScroll: true });
        });
        this.groupTools.append(this.expandAllButton, this.collapseAllButton);
        this.list = el('div', 'stmn-list');
        this.list.setAttribute('role', 'list');
        this.spacer = el('div', 'stmn-list-spacer');
        this.list.append(this.spacer);
        this.list.addEventListener('scroll', () => this.scheduleRows(), { passive: true });
        this.outlineJumps = el('div', 'stmn-outline-jumps');
        this.outlineTop = el('button', 'stmn-outline-jump', '↑ 목차 맨 위');
        this.outlineBottom = el('button', 'stmn-outline-jump', '↓ 목차 맨 아래');
        for (const b of [this.outlineTop, this.outlineBottom]) b.type = 'button';
        this.outlineTop.addEventListener('click', () => this.scrollOutlineToStart());
        this.outlineBottom.addEventListener('click', () => this.scrollOutlineToEnd());
        this.outlineJumps.append(this.outlineTop, this.outlineBottom);
        this.footer = el('div', 'stmn-footer', '');
        this.footer.setAttribute('role', 'status');
        this.searchbox = searchbox;
        this.panelResize = el('div', 'stmn-panel-resize');
        this.panelResize.setAttribute('role', 'separator');
        this.panelResize.setAttribute('aria-label', '패널 크기 조절');
        this.panelResize.title = '드래그하여 패널 크기 변경';
        this.panel.append(header, this.caption, searchbox, this.groupTools, this.list, this.outlineJumps, this.footer, this.panelResize);
        this.elevator = new ElevatorPanel(this, callbacks);
        this.messageBatch = new MessageBatchUI(this);
        this.reorderUI = new MessageReorderUI(this);
        this.singleActions = new SingleMessageActions(this);
        this.root.append(this.nav, this.panel);
        this.exclusiveMenus = new ExclusiveQuietMenus(this.root);
        document.body.append(this.root);
        this.onKeydown = event => {
            if (event.key === 'Escape' && this.panelOpen && this.editing < 0) this.toggle(false);
        };
        document.addEventListener('keydown', this.onKeydown);
        this.boundResize = () => this.position();
        window.addEventListener('resize', this.boundResize, { passive: true });
        this.installDragging();
        this.installPanelResizing();
        this.position();
    }

    setNavigationButtonsVisible(visible) {
        // Only show the center/outline button when the setting is off.
        this.nav.classList.toggle('stmn-outline-only', !visible);
        this.position();
    }

    navDimensions() {
        const rect = this.nav.getBoundingClientRect();
        const compact = window.innerWidth <= 600;
        return { width: rect.width || (compact ? 34 : 38), height: rect.height || (compact ? 190 : 214) };
    }

    position(side = this.side || 'right') {
        this.side = side;
        const width = window.innerWidth;
        const height = window.innerHeight;
        const size = this.navDimensions();
        const saved = fromRelativeNavPosition(
            this.callbacks.getPosition?.(), width, height, size.width, size.height,
        );
        if (saved) {
            this.applyPosition(saved.left, saved.centerY);
            return;
        }
        const chatRect = document.getElementById('chat')?.getBoundingClientRect();
        let left = side === 'left'
            ? (chatRect?.left ?? 55) - size.width - 10
            : (chatRect?.right ?? width - 70) + 10;
        if (side === 'left' && left < 6) left = (chatRect?.left ?? 6) + 8;
        if (side === 'right' && left > width - size.width - 6) {
            left = (chatRect?.right ?? width) - size.width - 8;
        }
        this.applyPosition(left, height * (width <= 600 ? 0.52 : 0.5));
    }

    applyPosition(left, centerY) {
        const width = window.innerWidth;
        const size = this.navDimensions();
        const point = constrainNavPosition(left, centerY, width, window.innerHeight, size.width, size.height);
        this.root.style.setProperty('--stmn-nav-left', String(Math.round(point.left)) + 'px');
        this.root.style.setProperty('--stmn-nav-top', String(Math.round(point.centerY)) + 'px');

        const panelSize = this.previewPanelSize || fitPanelSize(
            this.callbacks.getPanelSize?.(), width, window.innerHeight,
        );
        this.root.style.setProperty('--stmn-panel-width', panelSize.width + 'px');
        this.root.style.setProperty('--stmn-panel-height', panelSize.height + 'px');
        const panelWidth = panelSize.width;
        let panelLeft = point.left + size.width + 12;
        if (panelLeft + panelWidth > width - 8) panelLeft = point.left - panelWidth - 12;
        if (panelLeft < 8) panelLeft = width > 650 ? width - panelWidth - 8 : 8;
        this.root.style.setProperty('--stmn-panel-left', String(Math.max(8, Math.round(panelLeft))) + 'px');
    }

    installDragging() {
        // Keep the original click behavior: moving fewer than 7px is a tap.
        // Do not capture the pointer until actual dragging begins.
        this.drag = null;
        this.suppressDragClick = false;
        this.onNavClickCapture = event => {
            if (!this.suppressDragClick) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            this.suppressDragClick = false;
        };
        this.onNavPointerDown = event => {
            if (event.button !== 0 || this.drag || !event.target.closest('.stmn-button')) return;
            if (this.clickGuardTimer !== undefined) clearTimeout(this.clickGuardTimer);
            this.suppressDragClick = false;
            const rect = this.nav.getBoundingClientRect();
            this.drag = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                left: rect.left,
                centerY: rect.top + rect.height / 2,
                active: false,
            };
        };
        this.onNavPointerMove = event => {
            const drag = this.drag;
            if (!drag || drag.pointerId !== event.pointerId) return;
            const dx = event.clientX - drag.startX;
            const dy = event.clientY - drag.startY;
            if (!drag.active && Math.hypot(dx, dy) < 7) return;
            if (!drag.active) {
                drag.active = true;
                this.nav.classList.add('stmn-dragging');
                this.nav.setPointerCapture?.(event.pointerId);
            }
            this.applyPosition(drag.left + dx, drag.centerY + dy);
            if (event.cancelable) event.preventDefault();
        };
        this.onNavPointerEnd = event => {
            const drag = this.drag;
            if (!drag || drag.pointerId !== event.pointerId) return;
            this.drag = null;
            this.nav.classList.remove('stmn-dragging');
            if (event.type === 'pointercancel') {
                if (drag.active) this.applyPosition(drag.left, drag.centerY);
                return;
            }
            if (!drag.active) return;
            this.suppressDragClick = true;
            this.clickGuardTimer = setTimeout(() => { this.suppressDragClick = false; }, 600);
            const rect = this.nav.getBoundingClientRect();
            const size = this.navDimensions();
            const saved = toRelativeNavPosition(
                rect.left, rect.top + rect.height / 2,
                window.innerWidth, window.innerHeight, size.width, size.height,
            );
            this.callbacks.savePosition?.(saved);
        };
        this.nav.addEventListener('click', this.onNavClickCapture, true);
        this.nav.addEventListener('pointerdown', this.onNavPointerDown);
        window.addEventListener('pointermove', this.onNavPointerMove);
        window.addEventListener('pointerup', this.onNavPointerEnd);
        window.addEventListener('pointercancel', this.onNavPointerEnd);
    }

    installPanelResizing() {
        this.resizeDrag = null;
        this.onPanelResizeDown = event => {
            if (event.button !== 0 || this.resizeDrag) return;
            const rect = this.panel.getBoundingClientRect();
            this.resizeDrag = {
                pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
                width: rect.width, height: rect.height, active: false,
            };
            this.panelResize.setPointerCapture?.(event.pointerId);
            event.preventDefault();
        };
        this.onPanelResizeMove = event => {
            const drag = this.resizeDrag;
            if (!drag || drag.pointerId !== event.pointerId) return;
            const dx = event.clientX - drag.startX;
            const dy = event.clientY - drag.startY;
            if (!drag.active && Math.hypot(dx, dy) < 3) return;
            drag.active = true;
            // Only CSS dimensions are updated while dragging; never rebuild
            // chat lists or persist settings for every pointermove.
            this.previewPanelSize = fitPanelSize({
                width: Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, Math.round(drag.width + dx))),
                height: Math.max(PANEL_MIN_HEIGHT, Math.min(PANEL_MAX_HEIGHT, Math.round(drag.height + dy))),
            }, window.innerWidth, window.innerHeight);
            this.position(this.side);
            if (event.cancelable) event.preventDefault();
        };
        this.onPanelResizeEnd = event => {
            const drag = this.resizeDrag;
            if (!drag || drag.pointerId !== event.pointerId) return;
            this.resizeDrag = null;
            const value = this.previewPanelSize;
            this.previewPanelSize = null;
            if (event.type !== 'pointercancel' && drag.active && value) {
                this.callbacks.savePanelSize?.(value);
            }
            this.position(this.side);
        };
        this.panelResize.addEventListener('pointerdown', this.onPanelResizeDown);
        window.addEventListener('pointermove', this.onPanelResizeMove);
        window.addEventListener('pointerup', this.onPanelResizeEnd);
        window.addEventListener('pointercancel', this.onPanelResizeEnd);
    }

    scrollOutlineToStart() {
        if (this.elevator?.tab === 'buildings') return;
        this.list.scrollTop = 0;
        this.renderRows(true);
    }

    scrollOutlineToEnd({ expandLast = true } = {}) {
        if (this.elevator?.tab === 'buildings') return;
        if (expandLast && !this.query && this.entries.length) {
            const lastStart = Math.floor((this.entries.length - 1) / GROUP_SIZE) * GROUP_SIZE;
            if (this.groupCollapsed.delete(lastStart)) this.applyFilter({ resetScroll: false });
        }
        this.list.scrollTop = Math.max(0, this.list.scrollHeight - this.list.clientHeight);
        this.renderRows(true);
    }

    setActive(index, busy = false) {
        this.currentIndex = index;
        this.navButtons.get('outline')?.setAttribute('aria-expanded', String(this.panelOpen));
        this.elevator?.updateFloor(index);
        const hasChat = this.callbacks.hasChat();
        for (const [kind, b] of this.navButtons.entries()) {
            if (kind !== 'outline') b.disabled = !hasChat || busy || !this.callbacks.canNavigate(kind, index);
            else b.disabled = !hasChat;
        }
        for (const row of this.spacer.querySelectorAll('.stmn-row')) {
            row.classList.toggle('stmn-current', Number(row.dataset.index) === index);
        }
    }

    toggle(force) {
        this.panelOpen = typeof force === 'boolean' ? force : !this.panelOpen;
        this.panel.hidden = !this.panelOpen;
        this.navButtons.get('outline')?.classList.toggle('stmn-button-selected', this.panelOpen);
        this.navButtons.get('outline')?.setAttribute('aria-expanded', String(this.panelOpen));
        if (this.panelOpen) {
            this.rebuild();
            this.elevator?.onShow();
            this.panel.focus({ preventScroll: true });
            this.position(this.side);
            if (this.elevator?.tab === 'floors') this.scrollOutlineToEnd();
        }
    }

    setStatus(text = '', error = false) {
        this.footer.textContent = text;
        this.footer.classList.toggle('stmn-error', error);
    }

    rebuild({ keepScroll = false } = {}) {
        if (!this.panelOpen) return;
        const oldScroll = this.list.scrollTop;
        const context = this.callbacks.context();
        if (this.previewChat !== context.chat) {
            this.expandedPreviewIndex = null;
            this.previewSwipeIndex = null;
            this.previewChat = context.chat;
            this.hideQuietTooltip();
        }
        const storedTitles = context.chatMetadata?.[DATA_KEY]?.titles;
        this.entries = (context.chat || []).map((message, index) => {
            const rawText = message?.mes;
            const name = message?.name;
            const image = message?.extra?.image;
            const file = message?.extra?.file;
            const messageId = message?.[MESSAGE_KEY];
            const titleOverride = typeof messageId === 'string' ? storedTitles?.[messageId] : undefined;
            // A single edited message invalidates only its own title/search
            // string. WeakMap entries do not keep old chats alive.
            let cached = message && typeof message === 'object'
                ? this.outlineEntryCache.get(message) : null;
            if (!cached || cached.rawText !== rawText || cached.name !== name ||
                cached.messageId !== messageId || cached.titleOverride !== titleOverride ||
                cached.image !== image || cached.file !== file) {
                const title = getTitle(message, context.chatMetadata);
                cached = {
                    rawText, name, messageId, titleOverride, image, file, title,
                    custom: isCustomTitle(message, context.chatMetadata),
                    searchable: `${name || ''} ${title} ${String(rawText || '').slice(0, 1500)}`.toLocaleLowerCase(),
                };
                if (message && typeof message === 'object') this.outlineEntryCache.set(message, cached);
            }
            return { message, index, title: cached.title, custom: cached.custom, searchable: cached.searchable };
        });
        this.applyFilter({ resetScroll: !keepScroll });
        if (keepScroll) {
            this.list.scrollTop = oldScroll;
            this.renderRows(true);
        }
    }

    applyFilter({ resetScroll = true } = {}) {
        this.filtered = filterOutlineEntries(this.entries, this.query);
        const layout = buildOutlineRows(
            this.filtered, this.entries.length, this.groupCollapsed, Boolean(this.query),
        );
        const extra = this.root.dataset.elevatorTheme === 'quiet'
            ? withQuietPreview(layout.rows, this.expandedPreviewIndex)
            : {rows:layout.rows,totalHeight:0};
        this.displayRows = extra.rows;
        this.caption.textContent = '총 ' + this.entries.length.toLocaleString() + '개 메시지' +
            (this.query ? ' · 검색 결과 ' + this.filtered.length.toLocaleString() + '개' : '');
        this.spacer.style.height = String(layout.totalHeight + extra.totalHeight) + 'px';
        this.groupTools.hidden = this.elevator?.tab === 'buildings' || Boolean(this.query) || this.entries.length === 0;
        this.expandAllButton.disabled = this.groupCollapsed.size === 0;
        this.collapseAllButton.disabled = this.groupCollapsed.size >= Math.ceil(this.entries.length / GROUP_SIZE);
        if (resetScroll) this.list.scrollTop = 0;
        this.lastRange = '';
        this.renderRows(true);
    }

    scheduleRows() {
        if (this.raf !== null) return;
        this.raf = requestAnimationFrame(() => { this.raf = null; this.renderRows(); });
    }

    renderRows(force = false) {
        if (!this.panelOpen) return;
        const rows = this.displayRows;
        const start = Math.max(0, findOutlineRow(rows, this.list.scrollTop) - OVERSCAN);
        const limit = this.list.scrollTop + (this.list.clientHeight || 400) + OVERSCAN * MESSAGE_ROW_HEIGHT;
        let end = Math.min(rows.length, start + 1);
        while (end < rows.length && rows[end].top < limit) end++;
        const range = start + ':' + end + ':' + this.editing + ':' + this.expandedPreviewIndex + ':' + this.previewSwipeIndex;
        if (!force && this.lastRange === range) return;
        this.lastRange = range;
        const previousReading = this.spacer.querySelector('.stmn-quiet-preview-reading')?.scrollTop || 0;
        const previousSwipe = this.spacer.querySelector('.stmn-quiet-swipe-text')?.scrollTop || 0;
        this.spacer.replaceChildren();
        const context = this.callbacks.context();
        const fragment = document.createDocumentFragment();
        for (let i = start; i < end; i++) {
            const item = rows[i];
            if (item.kind === 'preview') {
                const preview = this.renderQuietPreview(item.entry);
                preview.style.top = String(item.top) + 'px';
                fragment.append(preview);
                continue;
            }
            if (item.kind === 'group') {
                const group = el('div', 'stmn-group');
                group.style.top = String(item.top) + 'px';
                group.setAttribute('role', 'listitem');
                const toggle = el('button', 'stmn-group-toggle');
                toggle.type = 'button';
                toggle.textContent = (item.collapsed ? '▸ ' : '▾ ') + '#' + item.start + '–#' + item.end;
                toggle.setAttribute('aria-expanded', String(!item.collapsed));
                toggle.setAttribute('aria-label', '#' + item.start + '부터 #' + item.end + '까지 ' + (item.collapsed ? '펼치기' : '접기'));
                toggle.addEventListener('click', () => {
                    if (this.groupCollapsed.has(item.start)) this.groupCollapsed.delete(item.start);
                    else this.groupCollapsed.add(item.start);
                    this.applyFilter({ resetScroll: false });
                });
                group.append(toggle, el('span', 'stmn-group-count', String(item.count) + '개'));
                fragment.append(group);
                continue;
            }
            const entry = item.entry;
            const row = el('div', 'stmn-row');
            row.dataset.index = String(entry.index);
            row.style.top = String(item.top) + 'px';
            row.setAttribute('role', 'listitem');
            if (entry.message?.is_system === true) row.classList.add('stmn-hidden-message');
            if (this.currentIndex === entry.index) row.classList.add('stmn-current');
            const number = el('span', 'stmn-number', '#' + entry.index);
            if (this.messageBatch?.selectionMode && this.root.dataset.elevatorTheme === 'quiet' &&
                this.elevator.tab === 'floors') {
                row.append(this.messageBatch.checkboxFor(entry.index,entry.message));
                row.classList.toggle('stmn-message-batch-selected',this.messageBatch.selected.has(entry.index));
            }
            row.append(number, avatarElement(context, entry.message));
            const middle = el('div', 'stmn-row-body');
            if (this.editing === entry.index) {
                const input = el('input', 'stmn-edit-input');
                input.type = 'text';
                input.value = this.editValue;
                input.maxLength = 300;
                input.setAttribute('aria-label', '#' + entry.index + ' 메시지 제목 수정');
                input.addEventListener('input', () => { this.editValue = input.value; });
                input.addEventListener('keydown', event => {
                    event.stopPropagation();
                    if (event.key === 'Enter') { event.preventDefault(); void this.commitEdit(entry.index); }
                    if (event.key === 'Escape') { event.preventDefault(); this.cancelEdit(); }
                });
                middle.append(input);
                const help = el('span', 'stmn-edit-help', 'Enter 저장 · Esc 취소 · 빈 제목으로 저장하면 자동 복원');
                middle.append(help);
                queueMicrotask(() => {
                    if (this.editing === entry.index && input.isConnected) { input.focus(); input.select(); }
                });
            } else {
                const title = el('button', 'stmn-title', entry.title);
                title.type = 'button';
                title.title = entry.title;
                title.addEventListener('click', () => this.callbacks.goToIndex(entry.index));
                middle.append(title);
                const detail = el(
                    'span', 'stmn-row-detail',
                    String(entry.message?.name || (entry.message?.is_user ? 'User' : 'Character')) +
                    (entry.custom ? ' · 사용자 지정 제목' : '') + (entry.message?.is_system ? ' · 숨김' : ''),
                );
                middle.append(detail);
            }
            row.append(middle);
            if (this.editing === entry.index) {
                const ok = button('save', '제목 저장', 'check');
                ok.classList.add('stmn-row-action');
                ok.addEventListener('click', () => void this.commitEdit(entry.index));
                const cancel = button('cancel', '취소', 'x');
                cancel.classList.add('stmn-row-action');
                cancel.addEventListener('click', () => this.cancelEdit());
                row.append(ok, cancel);
            } else {
                const editTitle = () => {
                    this.editing = entry.index;
                    this.editValue = entry.custom ? entry.title : automaticTitle(entry.message);
                    this.renderRows(true);
                };
                const bookmark = button('bookmark', '#' + entry.index + ' 북마크', 'star');
                bookmark.classList.add('stmn-quiet-message-action','stmn-quiet-bookmark');
                const marked = Boolean(this.callbacks.isBookmarked?.(entry.index));
                bookmark.classList.toggle('stmn-quiet-bookmarked',marked);
                bookmark.setAttribute('aria-pressed',String(marked));
                bookmark.title = marked ? '북마크 해제' : '북마크 추가';
                bookmark.addEventListener('click', () => void this.callbacks.toggleBookmark?.(entry.index));
                row.append(bookmark);
                const edit = button('edit', '#' + entry.index + ' 제목 수정', 'pencil');
                edit.classList.add('stmn-row-action');
                edit.addEventListener('click', editTitle);
                row.append(edit);
                const peek = button('peek', '#' + entry.index + ' 내용 미리보기', 'eye');
                peek.classList.add('stmn-quiet-message-action');
                this.bindQuietTooltip(peek,entry);
                peek.addEventListener('click', () => this.showQuietMessagePreview(entry));
                row.append(peek);
                const menu = el('details','stmn-quiet-message-menu');
                const summary = el('summary','');
                summary.append(icon('more'));
                summary.title = '#' + entry.index + ' 메시지 메뉴';
                summary.setAttribute('aria-label',summary.title);
                const actions = el('div','stmn-quiet-message-menu-body');
                const jump = el('button','stmn-quiet-menu-item','이 메시지로 이동');
                jump.type = 'button';
                jump.addEventListener('click', () => { menu.open = false; this.callbacks.goToIndex(entry.index); });
                const rename = el('button','stmn-quiet-menu-item','제목 수정');
                rename.type = 'button';
                rename.addEventListener('click', () => { menu.open = false; editTitle(); });
                const info = el('button','stmn-quiet-menu-item','내용 미리보기');
                info.type = 'button';
                info.addEventListener('click', () => { menu.open = false; this.showQuietMessagePreview(entry); });
                const hidden=el('button','stmn-quiet-menu-item',
                    entry.message?.is_system===true?'메시지 숨김 해제':'메시지 숨기기');
                hidden.type='button';
                hidden.addEventListener('click',()=>{
                    menu.open=false;
                    void this.singleActions.toggleHidden(entry.index,entry.message);
                });
                const remove=el('button','stmn-quiet-menu-item stmn-quiet-menu-danger','메시지 삭제');
                remove.type='button';
                remove.addEventListener('click',()=>{
                    menu.open=false;
                    this.singleActions.openDelete(entry.index,entry.message);
                });
                actions.append(jump,rename,info,hidden,remove);
                menu.append(summary,actions);
                row.append(menu);
            }
            fragment.append(row);
        }
        this.spacer.append(fragment);
        const reading = this.spacer.querySelector('.stmn-quiet-preview-reading');
        const swipe = this.spacer.querySelector('.stmn-quiet-swipe-text');
        if (reading) reading.scrollTop = previousReading;
        if (swipe) swipe.scrollTop = previousSwipe;
    }

    /** Eye hover/focus shows only the 680-character excerpt.
     * The tooltip is attached below that eye, never to an entire row. */
    bindQuietTooltip(eye, entry) {
        eye.addEventListener('mouseenter', () => {
            this.hideQuietTooltip();
            this.tooltipTimer = setTimeout(() => {
                if (!eye.isConnected || this.root.dataset.elevatorTheme !== 'quiet') return;
                this.showQuietTooltip(eye, entry);
            }, 240);
        });
        eye.addEventListener('mouseleave', () => this.hideQuietTooltip());
        eye.addEventListener('focus', () => this.showQuietTooltip(eye, entry));
        eye.addEventListener('blur', () => this.hideQuietTooltip());
    }

    showQuietTooltip(eye, entry) {
        if (!eye.isConnected || this.root.dataset.elevatorTheme !== 'quiet') return;
        this.hideQuietTooltip();
        const target = this.callbacks.context().chat?.[entry.index] || entry.message;
        if (!this.tooltip) {
            this.tooltip = el('aside', 'stmn-quiet-tooltip');
            this.tooltip.setAttribute('role','tooltip');
            document.body.append(this.tooltip);
            this.onQuietTooltipScroll = () => this.hideQuietTooltip();
            this.list.addEventListener('scroll', this.onQuietTooltipScroll,{passive:true});
        }
        const text = messageTooltipText(target);
        const header = entry.index === this.entries.length - 1
            ? '마지막 메시지' : '#' + entry.index + ' · 메시지 미리보기';
        this.tooltip.replaceChildren(el('strong','',header),
            el('div','stmn-quiet-tooltip-text',text || '(내용 없는 메시지)'));
        this.tooltip.hidden = false;
        const rect = eye.getBoundingClientRect();
        const width = this.tooltip.offsetWidth;
        const left = Math.max(8,Math.min(rect.left,window.innerWidth-width-8));
        this.tooltip.style.left = left+'px';
        this.tooltip.style.top = Math.max(8,rect.bottom+8)+'px';
        this.tooltip.style.maxHeight = Math.max(65,window.innerHeight-rect.bottom-18)+'px';
    }

    hideQuietTooltip() {
        if (this.tooltipTimer) clearTimeout(this.tooltipTimer);
        this.tooltipTimer = null;
        if (this.tooltip) this.tooltip.hidden = true;
    }

    /** v5: eye CLICK expands a full, inline preview row in the virtual list.
     * Other-chat previews remain a separate Q-04 feature. */
    showQuietMessagePreview(entry) {
        this.hideQuietTooltip();
        if (this.root.dataset.elevatorTheme !== 'quiet') return;
        if (this.expandedPreviewIndex === entry.index) {
            this.expandedPreviewIndex = null;
            this.previewSwipeIndex = null;
        } else {
            this.expandedPreviewIndex = entry.index;
            const message = this.callbacks.context().chat?.[entry.index] || entry.message;
            this.previewSwipeIndex = previewSwipes(message).selected;
        }
        this.applyFilter({resetScroll:false});
        if (this.expandedPreviewIndex != null) {
            const preview = this.displayRows.find(row =>
                row.kind === 'preview' && row.entry.index === entry.index);
            if (preview) {
                const bottom = this.list.scrollTop + this.list.clientHeight;
                if (preview.top + 75 > bottom) this.list.scrollTop = Math.max(0,preview.top-100);
                this.renderRows(true);
            }
        }
    }

    renderQuietPreview(entry) {
        const ctx = this.callbacks.context();
        const message = ctx.chat?.[entry.index] || entry.message;
        const { texts, selected } = previewSwipes(message);
        const idx = Math.max(0,Math.min(this.previewSwipeIndex ?? selected,texts.length-1));
        const pane = el('section','stmn-quiet-message-preview');
        pane.style.height = QUIET_DETAIL_HEIGHT+'px';
        pane.setAttribute('role','region');
        pane.setAttribute('aria-label','#'+entry.index+' 메시지 상세 미리보기');
        const top = el('div','stmn-quiet-message-preview-top');
        top.append(el('strong','', '#'+entry.index+' · '+entry.title));
        const close = el('button','stmn-quiet-preview-close','×');
        close.type='button';close.setAttribute('aria-label','미리보기 닫기');
        close.addEventListener('click',()=>this.showQuietMessagePreview(entry));
        top.append(close);
        pane.append(top);
        pane.append(el('div','stmn-quiet-preview-label','메시지 전체 내용'));
        const reading = el('div','stmn-quiet-preview-reading',
            String(message?.mes ?? '') || '(내용 없는 메시지)');
        reading.tabIndex=0;
        pane.append(reading);
        const divider = el('div','stmn-quiet-preview-divider');
        pane.append(divider);
        const bar = el('div','stmn-quiet-swipebar');
        const label = el('span','',texts.length+'개 스와이프 · '+(idx+1)+' / '+texts.length);
        const controls=el('div','stmn-quiet-swipebuttons');
        const navButton = (text,desc,direction) => {
            const b=el('button','',text);b.type='button';
            b.setAttribute('aria-label',desc);
            b.disabled = texts.length<=1 || this.previewBusy;
            b.addEventListener('click',()=> {
                this.previewSwipeIndex = (idx+direction+texts.length)%texts.length;
                this.renderRows(true);
            });
            return b;
        };
        controls.append(navButton('‹','이전 스와이프',-1));
        const indicator=el('span','stmn-quiet-swipe-active',
            idx===selected?'현재 적용됨':'미리보기 중');
        controls.append(indicator,navButton('›','다음 스와이프',1));
        bar.append(label,controls);
        pane.append(bar);
        const swipeText=el('div','stmn-quiet-swipe-text',texts[idx] || '(내용 없는 답변)');
        swipeText.tabIndex=0;
        pane.append(swipeText);
        const bottom=el('div','stmn-quiet-preview-actions');
        const go=el('button','stmn-quiet-preview-go','이 층으로 이동');
        go.type='button';
        go.addEventListener('click',()=>this.callbacks.goToIndex(entry.index));
        bottom.append(go);
        if (texts.length>1) {
            const apply=el('button','stmn-quiet-preview-apply',
                idx===selected?'현재 적용된 스와이프':'이 스와이프 적용');
            apply.type='button';
            apply.disabled=idx===selected || !this.callbacks.selectSwipe || this.previewBusy;
            apply.addEventListener('click',async()=>{
                if (this.previewBusy) return;
                this.previewBusy=true;
                apply.disabled=true;
                try {
                    const ok=await this.callbacks.selectSwipe(entry.index,idx);
                    if (ok) {
                        this.previewSwipeIndex=idx;
                        this.rebuild({keepScroll:true});
                        this.setStatus('스와이프 '+(idx+1)+'번을 적용했습니다.');
                    } else {
                        this.setStatus('스와이프 변경을 확인할 수 없습니다.',true);
                    }
                } catch(error) {
                    this.setStatus(error?.message || '스와이프 변경에 실패했습니다.',true);
                } finally {
                    this.previewBusy=false;
                    this.renderRows(true);
                }
            });
            bottom.append(apply);
        }
        pane.append(bottom);
        return pane;
    }

    async commitEdit(index) {
        if (this.editing !== index || this.isSaving) return;
        this.isSaving = true;
        this.setStatus('제목 저장 중…');
        try {
            await this.callbacks.saveTitle(index, this.editValue);
            this.editing = -1;
            this.rebuild({ keepScroll: true });
            this.setStatus('저장했습니다.');
        } catch (error) {
            this.setStatus(error?.message || '제목을 저장하지 못했습니다.', true);
        } finally {
            this.isSaving = false;
        }
    }

    cancelEdit() {
        this.editing = -1;
        this.renderRows(true);
        this.setStatus('');
    }

    destroy() {
        if (this.raf !== null) cancelAnimationFrame(this.raf);
        this.hideQuietTooltip();
        if (this.onQuietTooltipScroll) this.list.removeEventListener('scroll',this.onQuietTooltipScroll);
        this.tooltip?.remove();
        this.panelResize.removeEventListener('pointerdown', this.onPanelResizeDown);
        window.removeEventListener('pointermove', this.onPanelResizeMove);
        window.removeEventListener('pointerup', this.onPanelResizeEnd);
        window.removeEventListener('pointercancel', this.onPanelResizeEnd);
        if (this.clickGuardTimer !== undefined) clearTimeout(this.clickGuardTimer);
        document.removeEventListener('keydown', this.onKeydown);
        window.removeEventListener('resize', this.boundResize);
        this.nav.removeEventListener('click', this.onNavClickCapture, true);
        this.nav.removeEventListener('pointerdown', this.onNavPointerDown);
        window.removeEventListener('pointermove', this.onNavPointerMove);
        window.removeEventListener('pointerup', this.onNavPointerEnd);
        window.removeEventListener('pointercancel', this.onNavPointerEnd);
        this.exclusiveMenus?.destroy();
        this.singleActions?.destroy();
        this.reorderUI?.destroy();
        this.messageBatch?.destroy();
        this.elevator?.destroy();
        this.root.remove();
    }
}

export function installSettings(context, settings, onChange, diagnostics, backupCallbacks, libraryCallbacks) {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || document.getElementById('stmn-settings')) return;
    const container = el('div', 'stmn-settings');
    container.id = 'stmn-settings';
    const heading = el('details');
    const summary = el('summary', '', '엘리베이터 · 채팅과 메시지 탐색');
    heading.append(summary);
    const inner = el('div', 'stmn-settings-inner');
    installExtensionUpdateUI(inner, () => window.SillyTavern?.getContext?.() || context);
    const themeLabel = el('label', '', '엘리베이터 외형');
    themeLabel.htmlFor = 'stmn-elevator-theme';
    const themeSelect = el('select');
    themeSelect.id = 'stmn-elevator-theme';
    for (const [value, label] of [['classic', '클래식 · 금속 엘리베이터'],
        ['restricted', '금지된 층 · 낡은 엘리베이터'], ['sky', '스카이 리프트 · 투명 엘리베이터'],
        ['quiet', 'Quiet · 미니멀 화이트 (실험)']]) {
        const option = el('option', '', label);
        option.value = value;
        themeSelect.append(option);
    }
    themeSelect.value = settings.elevatorTheme || 'classic';
    themeSelect.addEventListener('change', () => onChange('elevatorTheme', themeSelect.value));

    const skyLabel = el('label', '', '스카이 리프트 배경');
    skyLabel.htmlFor = 'stmn-elevator-sky';
    const skySelect = el('select');
    skySelect.id = 'stmn-elevator-sky';
    for (const [value, label] of [['auto', '자동 · 시스템 밝기'], ['day', '낮 · 구름'],
        ['night', '밤 · 별빛']]) {
        const option = el('option', '', label);
        option.value = value;
        skySelect.append(option);
    }
    skySelect.value = settings.elevatorSky || 'auto';
    skySelect.addEventListener('change', () => onChange('elevatorSky', skySelect.value));
    const buttonToggleLabel = el('label', 'stmn-setting-switch');
    buttonToggleLabel.htmlFor = 'stmn-show-navigation';
    const buttonToggle = el('input');
    buttonToggle.id = 'stmn-show-navigation';
    buttonToggle.type = 'checkbox';
    buttonToggle.setAttribute('role', 'switch');
    buttonToggle.checked = settings.showNavigationButtons !== false;
    buttonToggle.addEventListener('change', () => onChange('showNavigationButtons', buttonToggle.checked));
    buttonToggleLabel.append(buttonToggle, document.createTextNode(' 메시지 이동 버튼 표시'));
    const buttonToggleHint = el('small', 'stmn-setting-switch-hint', '끄면 메시지 개요 열기/닫기 버튼만 표시됩니다.');

    const modeLabel = el('label', '', '메시지 이동 범위');
    modeLabel.htmlFor = 'stmn-mode';
    const mode = el('select');
    mode.id = 'stmn-mode';
    for (const [value, label] of [['visible', '숨김 메시지 제외'], ['all', '모든 메시지 포함']]) {
        const option = el('option', '', label);
        option.value = value;
        mode.append(option);
    }
    mode.value = settings.mode;
    mode.addEventListener('change', () => onChange('mode', mode.value));
    const sideLabel = el('label', '', '버튼 위치');
    sideLabel.htmlFor = 'stmn-side';
    const side = el('select');
    side.id = 'stmn-side';
    for (const [value, label] of [['right', '채팅창 오른쪽'], ['left', '채팅창 왼쪽']]) {
        const option = el('option', '', label);
        option.value = value;
        side.append(option);
    }
    side.value = settings.side;
    side.addEventListener('change', () => onChange('side', side.value));
    inner.append(themeLabel, themeSelect, skyLabel, skySelect, buttonToggleLabel, buttonToggleHint, modeLabel, mode, sideLabel, side, el('p', 'stmn-settings-hint', '버튼을 드래그하면 다섯 버튼을 함께 옮기고 자동 저장합니다. 좌/우 위치를 다시 선택하면 기본 배치로 복원합니다. 중앙 버튼은 목차, 연필은 제목 수정입니다. 제목은 브랜치 생성 시 복제됩니다.'));
    installDiagnosticsSettings(inner, settings, onChange, diagnostics);
    installSettingsBackupUI(inner, backupCallbacks || {});
    installLibraryBackupUI(inner, libraryCallbacks || {});
    heading.append(inner);
    container.append(heading);
    host.append(container);
    return () => {
        themeSelect.value = settings.elevatorTheme;
        skySelect.value = settings.elevatorSky;
        buttonToggle.checked = settings.showNavigationButtons;
        mode.value = settings.mode;
        side.value = settings.side;
        const diagnosticToggle = container.querySelector('#stmn-diagnostics-enabled');
        if (diagnosticToggle) diagnosticToggle.checked = settings.diagnosticsEnabled;
    };
}
