import { automaticTitle, getTitle, isCustomTitle } from './model.js';

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

const ROW_HEIGHT = 68;
const OVERSCAN = 6;

export class NavigatorView {
    constructor(callbacks) {
        this.callbacks = callbacks;
        this.panelOpen = false;
        this.entries = [];
        this.filtered = [];
        this.query = '';
        this.editing = -1;
        this.editValue = '';
        this.raf = null;
        this.lastRange = '';
        this.root = el('div', 'stmn-root');
        this.root.id = 'stmn-root';
        this.nav = el('nav', 'stmn-nav');
        this.nav.setAttribute('aria-label', '메시지 탐색');
        this.navButtons = new Map();
        for (const [kind, label, iconName] of BUTTONS) {
            const b = button(kind, label, iconName);
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
        this.search.placeholder = '제목 또는 메시지 검색';
        this.search.setAttribute('aria-label', '메시지 검색');
        this.search.addEventListener('input', () => {
            this.query = this.search.value.trim().toLocaleLowerCase();
            this.applyFilter();
        });
        searchbox.append(this.search);
        this.list = el('div', 'stmn-list');
        this.list.setAttribute('role', 'list');
        this.spacer = el('div', 'stmn-list-spacer');
        this.list.append(this.spacer);
        this.list.addEventListener('scroll', () => this.scheduleRows(), { passive: true });
        this.footer = el('div', 'stmn-footer', '');
        this.footer.setAttribute('role', 'status');
        this.panel.append(header, this.caption, searchbox, this.list, this.footer);
        this.root.append(this.nav, this.panel);
        document.body.append(this.root);
        this.onKeydown = event => {
            if (event.key === 'Escape' && this.panelOpen && this.editing < 0) this.toggle(false);
        };
        document.addEventListener('keydown', this.onKeydown);
        this.boundResize = () => this.position();
        window.addEventListener('resize', this.boundResize, { passive: true });
        this.position();
    }

    position(side = 'right') {
        this.side = side;
        const chat = document.getElementById('chat');
        const chatRect = chat?.getBoundingClientRect();
        const width = window.innerWidth;
        const buttonSize = 42;
        // Prefer just outside #chat; clamp within the viewport.
        let left = side === 'left' ? (chatRect?.left ?? 55) - buttonSize - 10 : (chatRect?.right ?? width - 70) + 10;
        if (side === 'left' && left < 6) left = (chatRect?.left ?? 6) + 8;
        if (side === 'right' && left > width - buttonSize - 6) left = (chatRect?.right ?? width) - buttonSize - 8;
        left = Math.max(6, Math.min(left, width - buttonSize - 6));
        this.root.style.setProperty('--stmn-nav-left', `${Math.round(left)}px`);
        const panelWidth = Math.min(330, width - 24);
        let panelLeft = left + buttonSize + 12;
        if (panelLeft + panelWidth > width - 8) panelLeft = left - panelWidth - 12;
        if (panelLeft < 8) panelLeft = width > 650 ? width - panelWidth - 8 : 8;
        this.root.style.setProperty('--stmn-panel-left', `${Math.max(8, Math.round(panelLeft))}px`);
    }

    setActive(index, busy = false) {
        this.currentIndex = index;
        this.navButtons.get('outline')?.setAttribute('aria-expanded', String(this.panelOpen));
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
            this.panel.focus({ preventScroll: true });
            this.position(this.side);
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
        this.entries = (context.chat || []).map((message, index) => ({
            message, index,
            title: getTitle(message, context.chatMetadata),
            custom: isCustomTitle(message, context.chatMetadata),
            searchable: `${message?.name || ''} ${getTitle(message, context.chatMetadata)} ${String(message?.mes || '').slice(0, 1500)}`.toLocaleLowerCase(),
        }));
        this.applyFilter({ resetScroll: !keepScroll });
        if (keepScroll) this.list.scrollTop = oldScroll;
    }

    applyFilter({ resetScroll = true } = {}) {
        this.filtered = this.query ? this.entries.filter(row => row.searchable.includes(this.query) || String(row.index + 1).includes(this.query)) : this.entries;
        this.caption.textContent = `총 ${this.entries.length.toLocaleString()}개 메시지${this.query ? ` · 검색 결과 ${this.filtered.length.toLocaleString()}개` : ''}`;
        this.spacer.style.height = `${this.filtered.length * ROW_HEIGHT}px`;
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
        const start = Math.max(0, Math.floor(this.list.scrollTop / ROW_HEIGHT) - OVERSCAN);
        const count = Math.ceil((this.list.clientHeight || 400) / ROW_HEIGHT) + OVERSCAN * 2;
        const end = Math.min(this.filtered.length, start + count);
        const range = `${start}:${end}:${this.editing}`;
        if (!force && this.lastRange === range) return;
        this.lastRange = range;
        this.spacer.replaceChildren();
        const context = this.callbacks.context();
        const fragment = document.createDocumentFragment();
        for (let i = start; i < end; i++) {
            const entry = this.filtered[i];
            const row = el('div', 'stmn-row');
            row.dataset.index = String(entry.index);
            row.style.top = `${i * ROW_HEIGHT}px`;
            row.setAttribute('role', 'listitem');
            if (entry.message?.is_system === true) row.classList.add('stmn-hidden-message');
            if (this.currentIndex === entry.index) row.classList.add('stmn-current');
            const number = el('span', 'stmn-number', `#${entry.index + 1}`);
            row.append(number, avatarElement(context, entry.message));
            const middle = el('div', 'stmn-row-body');
            if (this.editing === entry.index) {
                const input = el('input', 'stmn-edit-input');
                input.type = 'text';
                input.value = this.editValue;
                input.maxLength = 300;
                input.setAttribute('aria-label', `${entry.index + 1}번 메시지 제목 수정`);
                input.addEventListener('input', () => { this.editValue = input.value; });
                input.addEventListener('keydown', event => {
                    event.stopPropagation();
                    if (event.key === 'Enter') { event.preventDefault(); void this.commitEdit(entry.index); }
                    if (event.key === 'Escape') { event.preventDefault(); this.cancelEdit(); }
                });
                middle.append(input);
                const help = el('span', 'stmn-edit-help', 'Enter 저장 · Esc 취소 · 빈 제목으로 저장하면 자동 복원');
                middle.append(help);
                queueMicrotask(() => { if (this.editing === entry.index && input.isConnected) { input.focus(); input.select(); } });
            } else {
                const title = el('button', 'stmn-title', entry.title);
                title.type = 'button';
                title.title = entry.title;
                title.addEventListener('click', () => this.callbacks.goToIndex(entry.index));
                middle.append(title);
                const detail = el('span', 'stmn-row-detail', String(entry.message?.name || (entry.message?.is_user ? 'User' : 'Character')) + (entry.custom ? ' · 사용자 지정 제목' : '') + (entry.message?.is_system ? ' · 숨김' : ''));
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
                const edit = button('edit', `#${entry.index + 1} 제목 수정`, 'pencil');
                edit.classList.add('stmn-row-action');
                edit.addEventListener('click', () => {
                    this.editing = entry.index;
                    this.editValue = entry.custom ? entry.title : automaticTitle(entry.message);
                    this.renderRows(true);
                });
                row.append(edit);
            }
            fragment.append(row);
        }
        this.spacer.append(fragment);
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
        document.removeEventListener('keydown', this.onKeydown);
        window.removeEventListener('resize', this.boundResize);
        this.root.remove();
    }
}

export function installSettings(context, settings, onChange) {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || document.getElementById('stmn-settings')) return;
    const container = el('div', 'stmn-settings');
    container.id = 'stmn-settings';
    const heading = el('details');
    const summary = el('summary', '', 'Message Navigator & Outline (메시지 탐색)');
    heading.append(summary);
    const inner = el('div', 'stmn-settings-inner');
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
    inner.append(modeLabel, mode, sideLabel, side, el('p', 'stmn-settings-hint', '중앙 목록 버튼으로 목차를 열고, 연필 아이콘으로 제목을 수정합니다. 제목은 해당 채팅에 저장되어 브랜치 생성 시 복제됩니다.'));
    heading.append(inner);
    container.append(heading);
    host.append(container);
}
