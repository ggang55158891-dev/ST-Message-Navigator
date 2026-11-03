/**
 * Q-07B: non-active, single-chat rename / delete.
 * Never call destructive endpoints until an explicit UI confirmation AFTER
 * generating an archival download. The UI is responsible for that handshake;
 * this adapter validates again immediately before every server mutation.
 *
 * Group operations have two resources (group metadata and JSONL file) and
 * cannot be globally atomic. Rollback is best effort and errors explicitly
 * request manual inspection when consistency is uncertain.
 */
import {buildingScope,cleanChatId} from './building-data.js';
import {validateBackupSelection} from './file-backup.js';

const invalidName=/[<>:"|?*\/\\\u0000-\u001f\u007f]/;
const reserved=/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

export function validateNewChatName(value) {
    if(typeof value!=='string' || !value || value!==value.trim() ||
       value.length>120 || invalidName.test(value) ||
       value.endsWith('.') || value.endsWith(' ') ||
       value.startsWith('.') || reserved.test(value) ||
       /\.jsonl$/i.test(value)) {
        throw new Error('파일 이름은 1~120자이며, 경로·예약어·확장자(.jsonl)·끝 공백/점은 사용할 수 없습니다.');
    }
    return value;
}

export function validateFilePlan(ctx,scope,buildings,id,action,newName) {
    if(!['rename','delete'].includes(action))
        throw new Error('지원하지 않는 파일 작업입니다.');
    const target=validateBackupSelection(ctx,scope,buildings,[id]);
    const source=target.ids[0];
    if(source===cleanChatId(ctx.chatId))
        throw new Error('현재 열려 있는 채팅은 변경할 수 없습니다. 다른 채팅으로 이동해 주세요.');
    if(target.isGroup) {
        // ST stores group-chat files in one shared directory: guard references
        // from any other group before rename or deletion.
        const shared=(ctx.groups||[]).some(group=>
            String(group.id)!==String(ctx.groupId) &&
            Array.isArray(group.chats) &&
            group.chats.some(name=>cleanChatId(name)===source));
        if(shared)throw new Error('다른 그룹에서도 참조 중인 파일은 변경할 수 없습니다.');
    }
    let destination=null;
    if(action==='rename'){
        destination=validateNewChatName(newName);
        if(destination.toLocaleLowerCase()===source.toLocaleLowerCase())
            throw new Error('기존 파일명과 동일하거나 대소문자만 다른 이름입니다.');
        if(buildings.some(row=>cleanChatId(row.id).toLocaleLowerCase()===destination.toLocaleLowerCase()))
            throw new Error('새 파일 이름이 현재 채팅 목록과 중복됩니다.');
        if(target.isGroup && (ctx.groups||[]).some(group=>
            Array.isArray(group.chats) && group.chats.some(name=>
                cleanChatId(name).toLocaleLowerCase()===destination.toLocaleLowerCase())))
            throw new Error('다른 그룹에서 사용 중인 파일명입니다.');
    }
    return {...target,source,destination,action,scope};
}

function ensureStillSafe(context,plan,originalChatId) {
    const ctx=context();
    if(buildingScope(ctx)!==plan.scope ||
       cleanChatId(ctx.chatId)!==originalChatId ||
       plan.source===cleanChatId(ctx.chatId)) {
        throw new Error('파일 작업 중 현재 채팅 또는 캐릭터/그룹이 변경되어 중단했습니다.');
    }
    if(plan.isGroup) {
        const group=ctx.groups?.find(x=>String(x.id)===String(ctx.groupId));
        if(!group?.chats?.some(x=>cleanChatId(x)===plan.source))
            throw new Error('그룹의 채팅 목록이 변경되어 작업을 중단했습니다.');
    }
    return ctx;
}

async function post(ctx,path,payload,fetcher) {
    if(typeof ctx.getRequestHeaders!=='function')
        throw new Error('SillyTavern 인증 헤더를 사용할 수 없습니다.');
    const response=await fetcher(path,{
        method:'POST',headers:ctx.getRequestHeaders(),
        body:JSON.stringify(payload),cache:'no-store',
    });
    if(!response.ok)throw new Error(path+' 요청 실패 (HTTP '+response.status+')');
    // ST returns success JSON for these endpoints; empty or error payloads are
    // not accepted as proof that a destructive operation took place.
    const data=await response.json();
    if(!data || data.ok!==true)
        throw new Error(path+' 작업 완료를 확인하지 못했습니다.');
    return data;
}
function filename(id){return id+'.jsonl';}
function renameBody(plan,oldId,newId){
    return {
        is_group:plan.isGroup,
        avatar_url:plan.avatar,
        original_file:filename(oldId),
        renamed_file:filename(newId),
    };
}
async function emitEvent(ctx,name,detail){
    try {
        const type=ctx.eventTypes?.[name];
        if(type && typeof ctx.eventSource?.emit==='function')
            await ctx.eventSource.emit(type,detail);
        return null;
    } catch {
        return '파일 변경은 완료했지만 다른 확장에 변경 알림을 보내지 못했습니다. 화면을 새로고침해 주세요.';
    }
}

export async function renameInactiveChat({
    context,scope,buildings,id,newName,fetcher=fetch,
}) {
    const before=context();
    const plan=validateFilePlan(before,scope,buildings,id,'rename',newName);
    const active=cleanChatId(before.chatId);
    const ctx=ensureStillSafe(context,plan,active);
    let fileRenamed=false;
    const payload=renameBody(plan,plan.source,plan.destination);
    const result=await post(ctx,'/api/chats/rename',payload,fetcher);
    fileRenamed=true;
    const actual=result.sanitizedFileName||plan.destination;
    if(actual!==plan.destination) {
        try {
            await post(ctx,'/api/chats/rename',renameBody(plan,actual,plan.source),fetcher);
        } catch {
            throw new Error('서버가 파일 이름을 다르게 저장했습니다. 원래 이름으로 복구하지 못했으므로 채팅 파일을 직접 확인해 주세요.');
        }
        throw new Error('서버가 파일 이름을 변경해 작업을 취소하고 원래 이름으로 복구했습니다.');
    }
    let editedGroup=false;
    if(plan.isGroup){
        try {
            const latest=ensureStillSafe(context,plan,active);
            const group=latest.groups.find(x=>String(x.id)===String(latest.groupId));
            const old=group.chats.slice();
            const renamed=old.map(name=>cleanChatId(name)===plan.source?plan.destination:name);
            await post(latest,'/api/groups/edit',{...group,chats:renamed},fetcher);
            group.chats=renamed;
            editedGroup=true;
        } catch(error) {
            // ST's file rename API copies then unlinks. If group metadata
            // fails, restore the old filename before reporting failure.
            try {
                await post(ctx,'/api/chats/rename',renameBody(plan,plan.destination,plan.source),fetcher);
                throw new Error('그룹 목록을 갱신하지 못해 파일 이름을 되돌렸습니다. 원인: '+error.message);
            } catch(rollbackError) {
                if(rollbackError.message.startsWith('그룹 목록을 갱신하지 못해'))throw rollbackError;
                throw new Error('그룹 목록 갱신 실패 및 파일 이름 자동 복구 실패. 수동 확인이 필요합니다: '+error.message);
            }
        }
    }
    // Character active chat is always excluded; no character.chat pointer
    // changes. The ST native event informs other extensions of the rename.
    const warning=await emitEvent(ctx,'CHAT_RENAMED',{
        avatarId:plan.avatar,groupId:plan.isGroup?ctx.groupId:null,
        oldFileName:filename(plan.source),newFileName:filename(plan.destination),
    });
    return {oldId:plan.source,newId:plan.destination,groupUpdated:editedGroup,
        fileRenamed,warning};
}

/**
 * Group deletion writes a membership copy first. If deletion rejects,
 * attempt to restore group metadata while the JSONL should still exist.
 * Never silently claim rollback succeeded after an ambiguous network failure.
 */
export async function deleteInactiveChat({
    context,scope,buildings,id,fetcher=fetch,
}) {
    const before=context();
    const plan=validateFilePlan(before,scope,buildings,id,'delete');
    const active=cleanChatId(before.chatId);
    const ctx=ensureStillSafe(context,plan,active);
    let group=null,oldChats=null;
    if(plan.isGroup){
        group=ctx.groups.find(x=>String(x.id)===String(ctx.groupId));
        oldChats=group.chats.slice();
        const remaining=oldChats.filter(name=>cleanChatId(name)!==plan.source);
        // The file remains intact unless the group membership update succeeds.
        await post(ctx,'/api/groups/edit',{...group,chats:remaining},fetcher);
        // Do not mutate ST in-memory references until server delete succeeds.
    }
    try {
        ensureStillSafe(context,plan,active);
        const endpoint=plan.isGroup?'/api/chats/group/delete':'/api/chats/delete';
        const payload=plan.isGroup?{id:plan.source}:{
            chatfile:filename(plan.source),avatar_url:plan.avatar,
        };
        await post(ctx,endpoint,payload,fetcher);
    } catch(error){
        if(plan.isGroup && group){
            try {
                await post(ctx,'/api/groups/edit',{...group,chats:oldChats},fetcher);
            } catch {
                throw new Error('채팅 삭제 오류 후 그룹 목록도 자동 복구하지 못했습니다. 수동 확인이 필요합니다: '+error.message);
            }
            throw new Error('삭제 요청이 실패하여 그룹 목록을 되돌렸습니다. 파일 상태를 확인해 주세요: '+error.message);
        }
        throw error;
    }
    if(plan.isGroup)group.chats=oldChats.filter(x=>cleanChatId(x)!==plan.source);
    const warning=await emitEvent(ctx,plan.isGroup?'GROUP_CHAT_DELETED':'CHAT_DELETED',plan.source);
    return {deletedId:plan.source,groupUpdated:plan.isGroup,warning};
}
