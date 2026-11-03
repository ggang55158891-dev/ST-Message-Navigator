/**
 * Q-07C simple file actions: no typed old filename or manual ZIP download.
 * "Delete" shows one clear confirmation; "Rename" only asks the new name.
 * Every mutation MUST first pass durable IDB write + SHA-256 readback.
 * A failure or uncertain server response leaves the archive recoverable.
 */
import {buildingScope} from './building-data.js';
import {validateFilePlan,validateNewChatName,renameInactiveChat,deleteInactiveChat} from './file-operations.js';
import {RecoveryVault} from './recovery-vault.js';
import {archiveBeforeAction,confirmActionResult} from './recovery-operations.js';
import {RecoveryBinUI} from './recovery-bin-ui.js';

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
    constructor(library){
        this.library=library;
        this.libraryRepository=library.owner.callbacks.libraryRepository;
        this.vault=new RecoveryVault();
        this.pending=null;
        this.busy=false;
        this.disposed=false;
        this.cancelled=false;

        this.panel=element('section','stmn-file-action');
        this.panel.hidden=true;
        this.panel.setAttribute('role','dialog');
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
        this.newName.addEventListener('input',()=>this.updateButtons());
        renameRow.append(this.newName);
        this.renameRow=renameRow;
        const controls=element('div','stmn-file-action-buttons');
        this.submit=button('실행','stmn-file-action-submit',()=>void this.confirm());
        this.cancel=button('취소','stmn-file-action-cancel',()=>this.reset());
        controls.append(this.cancel,this.submit);
        this.panel.append(this.title,this.help,this.renameRow,this.error,controls);
        library.owner.buildingsPane.insertBefore(this.panel,library.owner.contentArea);
        this.bin=new RecoveryBinUI(this);
        this.updateButtons();
    }
    isQuiet(){
        const owner=this.library.owner;
        return owner.view.root.dataset.elevatorTheme==='quiet' && owner.tab==='buildings';
    }
    reset(){
        if(this.busy)return;
        this.pending=null;this.cancelled=false;
        this.panel.hidden=true;
        this.error.textContent='';
        this.newName.value='';
        this.updateButtons();
    }
    dismissOnNavigation(){
        if(this.busy){this.cancelled=true;return;}
        this.reset();
        this.bin.close();
    }
    openTrash(){return this.bin.open();}
    begin(kind,item){
        if(this.busy || this.disposed || !this.isQuiet() || !['rename','delete'].includes(kind))
            return false;
        const owner=this.library.owner;
        const ctx=owner.callbacks.context(),scope=owner.scope;
        try {
            // Apply the shared inactive-chat/group guard even before a new
            // rename destination has been entered.
            validateFilePlan(ctx,scope,owner.buildings,item.id,'delete');
        }catch(error){
            owner.view.setStatus(error.message,true);return false;
        }
        this.bin.close();
        this.reset();
        this.pending={
            kind,id:item.id,name:item.name,scope,activeId:ctx.chatId,chat:ctx.chat,
        };
        this.title.textContent=kind==='delete'?'채팅 삭제':'채팅 파일 이름 변경';
        this.renameRow.hidden=kind!=='rename';
        this.help.textContent=kind==='delete'
            ?'정말 "'+item.name+'" 채팅을 삭제할까요? 원본을 브라우저 복구 보관함에 자동 저장하고 검증한 뒤 삭제합니다. 기본 보관 기간은 30일입니다.'
            :'새 파일 이름을 입력하세요. 변경 전에 복구용 원본을 자동 보관합니다.';
        this.submit.textContent=kind==='delete'?'삭제':'이름 변경';
        this.panel.hidden=false;
        this.updateButtons();
        if(kind==='rename')this.newName.focus();
        else this.submit.focus();
        return true;
    }
    updateButtons(){
        this.submit.disabled=!this.pending || this.busy ||
            (this.pending.kind==='rename' && !this.newName.value.trim());
        this.cancel.disabled=this.busy;
        this.newName.disabled=this.busy;
    }
    async confirm(){
        const pending=this.pending;
        if(this.busy || !pending)return false;
        const owner=this.library.owner;
        const ctx=owner.callbacks.context();
        if(owner.scope!==pending.scope || buildingScope(ctx)!==pending.scope ||
           ctx.chatId!==pending.activeId || ctx.chat!==pending.chat){
            this.error.textContent='다른 채팅으로 이동했습니다. 작업을 다시 시작해 주세요.';
            return false;
        }
        let newName=null;
        try {
            if(pending.kind==='rename')newName=validateNewChatName(this.newName.value);
            validateFilePlan(ctx,pending.scope,owner.buildings,pending.id,pending.kind,newName);
        }catch(error){this.error.textContent=error.message;return false;}
        this.busy=true;this.cancelled=false;
        this.updateButtons();
        this.help.textContent='원본을 안전하게 보관하고 확인하는 중입니다…';
        let archived=null;
        try{
            const currentLibrary=this.libraryRepository.read();
            archived=await archiveBeforeAction({
                vault:this.vault,context:owner.callbacks.context,
                scope:pending.scope,buildings:owner.buildings,id:pending.id,
                kind:pending.kind,newName,library:currentLibrary,
            });
            if(this.cancelled || this.disposed || !this.isQuiet())
                throw new Error('화면이 변경되어 파일 수정을 중단했습니다.');
            const before=owner.callbacks.context();
            if(before.chat!==pending.chat || before.chatId!==pending.activeId ||
                buildingScope(before)!==pending.scope)
                throw new Error('원본 보관 중 채팅이 변경되어 작업을 취소했습니다.');
            this.help.textContent='보관 확인 완료. SillyTavern 파일 작업을 실행하고 있습니다…';
            const outcome=pending.kind==='rename'
                ?await renameInactiveChat({
                    context:owner.callbacks.context,scope:pending.scope,
                    buildings:owner.buildings,id:pending.id,newName,
                })
                :await deleteInactiveChat({
                    context:owner.callbacks.context,scope:pending.scope,
                    buildings:owner.buildings,id:pending.id,
                });
            await confirmActionResult({
                context:owner.callbacks.context,record:archived,result:outcome,
            });
            // State and library metadata are best-effort post-commit operations.
            // If they fail, the RAW archive remains safe and visible to restore.
            let warning=outcome.warning||'';
            try{
                await this.vault.mark(archived.id,
                    pending.kind==='rename'?'renamed':'deleted',
                    pending.kind==='rename'?outcome.newId:null);
            }catch(error){warning+=' 보관함 상태 갱신 실패: '+error.message;}
            try{
                owner.callbacks.syncFileLibrary?.(pending.scope,pending.id,
                    pending.kind==='rename'?outcome.newId:null);
            }catch(error){warning+=' 폴더·태그 등의 관리 정보 갱신 실패: '+error.message;}
            this.pending=null;this.panel.hidden=true;
            this.library.fileUI.selected.delete(pending.id);
            this.library.fileUI.renderToolbar();
            owner.view.setStatus((pending.kind==='rename'?'파일명을 변경했습니다.':'채팅을 삭제했습니다.')+
                ' 자동 복구용 원본은 복구 보관함에 있습니다.'+
                (warning?' 주의: '+warning:''));
            void owner.refreshBuildings(true);
            return true;
        }catch(error){
            if(archived){
                try{await this.vault.mark(archived.id,'uncertain');}
                catch {/* Keep already verified original untouched. */}
            }
            this.pending=null;this.panel.hidden=true;
            owner.view.setStatus('파일 변경을 완료했다고 확인할 수 없습니다: '+error.message+
                (archived?' 원본은 복구 보관함에 남겼습니다.':' 서버 파일은 변경하지 않았습니다.'),true);
            void owner.refreshBuildings(true);
            return false;
        }finally{
            this.busy=false;this.updateButtons();
        }
    }
    destroy(){
        this.disposed=true;this.cancelled=true;
        this.bin.destroy();
        this.panel.remove();this.pending=null;
    }
}
