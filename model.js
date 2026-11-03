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

// Intl.Segmenter initialization is relatively expensive. Reuse one instance
// across title extraction calls instead of constructing it for each message.
let sharedSentenceSegmenter;
let segmenterInitialized = false;
function sentenceSegmenter() {
    if (!segmenterInitialized) {
        segmenterInitialized = true;
        try {
            if (typeof Intl?.Segmenter === 'function') {
                sharedSentenceSegmenter = new Intl.Segmenter('ko', { granularity: 'sentence' });
            }
        } catch {
            sharedSentenceSegmenter = undefined;
        }
    }
    return sharedSentenceSegmenter;
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
    const segmenter = sentenceSegmenter();
    if (segmenter) {
        try {
            const parts = segmenter.segment(text);
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


/** Q-02 message bookmarks are kept alongside outline titles in chat metadata.
 * Stored by stable per-message ID, not by position (which changes after edits).
 * They never modify swipe text, extra metadata, or navigation titles. */
export function isMessageBookmarked(message, metadata) {
    const id = message?.[MESSAGE_KEY];
    return typeof id === 'string' &&
        Object.prototype.hasOwnProperty.call(metadata?.[DATA_KEY]?.bookmarks || {}, id) &&
        metadata[DATA_KEY].bookmarks[id] === true;
}

export function setMessageBookmark(chat, metadata, index, value, idFactory = makeId) {
    if (!Array.isArray(chat) || !chat[index] || !metadata || typeof metadata !== 'object' ||
        typeof value !== 'boolean') throw new Error('메시지 북마크를 변경할 수 없습니다.');
    const message = chat[index];
    if (isMessageBookmarked(message, metadata) === value) return false;
    const previous = message[MESSAGE_KEY];
    const reserved = ['__proto__','prototype','constructor'];
    const valid = typeof previous === 'string' && previous.length > 0 &&
        previous.length <= 200 && !reserved.includes(previous);
    const unique = valid && !chat.some((m,i) => i !== index && m?.[MESSAGE_KEY] === previous);
    if (!value) {
        if (unique && metadata?.[DATA_KEY]?.bookmarks) delete metadata[DATA_KEY].bookmarks[previous];
        return true;
    }
    let id = unique ? previous : null;
    if (!id) {
        for (let attempt = 0; attempt < 12; attempt++) {
            const candidate = idFactory();
            if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 200 &&
                !reserved.includes(candidate) && !chat.some(m => m?.[MESSAGE_KEY] === candidate)) {
                id = candidate;
                break;
            }
        }
    }
    if (!id) throw new Error('중복되지 않는 메시지 ID를 발급할 수 없습니다.');
    if (!metadata[DATA_KEY] || typeof metadata[DATA_KEY] !== 'object' ||
        Array.isArray(metadata[DATA_KEY])) metadata[DATA_KEY] = { schema: 1, titles: Object.create(null) };
    const store = metadata[DATA_KEY];
    if (!store.bookmarks || typeof store.bookmarks !== 'object' ||
        Array.isArray(store.bookmarks)) store.bookmarks = Object.create(null);
    // Duplicate message IDs are never allowed to share bookmark ownership.
    message[MESSAGE_KEY] = id;
    store.bookmarks[id] = true;
    return true;
}
