/**
 * Q-07B explicit single-file operations in Quiet lobby.
 * Back up a source JSONL before revealing a confirmation form. The user must
 * separately acknowledge the download and type its exact old filename.
 * Never auto-delete anything; no multi-file destructive operations in Q-07B.
 */
import {buildingScope,cleanChatId} from './building-data.js';
import {exportSelectedChats,downloadBackupBlob} from './file-backup.js';
import {validateFilePlan,validateNewChatName,renameInactiveChat,deleteInactiveChat} from './file-operations.js';

const element=(tag,cls='',value)=>{
    const node=document.createElement(tag);
    if(cls)node.className=cls;
    if(value!==undefined)node.textContent=String(value);
    return node;
};
const button=(label,cls,click)=>{
    const node=element('button',cls,label);
    node.type='button';node.addEventListener('click',click);
    return node;
};
export class FileActionUI {
    constructor(library) {
        this.library=library;
        this.pending=null;
        this.busy=false;
        this.abort=null;
        this.disposed=false;

        this.panel=element('section','stmn-file-action');
        this.panel.hidden=true;
        this.panel.setAttribute('aria-label','채팅 파일 변경 확인');
        this.title=element('strong','stmn-file-action-title');
        this.help=element('p','stmn-file-action-help');
        this.error=element('p','stmn-file-action-error');
        this.error.setAttribute('role','status');
        const renameRow=element('label','stmn-file-action-rename');
        renameRow.append(element('span','','새 파일 이름'));
        this.newName=element('input');
        this.newName.type='text';this.newName.maxLength=120;
        this.newName.placeholder='확장자 없이 새 이름';
        this.newName.setAttribute('aria-label','새 채팅 파일 이름');
        renameRow.append(this.newName);
        this.renameRow=renameRow;

        const backupRow=element('label','stmn-file-action-ack');
        this.verified=element('input');
        this.verified.type='checkbox';
        this.verified.setAttribute('aria-label','ZIP 백업 파일 확인');
        backupRow.append(this.verified,element('span','',
            'ZIP 파일이 실제로 저장되었고 원본 JSONL이 들어 있음을 확인했습니다.'));
        this.verifyRow=backupRow;

        const confirmRow=element('label','stmn-file-action-rename');
        confirmRow.append(element('span','','현재 파일 이름을 정확히 입력'));
        this.confirmName=element('input');
        this.confirmName.type='text';this.confirmName.autocomplete='off';
        this.confirmName.setAttribute('aria-label','기존 채팅 파일명 확인');
        confirmRow.append(this.confirmName);
        this.confirmRow=confirmRow;

        const controls=element('div','stmn-file-action-buttons');
        this.submit=button('실행','stmn-file-action-submit',()=>void this.confirm());
        this.cancel=button('취소','stmn-file-action-cancel',()=>this.reset());
        controls.append(this.submit,this.cancel);
        this.panel.append(this.title,this.help,this.renameRow,this.verifyRow,
            this.confirmRow,this.error,controls);
        library.owner.buildingsPane.insertBefore(this.panel,library.owner.contentArea);
        for(const input of [this.newName,this.confirmName,this.verified]) {
            input.addEventListener('input',()=>this.updateButtons());
            input.addEventListener('change',()=>this.updateButtons());
        }
        this.updateButtons();
    }

    isQuiet(){
        const owner=this.library.owner;
        return owner.view.root.dataset.elevatorTheme==='quiet' && owner.tab==='buildings';
    }

    reset(){
        if(this.busy)return;
        this.abort?.abort();this.abort=null;
        this.pending=null;
        this.panel.hidden=true;
        this.error.textContent='';
        this.verified.checked=false;
        this.confirmName.value='';
        this.newName.value='';
        this.updateButtons();
    }

    dismissOnNavigation(){
        if(this.busy) {
            this.abort?.abort();
            // The server adapter will reject stale scope/active chat itself.
            return;
        }
        this.reset();
    }

    async begin(kind,item){
        if(this.busy || this.disposed || !this.isQuiet())return false;
        const owner=this.library.owner;
        const ctx=owner.callbacks.context();
        const scope=owner.scope;
        try {
            // Inactive and same-scope validation BEFORE any backup request.
            validateFilePlan(ctx,scope,owner.buildings,item.id,'delete');
        } catch(error){
            owner.view.setStatus(error.message,true);
            return false;
        }
        this.reset();
        this.busy=true;
        this.abort=new AbortController();
        this.title.textContent=kind==='rename'?'채팅 파일 이름 변경':'채팅 파일 삭제';
        this.help.textContent='원본 백업을 준비하고 있습니다…';
        this.panel.hidden=false;
        this.renameRow.hidden=kind!=='rename';
        this.submit.textContent=kind==='rename'?'파일 이름 변경':'파일 영구 삭제';
        this.verified.checked=false;
        this.confirmName.value='';
        this.newName.value='';
        this.updateButtons();
        try {
            const result=await exportSelectedChats({
                context:owner.callbacks.context,scope,
                buildings:owner.buildings,ids:[item.id],
                signal:this.abort.signal,
            });
            // The browser may decline/suppress the download. Never infer
            // actual disk persistence from the download API returning.
            const timestamp=new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
            downloadBackupBlob(result.blob,
                'Elevator-Before-'+(kind==='delete'?'Delete-':'Rename-')+timestamp+'.zip');
            if(this.abort.signal.aborted || this.disposed ||
                buildingScope(owner.callbacks.context())!==scope ||
                owner.callbacks.context().chatId!==ctx.chatId)
                throw new Error('채팅 대상이 변경되어 파일 작업을 중단했습니다.');
            this.pending={kind,id:item.id,scope,activeId:ctx.chatId,chat:ctx.chat};
            this.help.textContent='채팅 "'+item.name+'"의 JSONL 백업 다운로드를 요청했습니다. '
                +'다운로드 폴더에서 ZIP을 직접 열어 확인한 뒤, 확인란을 선택하고 현재 파일명을 입력해 주세요. '
                +'이름 변경/삭제는 확인 버튼을 누를 때까지 실행되지 않습니다.';
            this.error.textContent='';
            this.confirmName.placeholder=item.id;
            this.updateButtons();
            this.panel.scrollIntoView({block:'nearest'});
            return true;
        }catch(error){
            this.pending=null;
            this.panel.hidden=true;
            owner.view.setStatus('파일 백업을 준비하지 못해 변경을 중단했습니다: '+error.message,true);
            return false;
        }finally{
            this.busy=false;
            this.abort=null;
            this.updateButtons();
        }
    }

    updateButtons(){
        const ready=this.pending && !this.busy &&
            this.verified.checked && this.confirmName.value===this.pending.id &&
            (this.pending.kind!=='rename' || !!this.newName.value.trim());
        this.submit.disabled=!ready;
        this.cancel.disabled=this.busy;
        this.newName.disabled=this.busy;
        this.confirmName.disabled=this.busy;
        this.verified.disabled=this.busy;
    }

    async confirm(){
        const pending=this.pending;
        if(this.busy || !pending || !this.verified.checked ||
            this.confirmName.value!==pending.id)return false;
        const owner=this.library.owner;
        if(owner.scope!==pending.scope ||
           owner.callbacks.context().chatId!==pending.activeId ||
           owner.callbacks.context().chat!==pending.chat){
            this.error.textContent='백업 이후 다른 채팅으로 이동했습니다. 파일 작업을 취소하고 다시 시작해 주세요.';
            return false;
        }
        let newName;
        try{
            if(pending.kind==='rename'){
                newName=validateNewChatName(this.newName.value);
                validateFilePlan(owner.callbacks.context(),pending.scope,
                    owner.buildings,pending.id,'rename',newName);
            }
        }catch(error){
            this.error.textContent=error.message;
            return false;
        }
        this.busy=true;
        this.updateButtons();
        this.help.textContent='파일 및 그룹 참조를 수정하고 있습니다. 완료되기 전 다른 채팅으로 이동하지 마세요.';
        try{
            const outcome=pending.kind==='rename'
                ?await renameInactiveChat({
                    context:owner.callbacks.context,scope:pending.scope,
                    buildings:owner.buildings,id:pending.id,newName,
                })
                :await deleteInactiveChat({
                    context:owner.callbacks.context,scope:pending.scope,
                    buildings:owner.buildings,id:pending.id,
                });
            let warning=outcome.warning||'';
            try{
                owner.callbacks.syncFileLibrary?.(pending.scope,pending.id,
                    pending.kind==='rename'?outcome.newId:null);
            }catch(error){
                warning+=' 라이브러리 폴더·태그 정보 갱신 실패: '+error.message;
            }
            // At this point the server mutation succeeded, so any refresh
            // errors must never incorrectly suggest the operation was undone.
            this.pending=null;
            this.panel.hidden=true;
            this.library.fileUI.selected.delete(pending.id);
            if(this.library.fileUI.enabled)this.library.fileUI.renderToolbar();
            owner.view.setStatus(
                (pending.kind==='rename'?'파일 이름을 변경했습니다.':'파일을 삭제했습니다.')+
                (warning?' 주의: '+warning:''));
            void owner.refreshBuildings(true);
            return true;
        }catch(error){
            this.pending=null;
            this.panel.hidden=true;
            owner.view.setStatus('파일 작업 실패: '+error.message,true);
            void owner.refreshBuildings(true);
            return false;
        }finally{
            this.busy=false;
            this.updateButtons();
        }
    }
    destroy(){
        this.disposed=true;
        this.abort?.abort();
        this.pending=null;
        this.panel.remove();
    }
}
