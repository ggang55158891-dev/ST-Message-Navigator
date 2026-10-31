/** Pure chat-navigation and display helpers. Never mutates a message. */
export const DATA_KEY = 'stmn_message_outline_v1';
export const MESSAGE_KEY = 'stmn_message_id_v1';
export const SETTINGS_KEY = 'st_message_navigator_v1';

export function isNavigable(message, mode = 'visible') {
    return !!message && (mode === 'all' || message.is_system !== true);
}

export function findTarget(chat, current, direction, mode = 'visible') {
    if (!Array.isArray(chat) || !chat.length) return -1;
    if (direction === 'first') {
        return chat.findIndex(message => isNavigable(message, mode));
    }
    if (direction === 'last') {
        for (let i = chat.length - 1; i >= 0; i--) {
            if (isNavigable(chat[i], mode)) return i;
        }
        return -1;
    }
    if (!Number.isInteger(current)) return -1;
    const step = direction === 'previous' ? -1 : direction === 'next' ? 1 : 0;
    if (!step) return -1;
    for (let i = current + step; i >= 0 && i < chat.length; i += step) {
        if (isNavigable(chat[i], mode)) return i;
    }
    return -1;
}

function plainText(text) {
    return String(text ?? '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\{\{[^}]*\}\}/g, '')
        .replace(/^[\s>\-*#]+/gm, '')
        .replace(/[*_~`|]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export function automaticTitle(message, maxLength = 68) {
    const text = plainText(message?.mes);
    if (!text) return message?.extra?.image || message?.extra?.file ? '(이미지/첨부 메시지)' : '(내용 없는 메시지)';
    let sentence = '';
    if (typeof Intl?.Segmenter === 'function') {
        try {
            const parts = new Intl.Segmenter('ko', { granularity: 'sentence' }).segment(text);
            sentence = parts[Symbol.iterator]().next().value?.segment?.trim() || '';
        } catch { /* Fall through to punctuation-based extraction. */ }
    }
    if (!sentence) sentence = text.match(/^.+?[.!?。！？](?=\s|$|["'”’])/u)?.[0] || text;
    sentence = sentence.trim();
    return sentence.length > maxLength ? `${sentence.slice(0, maxLength).trimEnd()}…` : sentence;
}

export function getTitle(message, metadata) {
    const id = message?.[MESSAGE_KEY];
    const titles = metadata?.[DATA_KEY]?.titles;
    const stored = typeof id === 'string' && titles && Object.prototype.hasOwnProperty.call(titles, id) ? titles[id] : undefined;
    return typeof stored === 'string' && stored.trim() ? stored : automaticTitle(message);
}

export function isCustomTitle(message, metadata) {
    const id = message?.[MESSAGE_KEY];
    const titles = metadata?.[DATA_KEY]?.titles;
    return typeof id === 'string' && !!titles && Object.prototype.hasOwnProperty.call(titles, id) && typeof titles[id] === 'string';
}

export function makeId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    // Older embedded browsers: collision-resistant enough for a local per-chat identifier.
    return `stmn-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Only an explicitly edited message gains an ID. IDs are stored on messages
 * (not in 'extra', which SillyTavern replaces on swipes). The text is untouched.
 * Titles live in chatMetadata and inherit into branches via SillyTavern's cloning.
 */
export function assignCustomTitle(chat, metadata, index, title, idFactory = makeId) {
    if (!Array.isArray(chat) || !chat[index] || !metadata || typeof metadata !== 'object') {
        throw new Error('현재 저장 가능한 채팅이 없습니다.');
    }
    const message = chat[index];
    const clean = String(title ?? '').trim().slice(0, 300);
    const previousId = message[MESSAGE_KEY];
    const safePreviousId = typeof previousId === 'string' && !['__proto__', 'prototype', 'constructor'].includes(previousId) ? previousId : null;
    const usedElsewhere = !!safePreviousId && chat.some((item, i) => i !== index && item?.[MESSAGE_KEY] === safePreviousId);
    let id = safePreviousId && !usedElsewhere ? safePreviousId : idFactory();
    if (['__proto__', 'prototype', 'constructor'].includes(id)) throw new Error('안전하지 않은 식별자입니다.');
    if (clean && usedElsewhere) {
        for (let attempts = 0; chat.some(item => item?.[MESSAGE_KEY] === id); attempts++) {
            if (attempts > 10) throw new Error('중복되지 않는 메시지 식별자를 만들지 못했습니다.');
            id = idFactory();
        }
    }
    if (!metadata[DATA_KEY] || typeof metadata[DATA_KEY] !== 'object') {
        metadata[DATA_KEY] = { schema: 1, titles: Object.create(null) };
    }
    const store = metadata[DATA_KEY];
    if (!store.titles || typeof store.titles !== 'object' || Array.isArray(store.titles)) store.titles = Object.create(null);
    if (!clean) {
        if (safePreviousId && !usedElsewhere) delete store.titles[safePreviousId];
        return;
    }
    message[MESSAGE_KEY] = id;
    store.titles[id] = clean;
}
