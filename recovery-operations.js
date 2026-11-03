/**
 * Q-07C archive/restore coordinator.
 * Destructive calls remain in file-operations.js (with its existing group
 * rollback). No deletion/rename starts before read + verified IDB commit.
 * Restores ALWAYS create a new, unpredictable filename: never overwrite an
 * existing chat or silently undo an unrelated newer edit.
 */
import {buildingScope,cleanChatId} from './building-data.js';
import {chatReference,emptyLibrary,validateLibrary} from './library-data.js';
import {moveLibraryReference} from './library-operations.js';
import {validateFilePlan,validateNewChatName} from './file-operations.js';
import {hashJsonl,parseChatJsonl,sameChatJsonl} from './recovery-vault.js';
import {packJsonlZip} from './file-backup-zip.js';

function storageSnapshot(library,scope,id){
    const safe=validateLibrary(library);
    const record=safe.records[chatReference(scope,id)];
    if(!record)return null;
    const scoped=emptyLibrary();
    scoped.records[chatReference(scope,id)]=structuredClone(record);
    if(record.folderId) {
        const folder=safe.folders.find(f=>f.id===record.folderId);
        if(folder)scoped.folders.push({...folder});
    }
    for(const tagId of record.tagIds) {
        const tag=safe.tags.find(t=>t.id===tagId);
        if(tag)scoped.tags.push({...tag});
    }
    return validateLibrary(scoped);
}

async function getRaw(ctx,{isGroup,avatar,id},fetcher=fetch){
    const response=await fetcher('/api/chats/export',{
        method:'POST',headers:ctx.getRequestHeaders(),
        cache:'no-store',
        body:JSON.stringify({
            is_group:isGroup,avatar_url:avatar,
            file:id+'.jsonl',exportfilename:id+'.jsonl',format:'jsonl',
        }),
    });
    if(response.status===404)return null;
    if(!response.ok)throw new Error('채팅 파일 확인에 실패했습니다 (HTTP '+response.status+').');
    const data=await response.json();
    if(typeof data?.result!=='string')throw new Error('채팅 서버가 원본 JSONL을 반환하지 않았습니다.');
    parseChatJsonl(data.result);
    return data.result;
}
async function post(ctx,url,body,fetcher=fetch) {
    const response=await fetcher(url,{
        method:'POST',headers:ctx.getRequestHeaders(),
        cache:'no-store',body:JSON.stringify(body),
    });
    if(!response.ok)throw new Error('서버 요청 실패: '+url+' HTTP '+response.status);
    const result=await response.json();
    if(result?.ok!==true)throw new Error('서버 작업 성공을 확인할 수 없습니다: '+url);
    return result;
}

export async function archiveBeforeAction({vault,context,scope,buildings,id,kind,library,fetcher=fetch}){
    const ctx=context();
    const plan=validateFilePlan(ctx,scope,buildings,id,kind);
    if(typeof ctx.getRequestHeaders!=='function')
        throw new Error('SillyTavern 인증 헤더를 사용할 수 없습니다.');
    const chatRef=ctx.chat,activeId=ctx.chatId;
    const raw=await getRaw(ctx,{...plan,id:plan.source},fetcher);
    if(raw===null)throw new Error('원본 파일을 찾지 못했습니다. 작업을 취소합니다.');
    const latest=context();
    if(buildingScope(latest)!==scope || latest.chat!==chatRef ||
       latest.chatId!==activeId)throw new Error('보관 도중 채팅이 바뀌었습니다. 작업을 취소합니다.');
    const record=storageSnapshot(library,scope,id);
    return vault.store({
        scope,name:plan.source,raw,isGroup:plan.isGroup,
        avatar:plan.avatar,groupId:plan.isGroup?ctx.groupId:null,
        action:kind,librarySnapshot:record,
    });
}

export async function confirmActionResult({
    context,record,result,fetcher=fetch,
}){
    // Actual server response is not sufficient proof: independently verify
    // the new file content and absence of the old file.
    const ctx=context();
    if(buildingScope(ctx)!==record.scope)
        throw new Error('작업 중 캐릭터 또는 그룹이 바뀌어 결과 확인이 불가능합니다.');
    const source={isGroup:record.isGroup,avatar:record.avatar,id:record.name};
    if(record.action==='delete') {
        if(await getRaw(ctx,source,fetcher)!==null)
            throw new Error('서버에서 삭제된 파일이 여전히 확인됩니다. 자동 보관함을 유지합니다.');
        return true;
    }
    const newName=result?.newId;
    if(!newName)throw new Error('이름 변경 결과에 새 이름이 없습니다.');
    const renamed=await getRaw(ctx,{...source,id:newName},fetcher);
    if(renamed===null)throw new Error('이름 변경 후 파일을 찾을 수 없습니다.');
    if(await hashJsonl(renamed)!==record.hash)
        throw new Error('이름 변경 후 원본과 바뀐 파일 내용이 다릅니다.');
    if(await getRaw(ctx,source,fetcher)!==null)
        throw new Error('이름 변경 후 이전 파일도 남아 있어 확인이 필요합니다.');
    return true;
}

export function recoveredFilename(original,now=Date.now(),random=()=>{
    const bytes=crypto.getRandomValues(new Uint8Array(4));
    return [...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');
}){
    const stamp=new Date(now).toISOString().replace(/[-:]/g,'').slice(0,15).replace('T','-');
    const suffix=' - restored-'+stamp+'-'+random();
    const name=original.slice(0,120-suffix.length)+suffix;
    return validateNewChatName(name);
}

export async function restoreFromVault({
    vault,context,archiveId,libraryRepository,fetcher=fetch,
}){
    const {meta,raw}=await vault.read(archiveId);
    const ctx=context();
    if(buildingScope(ctx)!==meta.scope ||
        (meta.isGroup && String(ctx.groupId)!==meta.groupId))
        throw new Error('복구할 채팅의 원래 캐릭터 또는 그룹을 먼저 선택해 주세요.');
    const startChat=ctx.chat,activeChatId=ctx.chatId;
    const latest=()=>{
        const current=context();
        if(buildingScope(current)!==meta.scope || current.chat!==startChat ||
            current.chatId!==activeChatId)
            throw new Error('복구 중 채팅이 변경되어 추가 수정을 중단했습니다.');
        return current;
    };
    const parse=parseChatJsonl(raw);
    let recovered;
    for(let i=0;i<4;i++){
        const candidate=recoveredFilename(meta.name,Date.now()+i);
        const groupNames=meta.isGroup?(ctx.groups||[]).flatMap(g=>g.chats||[]):[];
        if(groupNames.some(x=>cleanChatId(x)===candidate))continue;
        const existing=await getRaw(latest(),{isGroup:meta.isGroup,avatar:meta.avatar,id:candidate},fetcher);
        if(existing===null){recovered=candidate;break;}
    }
    if(!recovered)throw new Error('다른 채팅과 겹치지 않는 복구 이름을 만들지 못했습니다.');
    // Detect management metadata conflicts before creating a chat file.
    let libraryCopy=null;
    if(meta.librarySnapshot){
        libraryCopy=moveLibraryReference(meta.librarySnapshot,meta.scope,meta.name,recovered).library;
    }
    latest();
    if(meta.isGroup){
        const group=ctx.groups?.find(g=>String(g.id)===String(ctx.groupId));
        if(!group || !Array.isArray(group.chats))throw new Error('그룹 정보를 찾을 수 없습니다.');
        await post(ctx,'/api/chats/group/save',{id:recovered,chat:parse,force:true},fetcher);
    } else {
        await post(ctx,'/api/chats/save',{
            avatar_url:meta.avatar,file_name:recovered,chat:parse,force:true,
        },fetcher);
    }
    // IMPORTANT: native save APIs serialize JSON objects. Exact JSONL bytes
    // aren't guaranteed; verify the preserved message/object semantics.
    const readBack=await getRaw(latest(),{
        isGroup:meta.isGroup,avatar:meta.avatar,id:recovered,
    },fetcher);
    if(readBack===null || !sameChatJsonl(raw,readBack))
        throw new Error('복구된 채팅 내용 검증에 실패했습니다. 자동 보관함은 유지됩니다. 새 채팅 파일을 점검해 주세요.');

    if(meta.isGroup){
        const current=latest();
        const group=current.groups?.find(g=>String(g.id)===meta.groupId);
        if(!group || !Array.isArray(group.chats))throw new Error('그룹 목록 갱신 전에 그룹이 변경됐습니다.');
        if(group.chats.includes(recovered))throw new Error('그룹에 같은 이름의 채팅이 이미 있습니다.');
        const next=[...group.chats,recovered];
        await post(current,'/api/groups/edit',{...group,chats:next},fetcher);
        group.chats=next;
    }
    let warning='';
    if(libraryCopy){
        try{libraryRepository.importAdditively(libraryCopy);}
        catch(error){warning='관리 정보 복구 실패: '+error.message;}
    }
    try{await vault.mark(archiveId,'restored',recovered);}
    catch(error){warning+=' 보관함 상태 갱신 실패: '+error.message;}
    return {newId:recovered,warning};
}

export async function archiveAsZip(vault,id){
    const {meta,raw}=await vault.read(id);
    return {
        blob:packJsonlZip([{name:meta.name+'.jsonl',text:raw}]),
        name:meta.name+'.zip',
    };
}
