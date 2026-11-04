/**
 * Q-12 single-message actions: reuse Q-10's validated one-item operation.
 * Hide/unhide is non-destructive. Delete requires verified server JSONL, ZIP
 * download request, explicit user confirmation and native ST deletion.
 */
import {
    captureMessageSelection,ensureSelectionCurrent,prepareMessageBatch,
    commitMessageBatch,prepareDeletionBackup,deleteMessageSelection,
} from './message-batch.js';
import {downloadBackupBlob} from './file-backup.js';
import {getRenderedMessage,getChatElement,ensureMessageRendered} from './scroll.js';

const make=(tag,cls='',value)=>{
    const node=document.createElement(tag);
    if(cls)node.className=cls;
    if(value!==undefined)node.textContent=String(value);
    return node;
};
const button=(label,cls,action)=>{
    const node=make('button',cls,label);node.type='button';
    node.addEventListener('click',action);
    return node;
};

export class SingleMessageActions{
    constructor(view){
        this.view=view;
        this.busy=false;
        this.selection=null;
        this.backup=null;
        this.pendingClose=false;
        this.root=make('div','stmn-single-message-overlay');
        this.root.hidden=true;
        this.root.setAttribute('role','presentation');
        this.dialog=make('section','stmn-single-message-dialog');
        this.dialog.setAttribute('role','dialog');
        this.dialog.setAttribute('aria-modal','true');
        this.dialog.setAttribute('aria-label','단일 메시지 삭제 및 백업');
        const title=make('strong','stmn-single-message-title','메시지 삭제');
        this.message=make('p','stmn-single-message-notice');
        this.status=make('p','stmn-single-message-status');
        this.status.setAttribute('role','status');
        this.download=button('① 원본 채팅 ZIP 다운로드','stmn-single-message-download',
            ()=>void this.downloadBackup());
        this.confirm=make('label','stmn-single-message-confirm');
        this.checked=make('input');
        this.checked.type='checkbox';this.checked.disabled=true;
        this.checked.addEventListener('change',()=>this.update());
        this.confirm.append(this.checked,document.createTextNode(
            '② 원본 ZIP 파일을 저장했고, 이 메시지를 영구 삭제하는 데 동의합니다.'));
        this.buttons=make('div','stmn-single-message-buttons');
        this.remove=button('③ 메시지 영구 삭제','stmn-single-message-remove',
            ()=>void this.delete());
        this.cancel=button('취소','stmn-single-message-cancel',()=>this.close());
        this.buttons.append(this.cancel,this.remove);
        this.dialog.append(title,this.message,this.download,this.confirm,this.buttons,this.status);
        this.root.append(this.dialog);
        view.root.append(this.root);
        this.handleKey=event=>{
            if(event.key!=='Escape' || this.root.hidden)return;
            event.preventDefault();event.stopImmediatePropagation();
            if(!this.busy)this.close();
        };
        document.addEventListener('keydown',this.handleKey,true);
        this.update();
    }
    select(index,ref){
        const ctx=this.view.callbacks.context();
        if(ctx?.chat?.[index]!==ref)
            throw new Error('메시지 내용이 바뀌었습니다. 다시 선택해 주세요.');
        return captureMessageSelection(ctx,[index]);
    }
    close(){
        if(this.busy){this.pendingClose=true;return;}
        this.pendingClose=false;this.selection=null;this.backup=null;
        this.checked.checked=false;this.root.hidden=true;
        this.update();
    }
    update(){
        const canDelete=!this.busy && !!this.selection &&
            !!this.backup && this.checked.checked;
        this.download.disabled=this.busy || !this.selection || !!this.backup;
        this.checked.disabled=this.busy || !this.backup;
        this.remove.disabled=!canDelete;
        this.cancel.disabled=this.busy;
    }
    async toggleHidden(index,ref){
        if(this.busy || !this.root.hidden || this.view.messageBatch?.busy ||
           this.view.reorderUI?.active)return false;
        this.busy=true;
        try{
            const selection=this.select(index,ref);
            const ctx=this.view.callbacks.context();
            const operation=ref.is_system===true?'show':'hide';
            const plan=prepareMessageBatch(ctx,selection,{operation});
            const result=await commitMessageBatch(this.view.callbacks.context,plan);
            this.view.rebuild({keepScroll:true});
            this.view.setStatus(result.changed
                ?operation==='hide'?'#'+index+' 메시지 숨김 저장을 요청했습니다.':
                    '#'+index+' 메시지 숨김 해제 저장을 요청했습니다.'
                :'변경할 메시지 숨김 상태가 없습니다.');
            return true;
        }catch(error){
            this.view.setStatus('메시지 숨김 변경 실패: '+(error?.message||'알 수 없음'),true);
            return false;
        }finally{
            this.busy=false;
            if(this.pendingClose)this.close();
        }
    }
    openDelete(index,ref){
        if(this.busy || this.view.messageBatch?.busy || this.view.reorderUI?.active)
            return false;
        try{
            const selection=this.select(index,ref);
            this.close();
            this.selection=selection;this.backup=null;this.checked.checked=false;
            this.message.textContent='#'+index+' 메시지를 영구 삭제합니다. 원본 채팅의 전체 JSONL을 검증하고 ZIP으로 내려받은 뒤 삭제할 수 있습니다. 다른 메시지와 스와이프는 보존합니다.';
            this.status.textContent='백업을 내려받은 뒤 파일이 실제로 저장됐는지 확인해 주세요.';
            this.root.hidden=false;
            this.update();
            this.download.focus({preventScroll:true});
            return true;
        }catch(error){
            this.view.setStatus('메시지 삭제 준비 실패: '+error.message,true);
            return false;
        }
    }
    async downloadBackup(){
        if(this.busy || !this.selection || this.backup)return false;
        this.busy=true;this.update();
        this.status.textContent='현재 채팅 저장 및 서버 원본 확인 중…';
        try{
            const backup=await prepareDeletionBackup(
                this.view.callbacks.context,this.selection);
            ensureSelectionCurrent(this.view.callbacks.context(),this.selection);
            if(this.pendingClose)throw new Error('백업 중 취소되거나 채팅이 변경됐습니다.');
            downloadBackupBlob(backup.blob,backup.selection.chatId+
                '-before-single-message-'+backup.selection.items[0].index+'-delete.zip');
            this.backup=backup;
            this.status.textContent='ZIP 다운로드를 요청했습니다. 실제 파일 저장을 확인한 뒤 체크박스를 선택하세요.';
            return true;
        }catch(error){
            this.backup=null;
            this.status.textContent='백업 실패: '+(error?.message||'알 수 없음')+
                ' · 메시지를 삭제하지 않았습니다.';
            return false;
        }finally{
            this.busy=false;
            if(this.pendingClose)this.close();
            this.update();
        }
    }
    async delete(){
        if(this.busy || !this.selection || !this.backup || !this.checked.checked)return false;
        this.busy=true;this.update();
        this.status.textContent='삭제 직전 서버 원본 재검증 및 SillyTavern 공식 삭제를 수행 중…';
        try{
            ensureSelectionCurrent(this.view.callbacks.context(),this.selection);
            const result=await deleteMessageSelection(this.view.callbacks.context,this.backup,{
                ensureRendered:async(index,ctx)=>{
                    const chat=getChatElement();
                    if(getRenderedMessage(chat,index))return true;
                    const rendered=await ensureMessageRendered(ctx,index,
                        ()=>!this.selection || (()=>{try{
                            ensureSelectionCurrent(this.view.callbacks.context(),this.selection);
                            return false;
                        }catch{return true;}})(),
                        text=>{this.status.textContent=text;});
                    return Boolean(rendered && getRenderedMessage(rendered,index));
                },
            });
            this.busy=false;
            this.close();
            this.view.rebuild();
            this.view.setStatus('선택한 메시지 '+result.deleted+
                '개를 삭제하고 서버 저장 결과를 확인했습니다. 원본 ZIP을 보관하세요.');
            return true;
        }catch(error){
            this.backup=null;this.checked.checked=false;
            this.status.textContent='삭제를 확인하지 못했습니다: '+(error?.message||'알 수 없음');
            this.view.setStatus(this.status.textContent,true);
            // A native delete may have partly succeeded; refresh the outline
            // and require a fresh ZIP/snapshot before any further mutation.
            this.view.rebuild();
            return false;
        }finally{
            this.busy=false;
            if(this.pendingClose)this.close();
            this.update();
        }
    }
    destroy(){
        this.busy=false;this.close();
        document.removeEventListener('keydown',this.handleKey,true);
        this.root.remove();
    }
}
