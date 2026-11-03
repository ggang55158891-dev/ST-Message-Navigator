/**
 * Q-04 read-only, on-demand SillyTavern chat preview adapter.
 *
 * Both endpoints return JSONL records [header, ...messages]. Never calls
 * openCharacterChat/openGroupChat and never writes message bodies or metadata.
 * Other-chat bodies are not cached; retain only titles and a 680-char excerpt.
 */
import { cleanChatId, buildingScope } from './building-data.js';
import { getTitle } from './model.js';

export const CHAT_PREVIEW_EXCERPT = 680;
export const CHAT_PREVIEW_CACHE_MS = 90_000;
export const CHAT_PREVIEW_CACHE_LIMIT = 3;
export const CHAT_PREVIEW_ROW_HEIGHT = 43;

function isHeader(record) {
    return !!record && typeof record === 'object' && !Array.isArray(record) &&
        Object.prototype.hasOwnProperty.call(record, 'chat_metadata');
}

export function projectChatPreview(records) {
    if (!Array.isArray(records)) throw new Error('채팅 파일의 메시지 형식이 올바르지 않습니다.');
    const header = isHeader(records[0]) ? records[0] : null;
    const metadata = header?.chat_metadata ?? {};
    const start = header ? 1 : 0;
    const entries = [];
    let latest = '';
    for (let i = start; i < records.length; i++) {
        const message = records[i];
        if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
        const id = i - start;
        entries.push({
            index:id, title:getTitle(message, metadata),
            speaker:String(message.name || (message.is_user ? '사용자' : '캐릭터')).slice(0,70),
        });
        latest = String(message.mes ?? '');
    }
    const lastFive = entries.slice(-5);
    const excerpt = latest.length > CHAT_PREVIEW_EXCERPT
        ? latest.slice(0,CHAT_PREVIEW_EXCERPT)+'…' : latest;
    return {entries, lastFive, excerpt, messageCount:entries.length};
}

export function validateChatPreviewTarget(ctx, scope, buildings, item) {
    if (!ctx || buildingScope(ctx) !== scope || !Array.isArray(buildings)) {
        throw new Error('현재 캐릭터 또는 그룹이 변경되어 미리보기를 중단했습니다.');
    }
    const id = cleanChatId(item?.id);
    if (!id || !buildings.some(x => cleanChatId(x.id) === id)) {
        throw new Error('현재 채팅 목록에 없는 대상은 미리볼 수 없습니다.');
    }
    const group = ctx.groupId !== null && ctx.groupId !== undefined && ctx.groupId !== '';
    if (group) {
        const selected = ctx.groups?.find(x=>String(x.id)===String(ctx.groupId));
        if (!selected || !Array.isArray(selected.chats) ||
            !selected.chats.some(x=>cleanChatId(x)===id)) {
            throw new Error('선택된 그룹의 채팅만 미리볼 수 있습니다.');
        }
        return {id,endpoint:'/api/chats/group/get',body:{id}};
    }
    const character = ctx.characters?.[ctx.characterId];
    if (!character || typeof character.avatar !== 'string' || !character.avatar) {
        throw new Error('선택된 캐릭터의 프로필이 준비되지 않았습니다.');
    }
    return {
        id,endpoint:'/api/chats/get',
        body:{file_name:id,avatar_url:character.avatar,ch_name:String(character.name||'')},
    };
}

export async function readChatPreview(ctx, scope, buildings, item, {
    signal, fetcher=fetch,
} = {}) {
    const target=validateChatPreviewTarget(ctx, scope, buildings, item);
    if (typeof ctx.getRequestHeaders !== 'function') {
        throw new Error('SillyTavern의 인증 정보를 가져올 수 없습니다.');
    }
    const response=await fetcher(target.endpoint,{
        method:'POST',
        headers:ctx.getRequestHeaders(),
        body:JSON.stringify(target.body),
        cache:'no-store',signal,
    });
    if (!response.ok) throw new Error('채팅을 불러오지 못했습니다. (HTTP '+response.status+')');
    const raw=await response.json();
    if (!Array.isArray(raw)) throw new Error('비어 있거나 읽을 수 없는 채팅 파일입니다.');
    if (signal?.aborted) throw new DOMException('요청이 취소되었습니다.','AbortError');
    return projectChatPreview(raw);
}

/** Cache only the small presentation projection, never the original chat body. */
export class ChatPreviewCache {
    constructor(ttl=CHAT_PREVIEW_CACHE_MS, limit=CHAT_PREVIEW_CACHE_LIMIT, clock=()=>Date.now()) {
        this.ttl=ttl;
        this.limit=limit;
        this.clock=clock;
        this.data=new Map();
    }
    get(key) {
        const value=this.data.get(key);
        if (!value) return null;
        if (this.clock()-value.at > this.ttl) {this.data.delete(key);return null;}
        this.data.delete(key);
        this.data.set(key,value);
        return value.preview;
    }
    set(key,preview) {
        this.data.delete(key);
        this.data.set(key,{preview,at:this.clock()});
        while (this.data.size>this.limit) this.data.delete(this.data.keys().next().value);
    }
    clear() {this.data.clear();}
}
