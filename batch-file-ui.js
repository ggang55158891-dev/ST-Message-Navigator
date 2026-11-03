/**
 * Q-07A ZIP backup + Q-08/G-01 non-destructive batch organization.
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
            this.closeOrganization();
            this.selected.clear();this.library.draw();
        });
        this.organizeButton=button('일괄 정리','stmn-batch-action',()=>this.openOrganization());
        this.exportButton=button('원본 백업 ZIP','stmn-batch-export',()=>void this.exportSelection());
        this.closeButton=button('완료','stmn-batch-action',()=>this.enable(false));
        this.status=element('small','stmn-batch-status','');
        this.status.setAttribute('role','status');
        this.toolbar.append(this.count,this.selectVisible,this.clearButton,
            this.organizeButton,this.exportButton,this.closeButton);
        this.bulkForm=element('form','stmn-batch-organize');
        this.bulkForm.hidden=true;
        const caption=element('span','stmn-batch-organize-caption','선택한 채팅의 관리 정보만 수정합니다. 실제 JSONL은 변경하지 않습니다.');
        this.bulkMode=element('select','stmn-batch-operation');
        this.bulkMode.setAttribute('aria-label','일괄 정리 종류');
        for(const [value,label] of [
            ['folder','폴더 이동'],['favorite-add','즐겨찾기 추가'],
            ['favorite-remove','즐겨찾기 해제'],['tag-add','태그 추가'],
            ['tag-remove','태그 제거'],
        ]){
            const option=element('option','',label);
            option.value=value;this.bulkMode.append(option);
        }
        this.bulkMode.addEventListener('change',()=>this.renderOrganizationTargets());
        this.bulkTarget=element('select','stmn-batch-target');
        this.bulkTarget.setAttribute('aria-label','일괄 정리 대상 폴더 또는 태그');
        this.bulkSubmit=button('선택한 채팅에 적용','stmn-batch-export',()=>{});
        this.bulkSubmit.type='submit';
        this.bulkCancel=button('취소','stmn-batch-action',()=>this.closeOrganization());
        this.bulkForm.append(caption,this.bulkMode,this.bulkTarget,this.bulkSubmit,this.bulkCancel);
        this.bulkForm.addEventListener('submit',event=>{
            event.preventDefault();this.applyOrganization();
        });
        this.toolbar.append(this.bulkForm,this.status);
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
        this.closeOrganization();
        this.renderToolbar();
    }
    enable(on=true,item=null){
        if(this.busy)return;
        const owner=this.library.owner;
        if(!this.library.data || !owner.scope || owner.scope!==owner.callbacks.currentLibraryScope())return;
        if(this.scope!==owner.scope)this.reset(owner.scope);
        this.enabled=Boolean(on);
        if(!this.enabled){
            this.closeOrganization();
            this.selected.clear();
        }
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
        this.closeOrganization();
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
        this.closeOrganization();
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
        if(!visible)this.closeOrganization();
        for(const control of [this.selectVisible,this.clearButton,this.organizeButton,
            this.exportButton,this.closeButton]){
            control.disabled=this.busy;
        }
        this.exportButton.disabled=this.busy || !this.selected.size;
        this.organizeButton.disabled=this.busy || !this.selected.size;
    }
    closeOrganization(){
        this.bulkForm.hidden=true;
        this.bulkPending=null;
    }
    openOrganization(){
        const owner=this.library.owner;
        if(this.busy || owner.busy || this.library.fileActions?.busy ||
           !this.enabled || !this.selected.size || this.scope!==owner.scope ||
           this.scope!==owner.callbacks.currentLibraryScope())return false;
        this.bulkPending={scope:this.scope,ids:[...this.selected]};
        this.bulkMode.value='folder';
        this.bulkForm.hidden=false;
        this.renderOrganizationTargets();
        this.bulkMode.focus();
        return true;
    }
    renderOrganizationTargets(){
        const data=this.library.data;
        this.bulkTarget.replaceChildren();
        const mode=this.bulkMode.value;
        this.bulkTarget.hidden=!['folder','tag-add','tag-remove'].includes(mode);
        const choices=mode==='folder'
            ?[['','미분류'],...(data?.folders||[]).map(x=>[x.id,x.name])]
            :['tag-add','tag-remove'].includes(mode)
                ?(data?.tags||[]).map(x=>[x.id,x.name]):[];
        for(const [value,label] of choices){
            const opt=element('option','',label);opt.value=value;this.bulkTarget.append(opt);
        }
        this.bulkSubmit.disabled=this.bulkTarget.hidden?false:!choices.length;
    }
    applyOrganization(){
        const owner=this.library.owner;
        const pending=this.bulkPending;
        if(!pending || this.bulkForm.hidden || this.busy)return false;
        try{
            if(owner.busy || this.library.fileActions?.busy ||
               pending.scope!==this.scope || pending.scope!==owner.scope ||
               pending.scope!==owner.callbacks.currentLibraryScope() ||
               pending.ids.length!==this.selected.size ||
               pending.ids.some(x=>!this.selected.has(x)))
                throw new Error('선택 상태 또는 채팅 범위가 변경됐습니다. 다시 선택해 주세요.');
            const mode=this.bulkMode.value;
            const value=mode==='folder'?(this.bulkTarget.value||null):
                (mode.startsWith('tag-')?this.bulkTarget.value:null);
            const result=owner.callbacks.libraryRepository.bulkUpdate({
                scope:pending.scope,ids:pending.ids,
                availableIds:owner.buildings.map(x=>cleanChatId(x.id)),
                operation:mode,value,
            });
            this.library.data=result.library;
            this.closeOrganization();
            this.status.textContent=result.changed
                ?result.changed+'개 채팅의 폴더·즐겨찾기·태그 설정 저장을 요청했습니다.'
                :'이미 같은 설정입니다. 변경된 채팅은 없습니다.';
            this.library.draw();
            return true;
        }catch(error){
            this.status.textContent='일괄 정리를 적용하지 못했습니다: '+error.message;
            return false;
        }
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
        this.closeOrganization();
        this.toolbar.remove();
        this.selected.clear();
    }
}
