/** Pure outline search, grouping and virtual-row geometry. No chat mutations. */
export const MESSAGE_ROW_HEIGHT = 68;
export const GROUP_ROW_HEIGHT = 42;
export const GROUP_SIZE = 10;

/** '#4' matches only message index 4; ordinary text retains broad search. */
export function filterOutlineEntries(entries, query = '') {
    const term = String(query ?? '').trim().toLocaleLowerCase();
    if (!term) return entries;
    const messageId = /^#(\\d+)$/u.exec(term);
    if (messageId) {
        const index = Number(messageId[1]);
        return Number.isSafeInteger(index) ? entries.filter(entry => entry.index === index) : [];
    }
    return entries.filter(entry => (
        entry.searchable.includes(term) || String(entry.index).includes(term)
    ));
}

/**
 * Group unfiltered messages in #0-#9, #10-#19 ... ranges. Filtered results
 * show just matching messages so '#4' literally produces a single row.
 * Returns positioned rows for virtual scrolling over large chats.
 */
export function buildOutlineRows(entries, totalCount, collapsed = new Set(), searching = false) {
    const rows = [];
    let top = 0;
    let previousGroup = -1;
    for (const entry of entries) {
        const start = Math.floor(entry.index / GROUP_SIZE) * GROUP_SIZE;
        if (!searching && start !== previousGroup) {
            previousGroup = start;
            const end = Math.min(totalCount - 1, start + GROUP_SIZE - 1);
            rows.push({
                kind: 'group', start, end,
                count: end - start + 1,
                collapsed: collapsed.has(start),
                top, height: GROUP_ROW_HEIGHT,
            });
            top += GROUP_ROW_HEIGHT;
        }
        if (!searching && collapsed.has(start)) continue;
        rows.push({ kind: 'message', entry, top, height: MESSAGE_ROW_HEIGHT });
        top += MESSAGE_ROW_HEIGHT;
    }
    return { rows, totalHeight: top };
}

/** First row overlapping pixel offset, O(log n). */
export function findOutlineRow(rows, offset) {
    let low = 0, high = rows.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (rows[middle].top + rows[middle].height <= offset) low = middle + 1;
        else high = middle;
    }
    return Math.min(low, Math.max(0, rows.length - 1));
}
