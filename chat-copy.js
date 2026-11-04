/**
 * Q-09: create a separate chat without modifying the source.
 *
 * ST's /save and /group/save overwrite names. Never save directly to the
 * requested destination. Create a random staging file, verify its semantic
 * contents, then use /api/chats/rename, which refuses existing destinations.
 * The server is not transactionally atomic; uncertain staging files are kept
 * and reported, never silently deleted or retried.
 */
import {buildingScope,cleanChatId} from './building-data.js';
import {validateBackupSelection} from './file-backup.js';
import {validateNewChatName} from './file-operations.js';
import {parseChatJsonl,sameChatJsonl} from './recovery-vault.js';

export const COPY_MAX_RESPONSE_BYTES=32*1024*1024;
const abortIfChanged=(context,scope,chat,chatId)=>{
    const ctx=context();
    if(buildingScope(ctx)!==scope || ctx.chat!==chat || ctx.chatId!==chatId)
        throw new Error('복제 중 캐릭터나 현재 채팅이 바뀌었습니다. 서버 파일을 확인해 주세요.');
    return ctx;
};
export function validateCopyPlan(ctx,scope,buildings,id,newName){
    const selected=validateBackupSelection(ctx,scope,buildings,[id]);
    const source=selected.ids[0],destination=validateNewChatName(newName);
    const conflict=building=>cleanChatId(building).toLocaleLowerCase()===destination.toLocaleLowerCase();
    if(conflict(source) || buildings.some(row=>conflict(row.id)) ||
       (selected.isGroup && (ctx.groups||[]).some(group=>
           (group.chats||[]).some(conflict))))
        throw new Error('복제할 파일 이름이 기존 채팅과 중복됩니다.');
    return {...selected,scope,source,destination};
}
export function suggestCopyName(id){
    const suffix=' - 복사본';
    const base=cleanChatId(id).slice(0,120-suffix.length);
    try{return validateNewChatName(base+suffix);}
    catch{return '채팅 복사본';}
}
async function post(ctx,path,payload,fetcher){
    if(typeof ctx.getRequestHeaders!=='function')throw new Error('SillyTavern 인증 헤더가 없습니다.');
    const response=await fetcher(path,{
        method:'POST',headers:ctx.getRequestHeaders(),
        cache:'no-store',body:JSON.stringify(payload),
    });
    if(!response.ok)throw new Error(path+' 요청 실패 (HTTP '+response.status+')');
    const data=await response.json();
    if(data?.ok!==true)throw new Error(path+' 완료 여부를 확인할 수 없습니다.');
    return data;
}
async function boundedJson(response){
    if(!response.ok){
        if(response.status===404)return null;
        throw new Error('원본 조회 실패 (HTTP '+response.status+')');
    }
    if(Number(response.headers?.get?.('content-length'))>COPY_MAX_RESPONSE_BYTES)
        throw new Error('32MB를 넘는 채팅 파일의 복제는 현재 지원하지 않습니다.');
    if(!response.body?.getReader)throw new Error('안전한 응답 크기 검증을 지원하지 않습니다.');
    const reader=response.body.getReader(),decoder=new TextDecoder();
    let text='',size=0;
    try{
        while(true){
            const {done,value}=await reader.read();if(done)break;
            size+=value.byteLength;
            if(size>COPY_MAX_RESPONSE_BYTES)
                throw new Error('32MB를 넘는 채팅 파일의 복제는 현재 지원하지 않습니다.');
            text+=decoder.decode(value,{stream:true});
        }
        text+=decoder.decode();
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    let json;
    try{json=JSON.parse(text);}catch{throw new Error('채팅 응답 JSON이 손상됐습니다.');}
    if(typeof json?.result!=='string')throw new Error('원본 채팅 파일을 읽지 못했습니다.');
    return json.result;
}
async function readRaw(ctx,plan,id,fetcher){
    const response=await fetcher('/api/chats/export',{
        method:'POST',headers:ctx.getRequestHeaders(),
        cache:'no-store',
        body:JSON.stringify({is_group:plan.isGroup,avatar_url:plan.avatar,
            file:id+'.jsonl',exportfilename:id+'.jsonl',format:'jsonl'}),
    });
    return boundedJson(response);
}
function uniqueStage(random){
    const token=typeof random==='function'?random():crypto.randomUUID();
    if(!/^[a-z0-9-]{12,80}$/i.test(token))
        throw new Error('복제 임시 식별자를 안전하게 만들지 못했습니다.');
    return validateNewChatName('stmn-copy-'+token);
}
export async function copyChatFile({
    context,scope,buildings,id,newName,fetcher=fetch,
    random=()=>crypto.randomUUID(),libraryRepository=null,
}){
    const first=context();
    const plan=validateCopyPlan(first,scope,buildings,id,newName);
    const anchorChat=first.chat,anchorId=first.chatId;
    const check=()=>abortIfChanged(context,scope,anchorChat,anchorId);
    if(typeof first.getRequestHeaders!=='function')
        throw new Error('SillyTavern 인증 헤더를 사용할 수 없습니다.');
    if(plan.source===cleanChatId(anchorId)){
        if(typeof first.saveChat!=='function')
            throw new Error('열려 있는 채팅은 먼저 SillyTavern에 저장해야 복제할 수 있습니다.');
        const saved=await first.saveChat();
        if(saved===false)throw new Error('현재 채팅을 저장하지 못했습니다.');
    }
    check();
    const source=await readRaw(first,plan,plan.source,fetcher);
    if(source===null)throw new Error('원본 채팅 파일이 존재하지 않습니다.');
    const parsed=parseChatJsonl(source);
    check();
    if(await readRaw(check(),plan,plan.destination,fetcher)!==null)
        throw new Error('복제 대상 파일이 서버에 이미 있습니다. 파일을 쓰지 않았습니다.');
    const stage=uniqueStage(random);
    if(stage===plan.source || stage===plan.destination ||
       await readRaw(check(),plan,stage,fetcher)!==null)
        throw new Error('복제 임시 파일 이름이 중복됩니다. 다시 시도해 주세요.');
    const fresh=await readRaw(check(),plan,plan.source,fetcher);
    if(fresh===null || !sameChatJsonl(source,fresh))
        throw new Error('복제 준비 중 원본 내용이 변경됐습니다. 파일을 쓰지 않았습니다.');
    check();
    let stageAttempted=false;
    try {
        stageAttempted=true;
        await post(check(),plan.isGroup?'/api/chats/group/save':'/api/chats/save',
            plan.isGroup?{id:stage,chat:parsed,force:true}:
                {avatar_url:plan.avatar,file_name:stage,chat:parsed,force:true},fetcher);
        const staged=await readRaw(check(),plan,stage,fetcher);
        if(staged===null || !sameChatJsonl(source,staged))
            throw new Error('복제 임시 파일의 내용이 원본과 다릅니다.');
        // ST checks that the destination does not exist before file rename.
        const renamed=await post(check(),'/api/chats/rename',{
            is_group:plan.isGroup,avatar_url:plan.avatar,
            original_file:stage+'.jsonl',renamed_file:plan.destination+'.jsonl',
        },fetcher);
        if(renamed.sanitizedFileName!==plan.destination)
            throw new Error('서버가 요청한 복제 이름을 다르게 저장했습니다.');
        const copied=await readRaw(check(),plan,plan.destination,fetcher);
        const original=await readRaw(check(),plan,plan.source,fetcher);
        if(copied===null || original===null ||
           !sameChatJsonl(source,copied) || !sameChatJsonl(source,original))
            throw new Error('복제 후 원본/사본 내용의 확인이 실패했습니다.');
        let warning='';
        if(plan.isGroup){
            const latest=check();
            const group=latest.groups?.find(g=>String(g.id)===String(latest.groupId));
            if(!group || !Array.isArray(group.chats))
                throw new Error('그룹 정보를 잃어 복제 파일의 소속을 추가하지 못했습니다.');
            if(group.chats.some(name=>cleanChatId(name)===plan.destination))
                throw new Error('다른 작업이 그룹에 같은 이름을 추가했습니다. 중복된 그룹 연결을 막았습니다.');
            const chats=[...group.chats,plan.destination];
            await post(latest,'/api/groups/edit',{...group,chats},fetcher);
            group.chats=chats;
        }
        if(libraryRepository){
            try{libraryRepository.cloneChatRecord(scope,plan.source,plan.destination);}
            catch(error){warning='관리 정보(폴더·태그) 복사 실패: '+error.message;}
        }
        return {source:plan.source,newId:plan.destination,warning};
    }catch(error){
        if(!stageAttempted)throw error;
        throw new Error(error.message+' 복제 파일이 부분적으로 만들어졌을 수 있습니다. 대상 "'+
            plan.destination+'" 및 임시 파일 "'+stage+'"을 서버에서 확인하세요. 원본 채팅은 삭제하지 않았습니다.');
    }
}
