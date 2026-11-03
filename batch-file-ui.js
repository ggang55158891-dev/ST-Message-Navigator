/**
 * Q-07A lightweight select mode. Hidden until user chooses "파일 작업".
 * No new card layout when inactive. The original chat list remains the only
 * source of truth; selection never persists to extension settings.
 */
import {exportSelectedChats,MAX_BACKUP_CHATS,downloadBackupBlob} from './file-backup.js';
import {selectLibraryChats} from './library-operations.js';
import {cleanChatId} from './building-data.js';

const element=(tag,cls='',text)=>{
    const e=document.createElement(tag);
    if(cls)e.className=cls;
    if(text!==undefined)e.textContent=String(text);
    return e;
};
const button=(label,cls,click)=>{
    const b=element('button',cls,label);b.type='button';
    b.addEventListener('click',click);return b;
};
export class BatchFileUI {
    constructor(library){
        this.library=library;
        this.selected=new Set();
        this.enabled=false;
        this.busy=false;
        this.scope=null;
        this.controller=null;

        this.toolbar=element('div','stmn-batch-toolbar');
        this.toolbar.hidden=true;
        this.count=element('strong','stmn-batch-count','0개 선택');
        this.selectVisible=button('현재 목록 선택','stmn-batch-action',()=>this.selectFromFiltered());
        this.clearButton=button('선택 해제','stmn-batch-action',()=>{
            this.selected.clear();this.library.draw();
        });
        this.exportButton=button('원본 백업 ZIP','stmn-batch-export',()=>void this.exportSelection());
        this.closeButton=button('완료','stmn-batch-action',()=>this.enable(false));
        this.status=element('small','stmn-batch-status','');
        this.status.setAttribute('role','status');
        this.toolbar.append(this.count,this.selectVisible,this.clearButton,
            this.exportButton,this.closeButton,this.status);
        // Quiet deliberately hides the general library-management controls.
        // Keep the explicitly opened file toolbar as a separate sibling so
        // it remains accessible without opening unrelated folder/tag editors.
        library.owner.buildingsPane.insertBefore(this.toolbar,library.owner.contentArea);
    }
    reset(scope=this.library.owner.scope){
        this.controller?.abort();
        this.controller=null;
        this.scope=scope;
        this.busy=false;
        this.enabled=false;
        this.selected.clear();
        this.status.textContent='';
        this.renderToolbar();
    }
    enable(on=true,item=null){
        if(this.busy)return;
        const owner=this.library.owner;
        if(!this.library.data || !owner.scope || owner.scope!==owner.callbacks.currentLibraryScope())return;
        if(this.scope!==owner.scope)this.reset(owner.scope);
        this.enabled=Boolean(on);
        if(!this.enabled) this.selected.clear();
        else if(item && this.selected.size<MAX_BACKUP_CHATS) this.selected.add(cleanChatId(item.id));
        this.renderToolbar();
        this.library.draw();
    }
    toggle(item,checked){
        if(this.busy)return;
        const id=cleanChatId(item.id);
        if(checked && this.selected.size>=MAX_BACKUP_CHATS && !this.selected.has(id)){
            this.status.textContent='한 번에 최대 20개까지 백업할 수 있습니다.';
            return false;
        }
        if(checked)this.selected.add(id);
        else this.selected.delete(id);
        this.renderToolbar();
        return true;
    }
    checkbox(item){
        const checkbox=element('input','stmn-batch-checkbox');
        checkbox.type='checkbox';checkbox.checked=this.selected.has(item.id);
        checkbox.disabled=this.busy;
        checkbox.setAttribute('aria-label',item.name+' 선택');
        checkbox.addEventListener('click',event=>event.stopPropagation());
        checkbox.addEventListener('change',()=>{
            if(!this.toggle(item,checkbox.checked))checkbox.checked=false;
        });
        return checkbox;
    }
    selectFromFiltered(){
        const library=this.library,owner=library.owner;
        const filtered=selectLibraryChats(owner.buildings,owner.scope,library.data,{
            query:owner.search.value,view:library.view,
            folderId:library.folderId,sort:owner.sort.value,
        });
        // Select from full filtered list, not only first virtual page.
        for(const item of filtered){
            if(this.selected.size>=MAX_BACKUP_CHATS)break;
            this.selected.add(item.id);
        }
        this.status.textContent=filtered.length>MAX_BACKUP_CHATS
            ? '최대 20개를 선택했습니다. 나머지는 다음 번에 백업할 수 있습니다.' : '';
        library.draw();
    }
    renderToolbar(){
        const quiet=this.library.owner.view.root.dataset.elevatorTheme==='quiet';
        const visible=this.enabled && quiet && this.library.owner.tab==='buildings';
        this.toolbar.hidden=!visible;
        this.count.textContent=this.selected.size+'개 선택';
        for(const control of [this.selectVisible,this.clearButton,this.exportButton,this.closeButton]){
            control.disabled=this.busy;
        }
        this.exportButton.disabled=this.busy || !this.selected.size;
    }
    async exportSelection(){
        const owner=this.library.owner;
        if(this.busy || !this.selected.size || this.scope!==owner.scope)return false;
        const ids=[...this.selected];
        // Preserve the exact current-scope selections. A stale or
        // cross-character list is rejected at the adapter before any fetch.
        this.busy=true;
        this.controller=new AbortController();
        this.renderToolbar();
        try {
            const {blob,count}=await exportSelectedChats({
                context:owner.callbacks.context,
                scope:this.scope,buildings:owner.buildings,ids,
                signal:this.controller.signal,
                onProgress:({completed,total,name})=>{
                    this.status.textContent=completed===total?'백업 파일 생성 완료.'
                        : '백업 준비 중 '+(completed+1)+'/'+total+' · '+name;
                },
            });
            const timestamp=new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
            downloadBackupBlob(blob,'Elevator-Chat-Backup-'+timestamp+'.zip');
            this.status.textContent=count+'개 JSONL 채팅의 ZIP 다운로드를 요청했습니다. 다운로드 폴더에서 파일을 확인해 주세요.';
            return true;
        } catch(error) {
            this.status.textContent=error?.message||'백업 파일을 만들지 못했습니다.';
            return false;
        } finally {
            this.controller=null;
            this.busy=false;
            this.renderToolbar();
        }
    }
    destroy(){
        this.controller?.abort();
        this.toolbar.remove();
        this.selected.clear();
    }
}
