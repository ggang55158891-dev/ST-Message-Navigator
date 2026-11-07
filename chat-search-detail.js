/**
 * E-03C: one *explicitly selected* chat, exact original #message positions,
 * including inactive swipes and custom titles. Does not build a persistent
 * index, save raw text, or silently scan other chats. Server JSONL export
 * remains bounded to a maximum 32MB HTTP response.
 */
import {buildingScope,cleanChatId} from './building-data.js';
import {validateChatPreviewTarget} from './chat-preview.js';
import {
    normalizeSearchQuery,matchSearchMessage,readBoundedResponseText,
    SEARCH_MAX_RESULTS,
} from './chat-search.js';
import {parseChatJsonl} from './recovery-vault.js';

export const DETAILED_SEARCH_RESPONSE_BYTES=32*1024*1024;
export const DETAILED_SEARCH_YIELD_EVERY=256;
export const DETAILED_SEARCH_MAX_ROWS=150000;

function abortGuard(signal,stillValid){
    if(signal?.aborted || (stillValid && !stillValid()))
        throw new DOMException('정밀 검색이 취소됐거나 채팅이 변경됐습니다.','AbortError');
}

/** Yield after bounded chunks so the cancel button can interrupt scanning. */
export async function projectDetailedChatMatches(records,{
    query,titles=true,body=true,swipes=true,signal,stillValid,
    limit=SEARCH_MAX_RESULTS,yieldEvery=DETAILED_SEARCH_YIELD_EVERY,
}={}){
    const needle=normalizeSearchQuery(query).toLocaleLowerCase();
    if(!titles&&!body&&!swipes)
        throw new Error('검색할 메시지 항목을 하나 이상 선택해 주세요.');
    if(!Array.isArray(records)||records.length>DETAILED_SEARCH_MAX_ROWS+1)
        throw new Error('정밀 검색 메시지 개수(15만 개) 제한을 초과했습니다.');
    if(!Number.isInteger(limit)||limit<1||limit>SEARCH_MAX_RESULTS ||
       !Number.isInteger(yieldEvery)||yieldEvery<1||yieldEvery>2000)
        throw new Error('정밀 검색 작업 제한이 올바르지 않습니다.');
    const header=records[0] && typeof records[0]==='object' && !Array.isArray(records[0]) &&
        Object.prototype.hasOwnProperty.call(records[0],'chat_metadata');
    const start=header?1:0,metadata=header?records[0].chat_metadata:{};
    const matches=[];
    let truncated=false,scanned=0;
    abortGuard(signal,stillValid);
    for(let index=start;index<records.length;index++){
        if(scanned>0 && scanned%yieldEvery===0){
            await new Promise(resolve=>setTimeout(resolve,0));
            abortGuard(signal,stillValid);
        }
        const match=matchSearchMessage(records[index],metadata,{
            query,needle,titles,body,swipes,
        });
        scanned++;
        if(match){
            if(matches.length>=limit){truncated=true;break;}
            matches.push({...match,index:index-start});
        }
    }
    abortGuard(signal,stillValid);
    return {matches,truncated,scanned,total:records.length-start};
}

export async function readDetailedChatMatches({
    context,scope,buildings,item,query,
    titles=true,body=true,swipes=true,signal,fetcher=fetch,
    currentProjector,
}={}){
    const ctx=context();
    normalizeSearchQuery(query);
    const target=validateChatPreviewTarget(ctx,scope,buildings,item);
    // An upstream building listing is still untrusted data. Explicitly
    // reject unsafe transport names before passing them to the export API.
    if(typeof target.id!=='string' || !target.id ||
       target.id.length>200 || /[/\\\u0000-\u001f\u007f]/.test(target.id) ||
       target.id==='.' || target.id==='..')
        throw new Error('정밀 검색 채팅 파일명이 안전하지 않습니다.');
    const chatRef=ctx.chat,activeId=cleanChatId(ctx.chatId);
    const current=activeId===cleanChatId(target.id);
    const stillValid=()=>{
        const latest=context();
        if(buildingScope(latest)!==scope || latest.chat!==chatRef ||
           cleanChatId(latest.chatId)!==activeId ||
           latest.chatMetadata!==ctx.chatMetadata)return false;
        try{
            return validateChatPreviewTarget(latest,scope,buildings,item).id===target.id;
        }catch{return false;}
    };
    abortGuard(signal,stillValid);
    let records;
    if(current){
        if(!Array.isArray(chatRef))throw new Error('현재 열려 있는 채팅 기록이 없습니다.');
        // Reuse the bounded active-chat index only for an explicitly selected
        // current file; inactive files keep their validated server path.
        if(typeof currentProjector==='function'){
            const result=await currentProjector(chatRef,ctx.chatMetadata||{},{
                query,titles,body,swipes,signal,stillValid,
                limit:SEARCH_MAX_RESULTS,
            });
            abortGuard(signal,stillValid);
            return {id:target.id,source:'current-memory',...result};
        }
        records=[{chat_metadata:ctx.chatMetadata||{}},...chatRef];
    }else{
        if(typeof ctx.getRequestHeaders!=='function')
            throw new Error('SillyTavern 인증 헤더를 확인할 수 없습니다.');
        const group=ctx.groupId!==null && ctx.groupId!==undefined && ctx.groupId!=='';
        const character=ctx.characters?.[ctx.characterId];
        const response=await fetcher('/api/chats/export',{
            method:'POST',headers:ctx.getRequestHeaders(),cache:'no-store',
            body:JSON.stringify({
                is_group:group,avatar_url:group?null:character.avatar,
                file:target.id+'.jsonl',exportfilename:target.id+'.jsonl',
                format:'jsonl',
            }),signal,
        });
        const text=await readBoundedResponseText(response,{
            signal,maxBytes:DETAILED_SEARCH_RESPONSE_BYTES,
        });
        abortGuard(signal,stillValid);
        let data;
        try{data=JSON.parse(text);}
        catch{throw new Error('채팅 원본 내보내기 응답 JSON을 읽지 못했습니다.');}
        if(typeof data?.result!=='string')
            throw new Error('채팅 원본 JSONL 데이터가 없습니다.');
        records=parseChatJsonl(data.result);
    }
    abortGuard(signal,stillValid);
    const result=await projectDetailedChatMatches(records,{
        query,titles,body,swipes,signal,stillValid,
    });
    // Do not return/retain complete raw JSONL or message objects.
    return {id:target.id,source:current?'current-memory':'server-jsonl',...result};
}
