/**
 * Q-10 Quiet-only message multi-selection.
 * Selection lives outside the virtualized rows and is reset on scope changes.
 */
import {
    MAX_MESSAGE_SELECTION,captureMessageSelection,prepareMessageBatch,
    commitMessageBatch,prepareDeletionBackup,deleteMessageSelection,
} from './message-batch.js';
import {downloadBackupBlob} from './file-backup.js';
import {ensureMessageRendered,getRenderedMessage,getChatElement} from './scroll.js';
import {buildingScope,cleanChatId} from './building-data.js';

const make=(tag,cls='',value)=>{
    const el=document.createElement(tag);
    if(cls)el.className=cls;
    if(value!==undefined)el.textContent=String(value);
    return el;
};
const button=(label,cls,fn)=>{
    const el=make('button',cls,label);
    el.type='button';
    el.addEventListener('click',fn);
    return el;
};
const OPERATIONS=[
    ['bookmark-add','즐겨찾기 등록'],
    ['bookmark-remove','즐겨찾기 해제'],
    ['hide','메시지 눈 감기 (숨김)'],
    ['show','메시지 눈 뜨기 (숨김 해제)'],
    ['title','메시지 제목 일괄 변경 · 번호 붙이기'],
    ['delete','메시지 영구 삭제 · 백업 필요'],
];

export class MessageBatchUI{
    constructor(view){
        this.view=view;
        this.selected=new Map();
        this.selectionMode=false;
        this.busy=false;
        this.backup=null;
        this.scope=null;
        this.chatRef=null;
        this.chatId=null;
        this.pendingRefresh=false;

        this.root=make('section','stmn-message-batch');
        this.root.setAttribute('aria-label','Quiet 메시지 다중 선택');
        this.openButton=button('메시지 다중 선택','stmn-message-batch-open',
            ()=>this.toggleMode());
        this.openButton.setAttribute('aria-pressed','false');
        this.root.append(this.openButton);
        this.controls=make('div','stmn-message-batch-controls');
        this.controls.hidden=true;
        this.summary=make('div','stmn-message-batch-summary');
        const actions=make('div','stmn-message-batch-actions');
        const label=make('label','stmn-message-batch-label','일괄 작업');
        this.operation=make('select','stmn-message-batch-operation');
        this.operation.setAttribute('aria-label','메시지 다중 편집 작업');
        for(const [value,name] of OPERATIONS){
            const option=make('option','',name);
            option.value=value;this.operation.append(option);
        }
        this.operation.addEventListener('change',()=>this.onSelectionChanged());
        label.append(this.operation);
        this.titleRow=make('label','stmn-message-batch-title');
        this.titleRow.append(make('span','','공통 제목'));
        this.titleInput=make('input');
        this.titleInput.type='text';this.titleInput.maxLength=298;
        this.titleInput.setAttribute('aria-label','일괄 변경할 공통 메시지 제목');
        this.titleInput.placeholder='예: 첫 만남 → 첫 만남 1, 첫 만남 2';
        this.titleRow.append(this.titleInput);
        this.titleInput.addEventListener('input',()=>this.onSelectionChanged());
        this.applyButton=button('변경 적용','stmn-message-batch-apply',
            ()=>void this.apply());
        this.clearButton=button('선택 해제','stmn-message-batch-clear',()=>this.clear());
        actions.append(label,this.titleRow,this.applyButton,this.clearButton);
        this.warning=make('p','stmn-message-batch-warning');
        this.warning.setAttribute('role','status');
        this.backupPanel=make('div','stmn-message-batch-backup');
        this.backupPanel.hidden=true;
        this.backupNotice=make('p','',
            '영구 삭제 전에 현재 채팅 전체의 원본 JSONL ZIP을 다운로드해야 합니다. 다운로드한 파일을 안전하게 저장한 뒤 확인해 주세요.');
        this.backupButton=button('① 원본 ZIP 다운로드','stmn-message-batch-download',
            ()=>void this.downloadBackup());
        const confirm=make('label','stmn-message-batch-confirm');
        this.backupChecked=make('input');
        this.backupChecked.type='checkbox';
        this.backupChecked.disabled=true;
        this.backupChecked.addEventListener('change',()=>this.update());
        confirm.append(this.backupChecked,document.createTextNode('② 백업 파일을 보관했고, 선택 메시지의 영구 삭제를 확인했습니다.'));
        this.backupPanel.append(this.backupNotice,this.backupButton,confirm);
        this.controls.append(this.summary,actions,this.backupPanel,this.warning);
        this.root.append(this.controls);
        view.list.before(this.root);
        this.update();
    }

    isQuietFloor(){
        return this.view.root.dataset.elevatorTheme==='quiet' &&
            this.view.elevator.tab==='floors';
    }
    inSameChat(){
        const ctx=this.view.callbacks.context();
        return this.scope===buildingScope(ctx) &&
            this.chatRef===ctx.chat && this.chatId===cleanChatId(ctx.chatId);
    }
    toggleMode(force){
        if(this.busy)return;
        const next=typeof force==='boolean'?force:!this.selectionMode;
        if(next&&!this.isQuietFloor())return;
        if(!next)this.clear();
        this.selectionMode=next;
        if(next){
            const ctx=this.view.callbacks.context();
            if(!ctx.chatId || !Array.isArray(ctx.chat) || !ctx.chat.length){
                this.selectionMode=false;
                this.view.setStatus('먼저 메시지가 있는 채팅을 열어 주세요.',true);
            }else{
                this.scope=buildingScope(ctx);
                this.chatId=cleanChatId(ctx.chatId);
                this.chatRef=ctx.chat;
            }
        }
        this.update();
        this.view.renderRows(true);
    }
    clear(){
        if(this.busy)return;
        this.selected.clear();
        this.clearBackup();
        this.update();
        this.view.renderRows(true);
    }
    reset(){
        if(this.busy){
            this.pendingRefresh=true;
            return;
        }
        this.selected.clear();
        this.clearBackup();
        this.selectionMode=false;
        this.scope=null;this.chatId=null;this.chatRef=null;
        this.update();
        this.view.renderRows(true);
    }
    clearBackup(){
        this.backup=null;
        this.backupChecked.checked=false;
        this.backupChecked.disabled=true;
    }
    select(index,ref,wanted){
        if(this.busy || !this.selectionMode || !this.isQuietFloor() ||
            !this.inSameChat())return false;
        const ctx=this.view.callbacks.context();
        if(!Number.isInteger(index) || ctx.chat[index]!==ref)return false;
        if(wanted){
            if(this.selected.size>=MAX_MESSAGE_SELECTION && !this.selected.has(index)){
                this.view.setStatus('메시지는 한 번에 최대 20개까지 선택할 수 있습니다.',true);
                return false;
            }
            this.selected.set(index,ref);
        }else this.selected.delete(index);
        this.onSelectionChanged();
        return true;
    }
    checkboxFor(index,ref){
        const box=make('input','stmn-message-batch-check');
        box.type='checkbox';
        box.checked=this.selected.has(index);
        box.setAttribute('aria-label','#'+index+' 메시지 선택');
        box.addEventListener('click',event=>event.stopPropagation());
        box.addEventListener('change',()=>{
            const accepted=this.select(index,ref,box.checked);
            if(!accepted)box.checked=this.selected.has(index);
        });
        return box;
    }
    onSelectionChanged(){
        this.clearBackup();
        this.warning.textContent='';
        this.update();
        this.view.renderRows(true);
    }
    update(){
        const visible=this.isQuietFloor();
        this.root.hidden=!visible;
        this.openButton.textContent=this.selectionMode?'다중 선택 종료':'메시지 다중 선택';
        this.openButton.setAttribute('aria-pressed',String(this.selectionMode));
        this.controls.hidden=!this.selectionMode;
        if(!this.selectionMode)return;
        const indices=[...this.selected.keys()].sort((a,b)=>a-b);
        this.summary.textContent=indices.length+'/'+MAX_MESSAGE_SELECTION+
            '개 선택 · '+(indices.length?indices.map(i=>'#'+i).join(', '):'선택된 메시지 없음');
        const operation=this.operation.value;
        this.titleRow.hidden=operation!=='title';
        this.backupPanel.hidden=operation!=='delete';
        const enabled=indices.length>0 && !this.busy && this.inSameChat();
        this.applyButton.disabled=!enabled ||
            (operation==='title'&&!this.titleInput.value.trim()) ||
            (operation==='delete'&&(!this.backup || !this.backupChecked.checked));
        this.applyButton.textContent=operation==='delete'?'③ 선택 메시지 영구 삭제':'변경 적용';
        this.backupButton.disabled=!enabled || this.backup!==null;
        this.backupChecked.disabled=this.busy || this.backup===null;
        this.openButton.disabled=this.busy;
        this.clearButton.disabled=this.busy || !indices.length;
        this.operation.disabled=this.busy;
        this.titleInput.disabled=this.busy;
    }
    selection(){
        if(!this.selected.size || !this.inSameChat())
            throw new Error('현재 채팅에 유효한 선택 메시지가 없습니다.');
        const ctx=this.view.callbacks.context();
        for(const [index,ref] of this.selected){
            if(ctx.chat[index]!==ref)
                throw new Error('선택된 메시지 위치가 변경됐습니다. 다시 선택해 주세요.');
        }
        return captureMessageSelection(ctx,[...this.selected.keys()]);
    }
    async downloadBackup(){
        if(this.busy || this.operation.value!=='delete')return;
        this.busy=true;
        this.update();
        this.warning.textContent='현재 채팅을 저장하고 원본 ZIP을 검증하는 중입니다…';
        try{
            const backup=await prepareDeletionBackup(
                this.view.callbacks.context,this.selection());
            if(!this.inSameChat())throw new Error('백업 중 채팅이 변경됐습니다.');
            downloadBackupBlob(backup.blob,backup.selection.chatId+'-before-message-delete.zip');
            this.backup=backup;
            this.warning.textContent='원본 ZIP 다운로드를 요청했습니다. 파일 보관을 확인한 뒤 삭제를 실행할 수 있습니다.';
        }catch(error){
            this.warning.textContent='백업 실패: '+(error?.message||'확인 불가')+
                ' · 메시지는 삭제하지 않았습니다.';
        }finally{
            this.busy=false;
            this.update();
        }
    }
    async apply(){
        if(this.busy || !this.selectionMode || !this.selected.size)return;
        const operation=this.operation.value;
        if(operation==='delete' && (!this.backup || !this.backupChecked.checked))return;
        let selection;
        try{selection=this.selection();}
        catch(error){this.warning.textContent=error.message;return;}
        this.busy=true;this.update();
        try{
            let count;
            if(operation==='delete'){
                if(this.backup.selection.chat!==selection.chat ||
                   this.backup.selection.length!==selection.length ||
                   this.backup.selection.items.some((x,i)=>
                       x.ref!==selection.items[i]?.ref || x.index!==selection.items[i]?.index))
                    throw new Error('백업 이후 선택이 달라졌습니다. 다시 백업해 주세요.');
                this.warning.textContent='백업과 원본을 재검증하고 공식 삭제 기능을 실행하고 있습니다…';
                const result=await deleteMessageSelection(this.view.callbacks.context,this.backup,{
                    ensureRendered:async(index,ctx)=>{
                        const chat=getChatElement();
                        if(getRenderedMessage(chat,index))return true;
                        const loaded=await ensureMessageRendered(ctx,index,
                            ()=>!this.inSameChat(),text=>{this.warning.textContent=text;});
                        return Boolean(loaded && getRenderedMessage(loaded,index));
                    },
                });
                count=result.deleted;
            }else{
                const plan=prepareMessageBatch(this.view.callbacks.context(),selection,{
                    operation,baseTitle:this.titleInput.value,
                });
                const result=await commitMessageBatch(this.view.callbacks.context,plan);
                count=result.changed;
            }
            this.warning.textContent='';
            this.busy=false;
            this.reset();
            this.view.rebuild({keepScroll:operation!=='delete'});
            this.view.setStatus(operation==='delete'
                ?'선택한 '+count+'개 메시지를 삭제하고 서버 저장을 확인했습니다. 원본 ZIP을 안전하게 보관하세요.'
                :count+'개 메시지의 일괄 변경을 요청했습니다.');
        }catch(error){
            this.warning.textContent='일괄 작업을 완료하지 못했습니다: '+(error?.message||'알 수 없음');
            this.view.setStatus(this.warning.textContent,true);
            this.clearBackup();
        }finally{
            this.busy=false;
            if(this.pendingRefresh){
                this.pendingRefresh=false;
                this.reset();
            }
            this.update();
        }
    }
    destroy(){this.reset();this.root.remove();}
}
