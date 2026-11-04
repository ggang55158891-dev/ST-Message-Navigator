/**
 * E-03A: opt-in, bounded current-scope search. This is NOT a background
 * crawler or a persistent index. Raw JSONL/JSON messages are processed once
 * and discarded; results contain only short excerpts.
 */
import {cleanChatId,buildingScope} from './building-data.js';
import {validateChatPreviewTarget} from './chat-preview.js';
import {getTitle} from './model.js';

export const SEARCH_BATCH_SIZE=12;
export const SEARCH_CHAT_BYTES=6*1024*1024;
export const SEARCH_MAX_PER_CHAT=4;
export const SEARCH_MAX_RESULTS=72;
export const SEARCH_SNIPPET_CHARS=180;
const has=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);

export function normalizeSearchQuery(value){
    if(typeof value!=='string')throw new Error('검색어가 올바르지 않습니다.');
    const result=value.trim();
    if(result.length<2 || result.length>100 || /[\u0000-\u001f\u007f]/.test(result))
        throw new Error('검색어를 2~100자로 입력해 주세요.');
    return result;
}

export function metadataMatches(item,query){
    const needle=normalizeSearchQuery(query).toLocaleLowerCase();
    return [item.name,item.id,item.alias,item.description,item.folderName,
        ...(item.tagNames||[])].some(x=>String(x??'').toLocaleLowerCase().includes(needle));
}

export function searchExcerpt(text,query){
    const raw=String(text??'');
    const at=raw.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
    const start=at<0?0:Math.max(0,at-55);
    const snippet=raw.slice(start,start+SEARCH_SNIPPET_CHARS)
        .replace(/\s+/g,' ').trim();
    return (start?'…':'')+snippet+
        (start+SEARCH_SNIPPET_CHARS<raw.length?'…':'');
}

/** Message indices remain original #0-based positions, including malformed rows. */
export function projectChatMatches(records,{query,titles=true,body=true,limit=SEARCH_MAX_PER_CHAT}={}){
    const needle=normalizeSearchQuery(query).toLocaleLowerCase();
    if(!titles&&!body)return [];
    if(!Array.isArray(records))throw new Error('채팅 데이터 형식이 올바르지 않습니다.');
    const header=records[0] && typeof records[0]==='object' && !Array.isArray(records[0]) &&
        has(records[0],'chat_metadata');
    const start=header?1:0;
    const metadata=header?records[0].chat_metadata:{};
    const result=[];
    for(let i=start;i<records.length;i++){
        const message=records[i];
        if(!message || typeof message!=='object' || Array.isArray(message))continue;
        const raw=String(message.mes??'');
        // Automatic titles have already been derived from mes by getTitle.
        const title=titles?getTitle(message,metadata):'';
        const titleHit=titles && title.toLocaleLowerCase().includes(needle);
        const bodyHit=body && raw.toLocaleLowerCase().includes(needle);
        if(!titleHit&&!bodyHit)continue;
        result.push({
            index:i-start,
            type:'message',
            field:titleHit?'title':'body',
            title:titleHit?title:getTitle(message,metadata),
            excerpt:searchExcerpt(titleHit&&!bodyHit?title:raw,query),
        });
        if(result.length>=limit)break;
    }
    return result;
}

/** Never rely on Content-Length: read and enforce the cap as bytes arrive. */
export async function readBoundedChatResponse(response,{
    signal,maxBytes=SEARCH_CHAT_BYTES,
}={}){
    if(!response?.ok)throw new Error('채팅 조회 오류 (HTTP '+(response?.status??'?')+')');
    const indicated=Number(response.headers?.get?.('content-length'));
    if(Number.isFinite(indicated) && indicated>maxBytes)
        throw new Error('서버 응답 크기 제한('+Math.ceil(maxBytes/1048576)+'MB)을 초과하여 건너뜁니다.');
    if(!response.body || typeof response.body.getReader!=='function')
        throw new Error('크기 제한을 지원하는 스트림 조회가 필요합니다.');
    const reader=response.body.getReader();
    let total=0;
    const decoder=new TextDecoder();
    let text='';
    try{
        while(true){
            if(signal?.aborted)throw new DOMException('취소됨','AbortError');
            const {done,value}=await reader.read();
            if(done)break;
            total+=value.byteLength;
            if(total>maxBytes)throw new Error('서버 응답 크기 제한('+Math.ceil(maxBytes/1048576)+'MB)을 초과하여 건너뜁니다.');
            text+=decoder.decode(value,{stream:true});
        }
        text+=decoder.decode();
    }finally{
        // A completed stream is already released; cancellation here also
        // tears down an oversized or aborted transfer.
        await reader.cancel().catch(()=>{});
        reader.releaseLock();
    }
    if(signal?.aborted)throw new DOMException('취소됨','AbortError');
    let parsed;
    try{parsed=JSON.parse(text);}
    catch{throw new Error('채팅의 JSON 응답을 읽을 수 없습니다.');}
    if(!Array.isArray(parsed))throw new Error('채팅 메시지 배열이 아닙니다.');
    return parsed;
}

export async function readChatMatches(ctx,scope,buildings,item,{
    query,titles=true,body=true,signal,fetcher=fetch,
}={}){
    normalizeSearchQuery(query);
    const target=validateChatPreviewTarget(ctx,scope,buildings,item);
    if(typeof ctx.getRequestHeaders!=='function')
        throw new Error('SillyTavern 인증 정보를 확인할 수 없습니다.');
    if(signal?.aborted)throw new DOMException('취소됨','AbortError');
    const response=await fetcher(target.endpoint,{
        method:'POST',headers:ctx.getRequestHeaders(),
        body:JSON.stringify(target.body),signal,cache:'no-store',
    });
    const records=await readBoundedChatResponse(response,{signal});
    if(signal?.aborted)throw new DOMException('취소됨','AbortError');
    if(buildingScope(ctx)!==scope)
        throw new Error('채팅 범위가 변경되어 검색 결과를 폐기했습니다.');
    return {id:cleanChatId(target.id),
        matches:projectChatMatches(records,{query,titles,body}),
    };
}


/**
 * E-03B (first pass): SillyTavern already exposes /api/chats/search.
 * It streams chat JSONL SERVER-SIDE and returns matching chat IDs, not
 * message positions. This is an explicit, read-only candidate search and
 * is separate from the exact #index scan in E-03A.
 *
 * Do not treat its results as an exact text-match or search index: server
 * matching splits whitespace and searches active mes, not custom titles or
 * every alternate swipe. In-flight HTTP abort cannot promise server abort.
 */
export const SERVER_CANDIDATE_RESPONSE_BYTES=1024*1024;
export const SERVER_CANDIDATE_MAX_ROWS=2000;
export async function searchServerBodyCandidates({
    context,scope,buildings,query,fetcher=fetch,signal,
}){
    normalizeSearchQuery(query);
    const ctx=context();
    if(buildingScope(ctx)!==scope || !Array.isArray(buildings))
        throw new Error('현재 캐릭터/그룹 범위가 변경되어 서버 검색을 중단했습니다.');
    if(typeof ctx.getRequestHeaders!=='function')
        throw new Error('SillyTavern 인증 헤더를 확인할 수 없습니다.');
    const group=ctx.groupId!==null && ctx.groupId!==undefined && ctx.groupId!=='';
    let payload={query};
    if(group){
        const item=ctx.groups?.find(row=>String(row.id)===String(ctx.groupId));
        if(!item || !Array.isArray(item.chats))
            throw new Error('현재 그룹의 채팅 목록을 확인할 수 없습니다.');
        // The upstream endpoint treats a falsy group_id as a character
        // search. Refuse the ambiguous group ID rather than scan elsewhere.
        if(!ctx.groupId || String(ctx.groupId)==='0')
            throw new Error('이 그룹 식별자는 서버 본문 검색이 지원되지 않습니다.');
        payload.group_id=ctx.groupId;
    }else{
        const character=ctx.characters?.[ctx.characterId];
        if(typeof character?.avatar!=='string' || !character.avatar)
            throw new Error('현재 캐릭터를 확인할 수 없습니다.');
        payload.avatar_url=character.avatar;
    }
    if(signal?.aborted)throw new DOMException('검색 취소','AbortError');
    const response=await fetcher('/api/chats/search',{
        method:'POST',headers:ctx.getRequestHeaders(),cache:'no-store',
        body:JSON.stringify(payload),signal,
    });
    const rows=await readBoundedChatResponse(response,{
        signal,maxBytes:SERVER_CANDIDATE_RESPONSE_BYTES,
    });
    if(signal?.aborted)throw new DOMException('검색 취소','AbortError');
    if(buildingScope(context())!==scope)
        throw new Error('서버 검색 도중 캐릭터/그룹이 변경됐습니다.');
    if(rows.length>SERVER_CANDIDATE_MAX_ROWS)
        throw new Error('서버 후보가 너무 많아 표시하지 않았습니다.');
    const allowed=new Set(buildings.map(x=>cleanChatId(x.id)));
    const groupIds=group?new Set(ctx.groups.find(x=>String(x.id)===String(ctx.groupId))
        .chats.map(cleanChatId)):null;
    const result=[],seen=new Set();
    for(const row of rows){
        if(!row || typeof row!=='object' || Array.isArray(row))continue;
        const name=row.file_name;
        if(typeof name!=='string' || name.length>206 ||
           /[/\\\u0000-\u001f\u007f]/.test(name))continue;
        const id=cleanChatId(name);
        if(!id || seen.has(id) || !allowed.has(id) ||
           (groupIds&&!groupIds.has(id)))continue;
        seen.add(id);
        result.push(id);
    }
    return result;
}
