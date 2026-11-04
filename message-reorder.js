/**
 * Q-11: message order is a permutation of existing message objects, not new
 * message IDs, text edits, or a reserialization of individual swipes.
 *
 * Preview mode never mutates ST. Applying requires a verified JSONL ZIP
 * snapshot, exact server content comparison, a single native ST chat save,
 * and a fresh server readback before the native chat renderer is reloaded.
 */
import {buildingScope,cleanChatId} from './building-data.js';
import {
    readCurrentRaw,matchesCurrentChatSnapshot,MESSAGE_BACKUP_BYTES,
} from './message-batch.js';
import {parseChatJsonl,hashJsonl} from './recovery-vault.js';
import {packJsonlZip} from './file-backup-zip.js';

export const MAX_REORDER_ITEMS=100000;

export function captureReorderSource(ctx){
    if(!ctx?.chatId || !Array.isArray(ctx.chat) || ctx.chat.length<2 ||
       ctx.chat.length>MAX_REORDER_ITEMS || !ctx.chatMetadata ||
       typeof ctx.chatMetadata!=='object')
        throw new Error('순서 변경은 메시지 2~100,000개가 있는 저장된 채팅에서 사용할 수 있습니다.');
    if(ctx.chat.some(m=>!m || typeof m!=='object' || Array.isArray(m)))
        throw new Error('일부 메시지 구조가 올바르지 않아 재배열을 중단했습니다.');
    const scope=buildingScope(ctx);
    if(!scope)throw new Error('캐릭터/그룹 범위를 확인할 수 없습니다.');
    return {scope,id:cleanChatId(ctx.chatId),chat:ctx.chat,
        metadata:ctx.chatMetadata,messages:ctx.chat.slice()};
}

export function verifyReorderSource(ctx,source){
    if(!ctx || !source || buildingScope(ctx)!==source.scope ||
       cleanChatId(ctx.chatId)!==source.id || ctx.chat!==source.chat ||
       ctx.chatMetadata!==source.metadata || ctx.chat.length!==source.messages.length ||
       source.messages.some((msg,i)=>ctx.chat[i]!==msg))
        throw new Error('순서 변경 모드를 시작한 뒤 채팅 내용이나 메시지 위치가 바뀌었습니다.');
    return ctx;
}

export function validateReorderOrder(order,length){
    if(!Array.isArray(order) || order.length!==length ||
       length<2 || length>MAX_REORDER_ITEMS)
        throw new Error('새 메시지 순서가 올바르지 않습니다.');
    const seen=new Uint8Array(length);
    for(const index of order){
        if(!Number.isInteger(index) || index<0 || index>=length || seen[index])
            throw new Error('누락 또는 중복된 메시지가 있는 순서는 적용할 수 없습니다.');
        seen[index]=1;
    }
    return order;
}

/** Source/target are positions in the PREVIEW, not ST's saved #IDs. */
export function moveReorderItem(order,from,to){
    validateReorderOrder(order,order.length);
    if(!Number.isInteger(from) || !Number.isInteger(to) ||
       from<0 || to<0 || from>=order.length || to>=order.length)
        throw new Error('메시지 이동할 위치가 올바르지 않습니다.');
    if(from===to)return order;
    const next=order.slice(),[item]=next.splice(from,1);
    next.splice(to,0,item);
    return next;
}
export function reorderedCount(order){
    return order.reduce((count,id,i)=>count+(id!==i?1:0),0);
}

/** Verify the entire saved sequence against ORIGINAL pre-change JSONL. */
export function serverMatchesReorderedBackup(beforeRaw,afterRaw,order){
    validateReorderOrder(order,order.length);
    const before=parseChatJsonl(beforeRaw),after=parseChatJsonl(afterRaw);
    if(before.length!==order.length+1 || after.length!==before.length)return false;
    for(let i=0;i<order.length;i++){
        if(JSON.stringify(before[order[i]+1])!==JSON.stringify(after[i+1]))return false;
    }
    return true;
}

export async function prepareReorderBackup(context,source,{fetcher=fetch}={}){
    const ctx=verifyReorderSource(context(),source);
    if(typeof ctx.saveChat!=='function' || typeof ctx.reloadCurrentChat!=='function')
        throw new Error('이 SillyTavern 버전에는 저장·채팅 재로드 기능이 없습니다.');
    const result=await ctx.saveChat();
    if(result===false)throw new Error('현재 채팅을 서버에 저장하지 못했습니다.');
    verifyReorderSource(context(),source);
    const raw=await readCurrentRaw(ctx,{fetcher});
    verifyReorderSource(context(),source);
    if(!matchesCurrentChatSnapshot(raw,ctx.chat))
        throw new Error('서버 원본과 현재 메시지 내용이 달라 백업을 중단했습니다.');
    const hash=await hashJsonl(raw);
    const blob=packJsonlZip([{name:source.id+'.jsonl',text:raw}]);
    if(!blob.size || blob.size>MESSAGE_BACKUP_BYTES)
        throw new Error('백업 ZIP이 안전한 크기 제한을 초과했습니다.');
    return {source,raw,hash,blob};
}

/**
 * Only called after a user explicitly confirms downloading the ZIP.
 * The in-memory array retains its identity, so other ST references to "chat"
 * continue to point at the same chat; messages are moved by object identity.
 *
 * Because ST's saveChatConditional catches some server errors internally,
 * successful promise resolution alone is never treated as a verified save.
 */
export async function applyReorder(context,backup,order,{fetcher=fetch}={}){
    if(!backup?.source || typeof backup.raw!=='string' ||
       typeof backup.hash!=='string')
        throw new Error('검증된 원본 채팅 백업이 없습니다.');
    const source=backup.source,ctx=verifyReorderSource(context(),source);
    validateReorderOrder(order,source.messages.length);
    if(!reorderedCount(order))return {changed:false,reloaded:false};
    if(typeof ctx.saveChat!=='function' || typeof ctx.reloadCurrentChat!=='function')
        throw new Error('SillyTavern 저장·재로드 기능이 없어 변경할 수 없습니다.');
    const fresh=await readCurrentRaw(ctx,{fetcher});
    verifyReorderSource(context(),source);
    if(await hashJsonl(fresh)!==backup.hash ||
       !matchesCurrentChatSnapshot(fresh,ctx.chat))
        throw new Error('백업 이후 원본 채팅이 변경되어 순서 변경을 차단했습니다.');
    const desired=order.map(i=>source.messages[i]);
    const metadata=ctx.chatMetadata;
    const oldTainted=metadata.tainted;
    const hadTainted=Object.prototype.hasOwnProperty.call(metadata,'tainted');
    let attempted=false;
    try{
        // These assignments happen only AFTER backup + scope/permutation/hash
        // validation, and are intentionally in-place (same chat array).
        for(let i=0;i<desired.length;i++)ctx.chat[i]=desired[i];
        metadata.tainted=true;
        attempted=true;
        const saved=await ctx.saveChat();
        if(saved===false)throw new Error('SillyTavern이 저장 실패를 반환했습니다.');
        const now=context();
        if(buildingScope(now)!==source.scope || cleanChatId(now.chatId)!==source.id ||
           now.chat!==source.chat || now.chatMetadata!==source.metadata ||
           now.chat.length!==desired.length ||
           desired.some((msg,i)=>now.chat[i]!==msg))
            throw new Error('저장 도중 다른 채팅이나 메시지가 변경됐습니다.');
        const result=await readCurrentRaw(now,{fetcher});
        if(!serverMatchesReorderedBackup(backup.raw,result,order))
            throw new Error('서버 파일의 메시지 순서·내용 재검증에 실패했습니다.');
    }catch(error){
        if(!attempted && ctx.chat===source.chat &&
           ctx.chatMetadata===source.metadata){
            for(let i=0;i<source.messages.length;i++)ctx.chat[i]=source.messages[i];
            if(hadTainted)metadata.tainted=oldTainted;
            else delete metadata.tainted;
        }
        // NEVER overwrite the server with an optimistic rollback after a
        // write was attempted; its true state may be different/uncertain.
        throw new Error('순서 변경 저장을 확정할 수 없습니다: '+error.message+
            ' 원본 ZIP을 보관하고 채팅을 다시 불러와 실제 내용을 확인하세요.');
    }
    // Saving IS verified now. A failed reload is a UI sync issue, not a
    // failed disk write; communicate the two statuses separately.
    try{
        await ctx.reloadCurrentChat();
        return {changed:true,reloaded:true,count:order.length};
    }catch(error){
        return {changed:true,reloaded:false,count:order.length,
            warning:'서버 저장은 검증했지만 화면 재로드에 실패했습니다: '+error.message};
    }
}
