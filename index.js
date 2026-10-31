import { SETTINGS_KEY, assignCustomTitle, findTarget } from './model.js';
import { ensureMessageRendered, getChatElement, NavigationCursor, getRenderedMessage, scrollToMessage } from './scroll.js';
import { installSettings, NavigatorView } from './ui.js';
import { validNavPosition } from './position.js';
import { listAvailableBuildings, enterBuilding } from './buildings.js';

const PREFIX = '[ST Message Navigator]';
const DEFAULT_SETTINGS = Object.freeze({ mode: 'visible', side: 'right', position: null, showNavigationButtons: true, elevatorTheme: 'classic', elevatorSky: 'auto' });
let app;

function context() { return SillyTavern.getContext(); }
function getSettings() {
    const ctx = context();
    if (!ctx.extensionSettings || typeof ctx.extensionSettings !== 'object') {
        throw new Error('실리태번 확장 설정을 사용할 수 없습니다.');
    }
    const root = ctx.extensionSettings;
    if (!root[SETTINGS_KEY] || typeof root[SETTINGS_KEY] !== 'object') {
        root[SETTINGS_KEY] = { ...DEFAULT_SETTINGS };
    }
    const settings = root[SETTINGS_KEY];
    if (!['visible', 'all'].includes(settings.mode)) settings.mode = 'visible';
    if (!['left', 'right'].includes(settings.side)) settings.side = 'right';
    if (!validNavPosition(settings.position)) settings.position = null;
    if (typeof settings.showNavigationButtons !== 'boolean') settings.showNavigationButtons = true;
    if (!['classic', 'restricted', 'sky'].includes(settings.elevatorTheme)) settings.elevatorTheme = 'classic';
    if (!['auto', 'day', 'night'].includes(settings.elevatorSky)) settings.elevatorSky = 'auto';
    return settings;
}

class NavigatorApp {
    constructor() {
        this.settings = getSettings();
        this.navSerial = 0;
        this.busy = false;
        this.lastNavigated = -1;
        this.cursor = new NavigationCursor();
        this.refreshTimer = null;
        this.listeners = [];
        this.chatElement = null;
        this.chatScrollHandler = () => {
            if (this.busy || this.scrollRaf !== null) return;
            this.scrollRaf = requestAnimationFrame(() => {
                this.scrollRaf = null;
                this.updateCurrent();
            });
        };
        this.scrollRaf = null;
        this.view = new NavigatorView({
            context, hasChat: () => this.hasChat(),
            navigate: action => { void this.navigate(action); },
            goToIndex: index => { void this.goToIndex(index); },
            canNavigate: (kind, index) => this.canNavigate(kind, index),
            saveTitle: (index, title) => this.saveTitle(index, title),
            getPosition: () => this.settings.position,
            savePosition: position => this.changeSetting('position', position),
            listBuildings: listAvailableBuildings,
            enterBuilding,
            getTheme: () => this.settings.elevatorTheme,
            getSkyMode: () => this.settings.elevatorSky,
        });
        this.view.setNavigationButtonsVisible(this.settings.showNavigationButtons);
        this.view.position(this.settings.side);
        installSettings(context(), this.settings, (key, value) => this.changeSetting(key, value));
        this.bindChatScroll();
        this.bindEvents();
        this.updateCurrent();
        this.view.rebuild();
    }

    hasChat() {
        const ctx = context();
        return Array.isArray(ctx.chat) && ctx.chat.length > 0;
    }

    canNavigate(action, index) {
        const ctx = context();
        return findTarget(ctx.chat || [], index, action, this.settings.mode) >= 0;
    }

    updateCurrent() {
        if (this.busy) return;
        this.bindChatScroll();
        const chat = context().chat || [];
        const id = this.cursor.resolve(this.chatElement, chat.length);
        this.lastNavigated = id;
        this.view.setActive(id);
    }

    bindChatScroll() {
        const current = getChatElement();
        if (current === this.chatElement) return;
        this.chatElement?.removeEventListener('scroll', this.chatScrollHandler);
        this.cursor.clear();
        this.chatElement = current;
        this.chatElement?.addEventListener('scroll', this.chatScrollHandler, { passive: true });
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        if (this.chatElement && typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this.view.position(this.settings.side));
            this.resizeObserver.observe(this.chatElement);
        }
        this.view.position(this.settings.side);
    }

    changeSetting(key, value) {
        if (key === 'mode' && !['visible', 'all'].includes(value)) return;
        if (key === 'side' && !['left', 'right'].includes(value)) return;
        if (key === 'position' && !validNavPosition(value)) return;
        if (key === 'showNavigationButtons' && typeof value !== 'boolean') return;
        if (key === 'elevatorTheme' && !['classic', 'restricted', 'sky'].includes(value)) return;
        if (key === 'elevatorSky' && !['auto', 'day', 'night'].includes(value)) return;
        this.settings[key] = value;
        if (key === 'elevatorTheme' || key === 'elevatorSky') {
            this.view.elevator?.applyTheme(this.settings.elevatorTheme, this.settings.elevatorSky);
        }
        if (key === 'showNavigationButtons') this.view.setNavigationButtonsVisible(value);
        if (key === 'side') {
            // Choosing left/right restores the default placement.
            this.settings.position = null;
            this.view.position(value);
        }
        context().saveSettingsDebounced?.();
        if (key !== 'position') this.updateCurrent();
    }

    bindEvents() {
        const ctx = context();
        const events = ctx.eventTypes || ctx.event_types || {};
        const register = (key, cb) => {
            if (!events[key] || !ctx.eventSource?.on) return;
            ctx.eventSource.on(events[key], cb);
            this.listeners.push([events[key], cb]);
        };
        register('CHAT_CHANGED', () => {
            this.navSerial++;
            this.busy = false;
            this.cursor.clear();
            this.clearTargetHighlight();
            this.view.editing = -1;
            this.view.query = '';
            this.view.search.value = '';
            this.view.groupCollapsed.clear();
            this.view.elevator?.onChatChanged();
            this.view.setStatus('');
            this.scheduleRefresh(true);
        });
        for (const key of [
            'CHAT_CREATED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED',
            'USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED',
            'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED',
            'MESSAGE_SWIPED', 'MORE_MESSAGES_LOADED',
        ]) register(key, () => this.scheduleRefresh(false));
        // Scope this observer to the chat only. It never changes ST's nodes.
        if (this.chatElement && typeof MutationObserver !== 'undefined') {
            this.observer = new MutationObserver(records => {
                if (records.some(r => (r.type === 'childList' && r.target === this.chatElement) || r.attributeName === 'is_system')) {
                    this.scheduleRefresh(false);
                }
            });
            this.observer.observe(this.chatElement, {
                childList: true, subtree: true, attributes: true,
                attributeFilter: ['is_system'],
            });
        }
    }

    scheduleRefresh(reset) {
        if (reset) this.pendingReset = true;
        if (this.refreshTimer !== null) return;
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = null;
            this.bindChatScroll();
            if (this.pendingReset) {
                this.pendingReset = false;
                this.lastNavigated = -1;
                this.view.rebuild();
            } else this.view.rebuild({ keepScroll: true });
            this.updateCurrent();
        }, 90);
    }

    async navigate(action) {
        const ctx = context();
        this.bindChatScroll();
        const base = this.cursor.resolve(this.chatElement, ctx.chat?.length || 0);
        const target = findTarget(ctx.chat || [], base, action, this.settings.mode);
        if (target >= 0) await this.goToIndex(target);
    }

    async goToIndex(index) {
        if (this.busy) return;
        const initial = context();
        const chatRef = initial.chat;
        const chatId = initial.chatId;
        if (!Array.isArray(chatRef) || !chatRef[index] || !Number.isInteger(index)) return;
        const token = ++this.navSerial;
        this.busy = true;
        this.view.setActive(this.lastNavigated, true);
        this.view.setStatus('메시지 위치를 찾는 중…');
        const cancelled = () => token !== this.navSerial || context().chat !== chatRef || context().chatId !== chatId;
        try {
            const chatElement = await ensureMessageRendered(initial, index, cancelled, text => this.view.setStatus(text));
            if (cancelled() || !chatElement) return;
            const node = getRenderedMessage(chatElement, index);
            if (!scrollToMessage(chatElement, node)) throw new Error('대상 메시지가 화면에서 숨겨져 있어 스크롤할 수 없습니다.');
            this.cursor.set(chatElement, index);
            this.lastNavigated = index;
            this.highlightTarget(node);
            this.view.setActive(index, true);
            this.view.setStatus(`메시지 #${index}로 이동했습니다.`);
        } catch (error) {
            if (!cancelled()) {
                console.warn(PREFIX, error);
                this.view.setStatus(error.message || '이동에 실패했습니다.', true);
            }
        } finally {
            if (token === this.navSerial) {
                this.busy = false;
                // UI scroll events can run after programmatic scrolling.
                this.view.setActive(this.lastNavigated);
            }
        }
    }

    // A short highlight removes ambiguity near the end of a chat where the
    // selected message cannot be scrolled all the way to the top.
    highlightTarget(node) {
        this.clearTargetHighlight();
        this.highlightedNode = node;
        node.classList.add('stmn-jump-target');
        this.highlightTimer = setTimeout(() => this.clearTargetHighlight(), 1800);
    }

    clearTargetHighlight() {
        if (this.highlightTimer !== undefined) clearTimeout(this.highlightTimer);
        this.highlightTimer = undefined;
        this.highlightedNode?.classList.remove('stmn-jump-target');
        this.highlightedNode = null;
    }

    async saveTitle(index, title) {
        const ctx = context();
        if (!ctx.chatId || !ctx.chatMetadata || !Array.isArray(ctx.chat) || !ctx.chat[index]) {
            throw new Error('먼저 저장된 채팅을 선택해 주세요.');
        }
        const chatRef = ctx.chat;
        const chatId = ctx.chatId;
        // Don't edit text, swipes, prompt order, or another extension's keys.
        assignCustomTitle(chatRef, ctx.chatMetadata, index, title);
        // saveMetadata() ultimately saves the whole chat (message ID + metadata).
        // Start the save immediately to minimize switch-chat races.
        if (typeof ctx.saveMetadata !== 'function') throw new Error('이 버전에서는 메타데이터 저장을 사용할 수 없습니다.');
        await ctx.saveMetadata();
        if (context().chat !== chatRef || context().chatId !== chatId) {
            throw new Error('저장 도중 채팅이 바뀌었습니다. 저장 결과를 확인해 주세요.');
        }
    }

    destroy() {
        this.navSerial++;
        this.cursor.clear();
        this.clearTargetHighlight();
        if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
        if (this.scrollRaf !== null) cancelAnimationFrame(this.scrollRaf);
        this.resizeObserver?.disconnect();
        this.observer?.disconnect();
        this.chatElement?.removeEventListener('scroll', this.chatScrollHandler);
        const ctx = context();
        for (const [name, cb] of this.listeners) ctx.eventSource?.removeListener?.(name, cb);
        document.getElementById('stmn-settings')?.remove();
        this.view.destroy();
    }
}

function initialize() {
    if (app || document.getElementById('stmn-root')) return;
    try {
        app = new NavigatorApp();
        console.info(PREFIX, 'loaded (v1.3.0)');
    } catch (error) {
        console.error(PREFIX, 'initialization error:', error);
    }
}

// APP_READY self-fires for late extensions on recent SillyTavern versions.
// A DOM-ready fallback supports older releases without double initialization.
if (globalThis.SillyTavern?.getContext) {
    try {
        const ctx = context();
        const readyEvent = (ctx.eventTypes || ctx.event_types || {}).APP_READY;
        if (readyEvent) ctx.eventSource.on(readyEvent, initialize);
        if (document.readyState === 'complete') setTimeout(initialize, 0);
        else window.addEventListener('load', initialize, { once: true });
    } catch (error) {
        console.error(PREFIX, 'startup error:', error);
    }
}
