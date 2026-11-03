/** Q-07A read-only, explicit multi-chat backup adapter. */
import {buildingScope,cleanChatId} from './building-data.js';
import {packJsonlZip} from './file-backup-zip.js';

export const MAX_BACKUP_CHATS=20;
export const MAX_BACKUP_BYTES=64*1024*1024;
const INVALID=/[/\\\0\r\n]/;

export function validateBackupSelection(ctx,scope,buildings,ids){
    if(!ctx || !scope || buildingScope(ctx)!==scope ||
       !Array.isArray(buildings) || !Array.isArray(ids) ||
       !ids.length || ids.length>MAX_BACKUP_CHATS) {
        throw new Error('현재 채팅 범위 또는 백업 선택이 올바르지 않습니다. (최대 20개)');
    }
    const known=new Set(buildings.map(x=>cleanChatId(x.id)));
    const clean=[];
    for(const raw of ids){
        const id=cleanChatId(raw);
        if(typeof raw!=='string' || !id || id.length>190 ||
           INVALID.test(id) || raw!==id || id.startsWith('.') ||
           !known.has(id) || clean.includes(id)) {
            throw new Error('현재 채팅 목록에 없는 파일 또는 중복된 파일이 포함되어 있습니다.');
        }
        clean.push(id);
    }
    const isGroup=ctx.groupId!=null && ctx.groupId!=='';
    if(isGroup){
        const group=ctx.groups?.find(x=>String(x.id)===String(ctx.groupId));
        if(!Array.isArray(group?.chats) ||
           clean.some(id=>!group.chats.some(x=>cleanChatId(x)===id))) {
            throw new Error('현재 그룹에 소속되지 않은 채팅은 백업할 수 없습니다.');
        }
        return {isGroup,avatar:null,ids:clean};
    }
    const character=ctx.characters?.[ctx.characterId];
    if(!character?.avatar || typeof character.avatar!=='string') {
        throw new Error('선택한 캐릭터의 아바타 정보를 찾을 수 없습니다.');
    }
    return {isGroup:false,avatar:character.avatar,ids:clean};
}

export async function exportSelectedChats({
    context,scope,buildings,ids,fetcher=fetch,signal,onProgress=()=>{},
}){
    const ctx=context();
    const target=validateBackupSelection(ctx,scope,buildings,ids);
    if(typeof ctx.getRequestHeaders!=='function'){
        throw new Error('SillyTavern 인증 헤더를 사용할 수 없습니다.');
    }
    const savedChat=ctx.chat;
    const savedChatId=ctx.chatId;
    // Snapshotting the active chat without its latest save can produce a
    // misleading archive; ask ST to flush its pending data first.
    if(target.ids.includes(cleanChatId(savedChatId))) {
        if(typeof ctx.saveChat!=='function')
            throw new Error('현재 열려 있는 채팅을 저장할 수 없습니다. 먼저 SillyTavern에서 저장해 주세요.');
        const result=await ctx.saveChat();
        if(result===false)throw new Error('현재 채팅 저장이 완료되지 않았습니다.');
    }
    const check=()=>{
        if(signal?.aborted)throw new Error('백업이 취소되었습니다.');
        const now=context();
        if(buildingScope(now)!==scope || now.chat!==savedChat || now.chatId!==savedChatId)
            throw new Error('백업 도중 채팅 대상이 변경되어 작업을 중단했습니다.');
    };
    check();
    const files=[];
    let approximateBytes=0;
    for(let index=0;index<target.ids.length;index++){
        check();
        const id=target.ids[index];
        onProgress({completed:index,total:target.ids.length,name:id});
        const response=await fetcher('/api/chats/export',{
            method:'POST',
            headers:ctx.getRequestHeaders(),
            cache:'no-store',signal,
            body:JSON.stringify({
                is_group:target.isGroup,
                avatar_url:target.avatar,
                file:id+'.jsonl',
                exportfilename:id+'.jsonl',
                format:'jsonl',
            }),
        });
        if(!response.ok)throw new Error('채팅 "'+id+'" 백업 실패 (HTTP '+response.status+')');
        const data=await response.json();
        if(typeof data?.result!=='string' || !data.result.trim())
            throw new Error('채팅 "'+id+'"에서 유효한 원본 JSONL을 받지 못했습니다.');
        approximateBytes+=new TextEncoder().encode(data.result).byteLength;
        if(approximateBytes>MAX_BACKUP_BYTES)
            throw new Error('전체 백업이 64MB를 초과했습니다. 채팅을 나눠서 백업해 주세요.');
        check();
        files.push({name:id+'.jsonl',text:data.result});
    }
    check();
    const blob=packJsonlZip(files);
    onProgress({completed:target.ids.length,total:target.ids.length,name:''});
    return {blob,count:files.length,bytes:blob.size};
}

export function downloadBackupBlob(blob,filename){
    if(!(blob instanceof Blob) || blob.size===0)
        throw new Error('다운로드할 백업 파일이 없습니다.');
    const url=URL.createObjectURL(blob);
    try {
        const link=document.createElement('a');
        link.href=url;link.download=filename;
        document.body.append(link);
        link.click();link.remove();
    } finally {
        // Allow browsers a chance to retain the download reference.
        setTimeout(()=>URL.revokeObjectURL(url),6000);
    }
}
