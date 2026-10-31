import { buildingScope, cleanChatId, normalizeBuildings } from './building-data.js';

/**
 * Read chat listings through SillyTavern's own functions; no direct file edits.
 * Scope is deliberately limited to the current character or selected group.
 */
export async function listAvailableBuildings(context) {
    const scope = buildingScope(context);
    if (!scope) return { scope: null, buildings: [], title: '선택된 캐릭터 없음' };
    const current = cleanChatId(context.chatId);
    if (context.groupId != null && context.groupId !== '') {
        const group = (context.groups || []).find(g => String(g.id) === String(context.groupId));
        if (!group) return { scope, buildings: [], title: '그룹을 찾을 수 없음' };
        // The group already has an authoritative list of chat IDs; avoid
        // expensive individual group/info requests for every chat.
        const rows = (Array.isArray(group.chats) ? group.chats : []).map(id => ({ file_name: id }));
        return { scope, buildings: normalizeBuildings(rows, current), title: String(group.name || '그룹 채팅') };
    }
    const character = context.characters?.[context.characterId];
    if (!character) return { scope, buildings: [], title: '캐릭터 없음' };
    const core = await import('../../../../script.js');
    if (typeof core.getPastCharacterChats !== 'function') {
        throw new Error('SillyTavern 채팅 목록 API를 사용할 수 없습니다.');
    }
    const raw = await core.getPastCharacterChats(context.characterId);
    return {
        scope,
        buildings: normalizeBuildings(raw, current),
        title: String(character.name || '캐릭터 채팅'),
    };
}

export async function enterBuilding(context, id) {
    const target = cleanChatId(id);
    if (!target) throw new Error('유효하지 않은 채팅입니다.');
    if (cleanChatId(context.chatId) === target) return false;
    if (context.groupId != null && context.groupId !== '') {
        const groups = await import('../../../group-chats.js');
        const group = (context.groups || []).find(g => String(g.id) === String(context.groupId));
        if (!group || !group.chats?.some(name => cleanChatId(name) === target)) {
            throw new Error('현재 그룹에 속하지 않은 채팅입니다.');
        }
        if (typeof groups.openGroupChat !== 'function') throw new Error('그룹 채팅 전환 기능을 사용할 수 없습니다.');
        // Group chat IDs normally have no .jsonl suffix.
        const original = group.chats.find(name => cleanChatId(name) === target);
        await groups.openGroupChat(context.groupId, original);
        return true;
    }
    const core = await import('../../../../script.js');
    if (typeof core.openCharacterChat !== 'function') {
        throw new Error('SillyTavern 채팅 전환 API를 사용할 수 없습니다.');
    }
    await core.openCharacterChat(target);
    return true;
}
