/** Pure helpers for the building-lobby metaphor; never changes SillyTavern chats. */

export function cleanChatId(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/\.jsonl$/i, '').trim();
}

export function buildingScope(context) {
    if (context?.groupId != null && context.groupId !== '') return 'group:' + String(context.groupId);
    const character = context?.characters?.[context.characterId];
    return character ? 'character:' + String(character.avatar || context.characterId) : null;
}

export function parseLastActivity(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value < 100000000000 ? value * 1000 : value;
    }
    if (typeof value !== 'string' || !value.trim()) return 0;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? parseLastActivity(numeric) : 0;
}

/** The file name stays a stable transport ID; a display name is not used for loading. */
export function normalizeBuildings(rows, currentId) {
    const found = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
        const id = cleanChatId(row?.file_name || row?.chat_id || row?.id);
        if (!id || found.has(id)) continue;
        const name = String(row?.display_name || row?.chat_name || id).trim() || id;
        found.set(id, {
            id,
            name,
            preview: String(row?.preview_message || '').slice(0, 500),
            count: Number.isSafeInteger(Number(row?.message_count)) && Number(row.message_count) >= 0
                ? Number(row.message_count) : null,
            lastActivity: parseLastActivity(row?.last_mes || row?.date_last_chat || row?.last_activity),
        });
    }
    const current = cleanChatId(currentId);
    if (current && !found.has(current)) {
        found.set(current, { id: current, name: current, preview: '', count: null, lastActivity: 0 });
    }
    return [...found.values()];
}

export function findBuildings(buildings, query, sort = 'recent') {
    const search = String(query || '').trim().toLocaleLowerCase();
    const filtered = search
        ? buildings.filter(b => (b.name + ' ' + b.id + ' ' + b.preview).toLocaleLowerCase().includes(search))
        : [...buildings];
    if (sort === 'name') {
        filtered.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    } else {
        filtered.sort((a, b) => b.lastActivity - a.lastActivity ||
            b.id.localeCompare(a.id, undefined, { numeric: true }));
    }
    return filtered;
}
