/** Quiet preview geometry and swipe data.
 * This is a presentation model: no changes to original chat messages.
 */
export const QUIET_DETAIL_HEIGHT = 408;
export const TOOLTIP_CHAR_LIMIT = 680;

export function previewSwipes(message) {
    const raw = Array.isArray(message?.swipes) && message.swipes.length
        ? message.swipes : [message?.mes ?? ''];
    const texts = raw.map(text => String(text ?? ''));
    const selected = Number.isInteger(message?.swipe_id)
        ? Math.max(0, Math.min(message.swipe_id, texts.length - 1))
        : 0;
    return { texts, selected };
}

/** Only when a preview is open, add its row to the virtual outline.
 * Preserve O(log n) viewport lookup, rather than adding all message DOM nodes.
 */
export function withQuietPreview(rows, index, height = QUIET_DETAIL_HEIGHT) {
    if (!Number.isSafeInteger(index) || index < 0) return { rows, totalHeight: 0, present: false };
    const at = rows.findIndex(row => row.kind === 'message' && row.entry.index === index);
    if (at < 0) return { rows, totalHeight: 0, present: false };
    const result = rows.slice();
    const previous = result[at];
    const top = previous.top + previous.height;
    result.splice(at + 1, 0, {kind:'preview',top,height,entry:previous.entry});
    for (let i = at + 2; i < result.length; i++) result[i] = {...result[i],top:result[i].top + height};
    return {rows:result,totalHeight:height,present:true};
}

export function messageTooltipText(message, limit = TOOLTIP_CHAR_LIMIT) {
    const text = String(message?.mes ?? '');
    return text.length <= limit ? text : text.slice(0, limit) + '…';
}

/** Validate the user-requested swipe before invoking SillyTavern's core API. */
export function isValidSwipeSelection(message, target) {
    return Number.isInteger(target) && target >= 0 &&
        Array.isArray(message?.swipes) && target < message.swipes.length;
}
