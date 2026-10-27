/** The ONLY adapter to SillyTavern's historical message pagination. */
const CHAT_SELECTOR = '#chat';
let coreImporter;

export function getChatElement() {
    return document.querySelector(CHAT_SELECTOR);
}

export function getRenderedMessage(chatElement, id) {
    // A numeric ID from the chat array; no untrusted selector interpolation.
    return [...(chatElement?.querySelectorAll(':scope > .mes[mesid]') || [])]
        .find(element => Number(element.getAttribute('mesid')) === id) || null;
}

export function getCurrentIndex(chatElement, chatLength) {
    if (!chatElement || !chatLength) return -1;
    const children = chatElement.querySelectorAll(':scope > .mes[mesid]');
    const total = children.length;
    if (!total) return chatLength - 1;
    const viewport = chatElement.getBoundingClientRect();
    const threshold = viewport.top + 14;
    // Messages are in DOM order. Binary search avoids reading thousands of
    // bounding boxes on every wheel/trackpad event in long chats.
    let left = 0;
    let right = total - 1;
    while (left < right) {
        const middle = Math.floor((left + right) / 2);
        const rect = children[middle].getBoundingClientRect();
        if (rect.bottom <= threshold) left = middle + 1;
        else right = middle;
    }
    // Some themes hide rows with display:none. Skip non-rendered entries.
    let index = left;
    while (index < total && children[index].getBoundingClientRect().height < 1) index++;
    if (index === total) index = left;
    const id = Number(children[index].getAttribute('mesid'));
    return Number.isInteger(id) && id >= 0 && id < chatLength ? id : chatLength - 1;
}

/**
 * Keep explicit navigation independent of the viewport's first visible row.
 * At the bottom of a chat the browser clamps scrollTop, so the intended row
 * can be visible while its predecessor still occupies the top of the viewport.
 * In that situation getCurrentIndex() alone would skip a message on "previous".
 * Once the scroll position changes (manual scrolling), resume DOM detection.
 */
export class NavigationCursor {
    constructor() {
        this.clear();
    }

    clear() {
        this.index = -1;
        this.scrollTop = null;
    }

    set(chatElement, index) {
        if (!chatElement || !Number.isInteger(index) || index < 0) {
            this.clear();
            return;
        }
        this.index = index;
        this.scrollTop = chatElement.scrollTop;
    }

    resolve(chatElement, chatLength) {
        if (this.index >= 0 && this.index < chatLength &&
            chatElement && Number.isFinite(this.scrollTop) &&
            Math.abs(chatElement.scrollTop - this.scrollTop) <= 2) {
            return this.index;
        }
        this.clear();
        return getCurrentIndex(chatElement, chatLength);
    }
}

export function scrollToMessage(chatElement, element) {
    if (!element || !chatElement) return false;
    const box = element.getBoundingClientRect();
    if (box.height < 1) return false;
    const root = chatElement.getBoundingClientRect();
    const next = chatElement.scrollTop + box.top - root.top - (chatElement.clientTop || 0) - 12;
    // 'auto' may inherit scroll-behavior:smooth from a theme.  'instant' makes
    // the scroll position stable before the navigation anchor is recorded.
    chatElement.scrollTo({ top: Math.max(0, next), behavior: 'instant' });
    return true;
}

// Stable importer: direct dependency isolated to this one adapter. The public
// 'Show more messages' button remains a fallback if ST changes its exports.
async function loadChunk(context, count) {
    if (coreImporter === undefined) coreImporter = import('../../../../script.js').catch(() => null);
    const core = await coreImporter;
    if (typeof core?.showMoreMessages === 'function') {
        await core.showMoreMessages(count);
        return true;
    }
    const button = document.getElementById('show_more_messages');
    if (!button) return false;
    const eventName = context.eventTypes?.MORE_MESSAGES_LOADED;
    let cleanup = () => {};
    const loaded = new Promise(resolve => {
        if (!eventName || !context.eventSource?.on || !context.eventSource?.removeListener) {
            resolve(false);
            return;
        }
        const handler = () => { cleanup(); resolve(true); };
        const timeout = setTimeout(() => { cleanup(); resolve(false); }, 6000);
        cleanup = () => {
            clearTimeout(timeout);
            context.eventSource.removeListener(eventName, handler);
        };
        context.eventSource.on(eventName, handler);
    });
    button.click();
    return await loaded;
}

/** Incremental, cancellable, UI-yielding load of earlier messages. */
export async function ensureMessageRendered(context, target, cancelled, onProgress) {
    const chatElement = getChatElement();
    if (!chatElement) throw new Error('채팅 화면을 찾을 수 없습니다.');
    const chat = context.chat;
    if (getRenderedMessage(chatElement, target)) return chatElement;
    // The normal app renders the latest part of the chat; earlier messages
    // must be loaded with the same core renderer to preserve other extensions.
    for (let batch = 0; batch < 1000; batch++) {
        if (cancelled()) return null;
        const first = chatElement.querySelector(':scope > .mes[mesid]');
        const firstIndex = first ? Number(first.getAttribute('mesid')) : chat.length;
        if (!Number.isFinite(firstIndex) || firstIndex <= target || firstIndex <= 0) break;
        const count = Math.min(180, firstIndex - target);
        onProgress?.(`과거 메시지 불러오는 중 · #${Math.max(1, firstIndex - count + 1)}`);
        const before = firstIndex;
        try {
            const ok = await loadChunk(context, count);
            if (!ok) break;
        } catch (error) {
            console.warn('[STMN] Message pagination failed:', error);
            break;
        }
        if (cancelled()) return null;
        const next = chatElement.querySelector(':scope > .mes[mesid]');
        if (Number(next?.getAttribute('mesid')) >= before) break;
        if (getRenderedMessage(chatElement, target)) return chatElement;
        // Keep large chats responsive between batches.
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (!getRenderedMessage(chatElement, target)) throw new Error('대상 메시지를 화면에 불러올 수 없습니다.');
    return chatElement;
}
