/**
 * Q-10 bounded, current-chat message batch operations.
 * Never use virtual row numbers as stable IDs without rechecking object refs.
 * Non-destructive edits prepare fully detached snapshots BEFORE writing.
 */
import {DATA_KEY,MESSAGE_KEY,makeId,isMessageBookmarked} from './model.js';
import {buildingScope,cleanChatId} from './building-data.js';
import {parseChatJsonl,hashJsonl} from './recovery-vault.js';
import {packJsonlZip} from './file-backup-zip.js';

export const MAX_MESSAGE_SELECTION=20;
export const MESSAGE_BACKUP_BYTES=64*1024*1024;
export const MESSAGE_BATCH_OPERATIONS=Object.freeze([
    'bookmark-add','bookmark-remove','hide','show','title',
]);
const has=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const reserved=new Set(['__proto__','prototype','constructor']);

export function captureMessageSelection(ctx,indices){
    if(!ctx?.chatId || !Array.isArray(ctx.chat) || !ctx.chat.length ||
       !ctx.chatMetadata || typeof ctx.chatMetadata!=='object' ||
       !Array.isArray(indices) || !indices.length || indices.length>MAX_MESSAGE_SELECTION)
        throw new Error('현재 채팅에서 1~20개 메시지를 선택해 주세요.');
    const sorted=[...indices].sort((a,b)=>a-b);
    if(sorted.some((index,i)=>!Number.isInteger(index) || index<0 ||
       index>=ctx.chat.length || (i>0 && index===sorted[i-1]) ||
       !ctx.chat[index] || typeof ctx.chat[index]!=='object' ||
       Array.isArray(ctx.chat[index])))
        throw new Error('메시지 번호가 중복됐거나 현재 채팅 범위를 벗어났습니다.');
    const scope=buildingScope(ctx);
    if(!scope || !cleanChatId(ctx.chatId))
        throw new Error('현재 채팅 범위를 식별하지 못했습니다.');
    return {scope,chatId:cleanChatId(ctx.chatId),
        chat:ctx.chat,metadata:ctx.chatMetadata,length:ctx.chat.length,
        items:sorted.map(index=>({index,ref:ctx.chat[index]}))};
}

export function ensureSelectionCurrent(ctx,selection){
    if(!selection || !ctx || buildingScope(ctx)!==selection.scope ||
       cleanChatId(ctx.chatId)!==selection.chatId ||
       ctx.chat!==selection.chat || ctx.chatMetadata!==selection.metadata ||
       ctx.chat.length!==selection.length ||
       selection.items.some(x=>ctx.chat[x.index]!==x.ref))
        throw new Error('메시지 선택 이후 채팅이 변경됐습니다. 다시 선택해 주세요.');
    return ctx;
}

export function validateBatchTitle(value,count){
    if(typeof value!=='string' || !value.trim() || value!==value.trim() ||
       /[\u0000-\u001f\u007f]/.test(value) ||
       value.length+String(count).length+1>300)
        throw new Error('공통 제목을 입력해 주세요. 번호를 포함해 300자 이하여야 합니다.');
    return value;
}
function batchUniqueId(chat,index,store,idFactory){
    const previous=chat[index][MESSAGE_KEY];
    if(typeof previous==='string' && previous.length>0 && previous.length<=200 &&
       !reserved.has(previous) && !chat.some((m,i)=>i!==index && m?.[MESSAGE_KEY]===previous))
        return {id:previous,split:false};
    for(let attempt=0;attempt<16;attempt++){
        const id=idFactory();
        if(typeof id!=='string' || !id || id.length>200 || reserved.has(id) ||
           chat.some(x=>x?.[MESSAGE_KEY]===id))continue;
        if(typeof previous==='string' && previous && !reserved.has(previous)){
            for(const key of ['titles','bookmarks','swipeAnnotations']){
                const original=store[key]?.[previous];
                if(original!==undefined){
                    if(!store[key] || typeof store[key]!=='object' || Array.isArray(store[key]))
                        throw new Error('메시지 관리 데이터가 손상되어 변경할 수 없습니다.');
                    store[key][id]=structuredClone(original);
                }
            }
        }
        return {id,split:true};
    }
    throw new Error('고유한 메시지 식별자를 만들지 못했습니다.');
}

export function prepareMessageBatch(ctx,selection,{operation,baseTitle='',idFactory=makeId}={}){
    ensureSelectionCurrent(ctx,selection);
    if(!MESSAGE_BATCH_OPERATIONS.includes(operation))
        throw new Error('지원되지 않는 메시지 일괄 편집입니다.');
    if(operation==='title')validateBatchTitle(baseTitle,selection.items.length);
    if(ctx.chatMetadata[DATA_KEY]!==undefined &&
       (!ctx.chatMetadata[DATA_KEY] || typeof ctx.chatMetadata[DATA_KEY]!=='object' ||
        Array.isArray(ctx.chatMetadata[DATA_KEY])))
        throw new Error('메시지 제목 저장소가 손상됐습니다.');
    const working=ctx.chat.slice();
    const store=ctx.chatMetadata[DATA_KEY]===undefined
        ?{schema:1,titles:Object.create(null)}
        :structuredClone(ctx.chatMetadata[DATA_KEY]);
    let changed=0;
    for(let number=0;number<selection.items.length;number++){
        const {index}=selection.items[number];
        const msg={...working[index]};
        const marked=isMessageBookmarked(msg,{[DATA_KEY]:store});
        const desired=operation==='bookmark-add'?true:operation==='bookmark-remove'?false:null;
        if(desired!==null && marked===desired)continue;
        if(operation==='hide' && msg.is_system===true)continue;
        if(operation==='show' && msg.is_system!==true)continue;
        working[index]=msg;
        if(operation==='hide')msg.is_system=true;
        else if(operation==='show')msg.is_system=false;
        else {
            const {id}=batchUniqueId(working,index,store,idFactory);
            msg[MESSAGE_KEY]=id;
            if(operation==='title'){
                if(!store.titles || typeof store.titles!=='object' || Array.isArray(store.titles))
                    throw new Error('메시지 제목 목록이 손상됐습니다.');
                store.titles[id]=baseTitle+' '+(number+1);
            }else{
                if(!store.bookmarks || typeof store.bookmarks!=='object' || Array.isArray(store.bookmarks))
                    store.bookmarks=Object.create(null);
                if(desired)store.bookmarks[id]=true;
                else delete store.bookmarks[id];
            }
        }
        changed++;
    }
    return {selection,operation,items:selection.items.map(({index})=>({
        index,original:ctx.chat[index],next:working[index],
    })),store,changed};
}

export async function commitMessageBatch(context,plan){
    const ctx=ensureSelectionCurrent(context(),plan.selection);
    if(typeof ctx.saveMetadata!=='function')
        throw new Error('SillyTavern의 메시지 저장 함수를 사용할 수 없습니다.');
    if(!plan.changed)return {changed:0};
    const originalStore=ctx.chatMetadata[DATA_KEY];
    const originals=plan.items.map(({index,original,next})=>({
        index,original,next,
        oldId:original[MESSAGE_KEY],oldHasId:has(original,MESSAGE_KEY),
        oldHidden:original.is_system,oldHasHidden:has(original,'is_system'),
    }));
    let saved=false;
    try{
        ctx.chatMetadata[DATA_KEY]=plan.store;
        for(const item of originals){
            if(item.original===item.next)continue;
            if(has(item.next,MESSAGE_KEY))item.original[MESSAGE_KEY]=item.next[MESSAGE_KEY];
            if(plan.operation==='hide' || plan.operation==='show')
                item.original.is_system=item.next.is_system;
        }
        await ctx.saveMetadata();
        saved=true;
        ensureSelectionCurrent(context(),plan.selection);
        if(plan.operation==='hide' || plan.operation==='show'){
            for(const item of originals){
                if(item.original===item.next)continue;
                const row=document.querySelector('#chat > .mes[mesid="'+item.index+'"]');
                if(row)row.setAttribute('is_system',String(item.original.is_system===true));
                try{ctx.updateMessageBlock?.(item.index,item.original);}catch {/* viewport may be virtualized */}
            }
        }
        return {changed:plan.changed};
    }catch(error){
        if(!saved && context().chat===plan.selection.chat &&
           context().chatId===plan.selection.chatId &&
           context().chatMetadata===plan.selection.metadata){
            if(originalStore===undefined)delete ctx.chatMetadata[DATA_KEY];
            else ctx.chatMetadata[DATA_KEY]=originalStore;
            for(const item of originals){
                if(item.original===item.next)continue;
                if(item.oldHasId)item.original[MESSAGE_KEY]=item.oldId;
                else delete item.original[MESSAGE_KEY];
                if(item.oldHasHidden)item.original.is_system=item.oldHidden;
                else delete item.original.is_system;
            }
        }
        throw error;
    }
}

/** Read raw server JSONL before deletion; never rely on a local-only export. */
export async function readCurrentRaw(ctx,{fetcher=fetch,signal}={}){
    const isGroup=ctx.groupId!==null && ctx.groupId!==undefined && ctx.groupId!=='';
    const character=ctx.characters?.[ctx.characterId];
    if(!isGroup && !character?.avatar)
        throw new Error('캐릭터의 원본 채팅 파일을 식별하지 못했습니다.');
    if(typeof ctx.getRequestHeaders!=='function')
        throw new Error('SillyTavern 인증 헤더가 없습니다.');
    const id=cleanChatId(ctx.chatId);
    if(!id)throw new Error('현재 채팅 파일을 식별하지 못했습니다.');
    const response=await fetcher('/api/chats/export',{
        method:'POST',headers:ctx.getRequestHeaders(),signal,cache:'no-store',
        body:JSON.stringify({
            is_group:isGroup,avatar_url:isGroup?null:character.avatar,
            file:id+'.jsonl',exportfilename:id+'.jsonl',format:'jsonl',
        }),
    });
    if(!response.ok)throw new Error('원본 내보내기 오류 HTTP '+response.status);
    if(Number(response.headers?.get?.('content-length'))>MESSAGE_BACKUP_BYTES*2)
        throw new Error('백업 응답 크기가 안전 제한을 초과했습니다.');
    if(!response.body?.getReader)throw new Error('스트리밍 백업 응답을 지원하지 않습니다.');
    const reader=response.body.getReader(),decoder=new TextDecoder();
    let text='',total=0;
    try{
        while(true){
            if(signal?.aborted)throw new DOMException('백업 취소','AbortError');
            const {done,value}=await reader.read();
            if(done)break;
            total+=value.byteLength;
            if(total>MESSAGE_BACKUP_BYTES*2)throw new Error('백업 응답이 너무 큽니다.');
            text+=decoder.decode(value,{stream:true});
        }
        text+=decoder.decode();
    }finally{
        await reader.cancel().catch(()=>{});
        reader.releaseLock();
    }
    let json;
    try{json=JSON.parse(text);}catch{throw new Error('원본 JSONL 응답을 해석할 수 없습니다.');}
    const raw=json?.result;
    if(typeof raw!=='string' || new TextEncoder().encode(raw).byteLength>MESSAGE_BACKUP_BYTES)
        throw new Error('64MB를 넘는 채팅은 일괄 삭제를 지원하지 않습니다.');
    return raw;
}
export function matchesCurrentChatSnapshot(raw,chat){
    const parsed=parseChatJsonl(raw);
    return Array.isArray(chat) && parsed.length===chat.length+1 &&
        parsed.slice(1).every((msg,i)=>JSON.stringify(msg)===JSON.stringify(chat[i]));
}

export async function prepareDeletionBackup(context,selection,{fetcher=fetch,signal}={}){
    const ctx=ensureSelectionCurrent(context(),selection);
    if(typeof ctx.saveChat!=='function' || typeof ctx.deleteMessage!=='function')
        throw new Error('SillyTavern의 저장·메시지 삭제 함수를 지원하지 않습니다.');
    const saved=await ctx.saveChat();
    if(saved===false)throw new Error('채팅 저장에 실패했습니다.');
    ensureSelectionCurrent(context(),selection);
    const raw=await readCurrentRaw(ctx,{fetcher,signal});
    ensureSelectionCurrent(context(),selection);
    if(!matchesCurrentChatSnapshot(raw,ctx.chat))
        throw new Error('서버 백업과 화면의 대화 기록이 다릅니다. 삭제를 차단했습니다.');
    const hash=await hashJsonl(raw);
    const blob=packJsonlZip([{name:selection.chatId+'.jsonl',text:raw}]);
    return {raw,hash,blob,selection};
}

export async function deleteMessageSelection(context,backup,{
    fetcher=fetch,
    ensureRendered=async()=>true,
}={}){
    const {selection,raw,hash}=backup;
    const ctx=ensureSelectionCurrent(context(),selection);
    if(typeof ctx.deleteMessage!=='function' || typeof ctx.saveChat!=='function')
        throw new Error('SillyTavern 메시지 삭제 기능이 없습니다.');
    // Re-read source, reject external changes BEFORE first deletion.
    const fresh=await readCurrentRaw(ctx,{fetcher});
    ensureSelectionCurrent(context(),selection);
    if(await hashJsonl(fresh)!==hash || !matchesCurrentChatSnapshot(fresh,ctx.chat))
        throw new Error('백업 후 채팅 원본이 변경됐습니다. 삭제를 시작하지 않았습니다.');
    const order=selection.items.map(x=>x.index).sort((a,b)=>b-a);
    // All targets must be renderable by ST's native delete API before any
    // deletion. Reject missing/virtualized rows rather than silently skip.
    for(const index of order){
        const ready=await ensureRendered(index,ctx);
        ensureSelectionCurrent(context(),selection);
        if(!ready || !document.querySelector('#chat > .mes[mesid="'+index+'"]'))
            throw new Error('#'+index+' 메시지를 화면에 불러올 수 없어 삭제하지 않았습니다.');
    }
    const originalLength=ctx.chat.length;
    let completed=0;
    try{
        for(const index of order){
            if(buildingScope(context())!==selection.scope ||
               cleanChatId(context().chatId)!==selection.chatId ||
               context().chat!==selection.chat)
                throw new Error('삭제 도중 현재 채팅이 변경됐습니다.');
            if(ctx.chat[index]!==selection.items.find(x=>x.index===index).ref)
                throw new Error('삭제 대상이 변경되어 중단했습니다.');
            const before=ctx.chat.length;
            // false: do not delete adjacent tool-call messages implicitly.
            await ctx.deleteMessage(index,undefined,false,false);
            if(ctx.chat.length!==before-1)
                throw new Error('#'+index+' 메시지 삭제 결과가 예상과 다릅니다.');
            completed++;
        }
        await ctx.saveChat();
        const after=await readCurrentRaw(ctx,{fetcher});
        if(!matchesCurrentChatSnapshot(after,ctx.chat))
            throw new Error('삭제한 내용이 서버에 저장됐는지 확인하지 못했습니다.');
        if(ctx.chat.length!==originalLength-order.length)
            throw new Error('삭제 후 메시지 수가 예상과 다릅니다.');
        return {deleted:completed};
    }catch(error){
        throw new Error('일괄 삭제 '+completed+'/'+order.length+'개 처리 후 확인이 필요합니다: '+
            error.message+' 다운로드한 원본 ZIP을 보관하고 현재 채팅을 점검해 주세요.');
    }
}
