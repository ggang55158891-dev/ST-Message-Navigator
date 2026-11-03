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
        throw new Error('6MB 제한을 초과한 채팅은 건너뜁니다.');
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
            if(total>maxBytes)throw new Error('6MB 제한을 초과한 채팅은 건너뜁니다.');
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
