/** Read-only inspection of current chat's custom-title metadata; opt-in. */
import { DATA_KEY, MESSAGE_KEY } from './model.js';

export function inspectTitleMetadata(chat, metadata) {
    const messages = Array.isArray(chat) ? chat : [];
    const rawStore = metadata?.[DATA_KEY];
    const titles = rawStore && typeof rawStore === 'object' && !Array.isArray(rawStore?.titles)
        && rawStore.titles && typeof rawStore.titles === 'object' ? rawStore.titles : null;
    const seen = new Map();
    for (const message of messages) {
        const id = message?.[MESSAGE_KEY];
        if (typeof id === 'string' && id) seen.set(id, (seen.get(id) || 0) + 1);
    }
    let customTitles = 0, orphanTitles = 0, invalidTitles = 0;
    if (titles) {
        for (const [id, title] of Object.entries(titles)) {
            if (typeof title !== 'string' || !title.trim() || title.length > 300) {
                invalidTitles++;
                continue;
            }
            customTitles++;
            if (!seen.has(id)) orphanTitles++;
        }
    }
    return {
        messages: messages.length,
        customTitles,
        orphanTitles,
        invalidTitles,
        duplicateMessageIds: [...seen.values()].filter(count => count > 1).length,
        malformedStore: rawStore !== undefined && (!rawStore || typeof rawStore !== 'object' ||
            !titles || Array.isArray(rawStore.titles)),
    };
}
