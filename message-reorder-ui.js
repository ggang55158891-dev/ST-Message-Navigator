/** Q-11 explicit Quiet message reorder mode: pointer drag + keyboard fallback.
 * The list is virtualized: even a 100k message chat renders ~one viewport. */
import {
    captureReorderSource,verifyReorderSource,moveReorderItem,reorderedCount,
    prepareReorderBackup,applyReorder,
} from './message-reorder.js';
import {getTitle} from './model.js';
import {downloadBackupBlob} from './file-backup.js';

const HEIGHT=58,OVERSCAN=5;
const el=(tag,cls='',text)=>{
    const node=document.createElement(tag);
    if(cls)node.className=cls;
    if(text!==undefined)node.textContent=String(text);
    return node;
};
const button=(text,cls,handler)=>{
    const node=el('button',cls,text);
    node.type='button';
    node.addEventListener('click',handler);
    return node;
};

export class MessageReorderUI{
    constructor(view){
        this.view=view;
        this.active=false;
        this.busy=false;
        this.source=null;
        this.order=[];
        this.backup=null;
        this.drag=null;
        this.savedHidden=null;
        this.cancelPending=false;
        this.raf=null;
        this.edgeRaf=null;

        this.modeBar=el('div','stmn-reorder-entry');
        this.openButton=button('메시지 순서 변경 모드','stmn-reorder-open',
            ()=>this.open());
        this.modeBar.append(this.openButton);
        this.panel=el('section','stmn-reorder-panel');
        this.panel.setAttribute('role','region');
        this.panel.setAttribute('aria-label','드래그로 메시지 순서 변경');
        this.panel.hidden=true;
        this.head=el('div','stmn-reorder-head');
        this.head.append(el('strong','','메시지 순서 변경'));
        this.cancelButton=button('취소 · 변경 폐기','stmn-reorder-cancel',()=>this.reset());
        this.head.append(this.cancelButton);
        this.hint=el('p','stmn-reorder-hint',
            '≡ 손잡이를 드래그해 이동하세요. 여기서는 미리보기만 바뀌며, 적용 전 원본 ZIP 백업이 필요합니다.');
        this.summary=el('div','stmn-reorder-summary');
        this.viewport=el('div','stmn-reorder-viewport');
        this.viewport.setAttribute('role','list');
        this.viewport.setAttribute('aria-label','메시지 순서 미리보기');
        this.spacer=el('div','stmn-reorder-spacer');
        this.viewport.append(this.spacer);
        this.viewport.addEventListener('scroll',()=>this.scheduleRender(),{passive:true});

        this.actions=el('div','stmn-reorder-actions');
        this.resetButton=button('순서 초기화','stmn-reorder-reset',()=>{
            if(this.busy)return;
            this.order=this.source.messages.map((_,i)=>i);
            this.onOrderChanged();
        });
        this.backupButton=button('① 원본 ZIP 다운로드','stmn-reorder-backup',
            ()=>void this.download());
        const confirm=el('label','stmn-reorder-confirm');
        this.checked=el('input');
        this.checked.type='checkbox';
        this.checked.disabled=true;
        this.checked.addEventListener('change',()=>this.update());
        confirm.append(this.checked,document.createTextNode(
            '② 원본 ZIP을 보관했습니다. 메시지의 실제 저장 순서를 변경하는 데 동의합니다.'));
        this.applyButton=button('③ 수정 사항 적용','stmn-reorder-apply',
            ()=>void this.apply());
        this.actions.append(this.resetButton,this.backupButton,confirm,this.applyButton);
        this.status=el('p','stmn-reorder-status');
        this.status.setAttribute('role','status');
        this.panel.append(this.head,this.hint,this.summary,this.viewport,this.actions,this.status);
        view.list.before(this.modeBar,this.panel);
        this.onPointerMove=e=>this.pointerMove(e);
        this.onPointerUp=e=>this.pointerUp(e);
        this.onPointerCancel=()=>this.cancelDrag();
        this.update();
    }

    floorVisible(){
        return this.view.root.dataset.elevatorTheme==='quiet' &&
            this.view.elevator.tab==='floors';
    }
    valid(){
        if(!this.active || !this.floorVisible())return false;
        try{verifyReorderSource(this.view.callbacks.context(),this.source);return true;}
        catch{return false;}
    }
    open(){
        if(this.busy || this.active || !this.floorVisible() ||
           this.view.messageBatch?.busy)return;
        let source;
        try{source=captureReorderSource(this.view.callbacks.context());}
        catch(error){this.view.setStatus(error.message,true);return;}
        this.view.messageBatch?.reset();
        this.view.editing=-1;
        this.source=source;
        this.order=source.messages.map((_,i)=>i);
        this.active=true;
        this.savedHidden={
            list:this.view.list.hidden,search:this.view.searchbox.hidden,
            groups:this.view.groupTools.hidden,jumps:this.view.outlineJumps.hidden,
            batch:this.view.messageBatch?.root.hidden,
        };
        this.view.list.hidden=true;
        this.view.searchbox.hidden=true;
        this.view.groupTools.hidden=true;
        this.view.outlineJumps.hidden=true;
        if(this.view.messageBatch)this.view.messageBatch.root.hidden=true;
        this.panel.hidden=false;
        this.viewport.scrollTop=0;
        this.status.textContent='아직 원본 채팅에 변경된 내용이 없습니다.';
        this.update();
        this.render();
    }
    clearBackup(){
        this.backup=null;
        this.checked.checked=false;
        this.checked.disabled=true;
    }
    onOrderChanged(){
        this.clearBackup();
        this.status.textContent='순서 변경 미리보기입니다. 적용 전 원본 ZIP을 새로 내려받으세요.';
        this.update();
        this.render();
    }
    update(){
        this.modeBar.hidden=!this.floorVisible() || this.active;
        this.openButton.disabled=this.busy || Boolean(this.view.messageBatch?.selectionMode);
        if(!this.active)return;
        const count=this.order.length,changed=reorderedCount(this.order);
        this.summary.textContent=count.toLocaleString()+'개 메시지 · '+
            changed.toLocaleString()+'개 위치 변경 · 실제 채팅에는 아직 미반영';
        this.resetButton.disabled=this.busy || changed===0;
        this.backupButton.disabled=this.busy || changed===0 || !!this.backup;
        this.cancelButton.disabled=this.busy;
        this.checked.disabled=this.busy || !this.backup;
        this.applyButton.disabled=this.busy || changed===0 ||
            !this.backup || !this.checked.checked || !this.valid();
    }
    reset(){
        if(this.busy){this.cancelPending=true;return;}
        this.cancelDrag();
        const hidden=this.savedHidden;
        this.savedHidden=null;
        this.active=false;
        this.source=null;
        this.order=[];
        this.clearBackup();
        this.panel.hidden=true;
        this.spacer.replaceChildren();
        if(hidden){
            this.view.list.hidden=hidden.list;
            this.view.searchbox.hidden=hidden.search;
            this.view.groupTools.hidden=hidden.groups;
            this.view.outlineJumps.hidden=hidden.jumps;
            if(this.view.messageBatch)this.view.messageBatch.root.hidden=hidden.batch;
        }
        this.update();
    }
    invalidate(){this.reset();}
    scheduleRender(){
        if(this.raf!==null || !this.active)return;
        this.raf=requestAnimationFrame(()=>{
            this.raf=null;
            if(this.active)this.render();
        });
    }
    render(){
        if(!this.active || !this.panel.isConnected)return;
        const count=this.order.length,top=this.viewport.scrollTop;
        const visible=Math.max(1,this.viewport.clientHeight||360);
        const start=Math.max(0,Math.floor(top/HEIGHT)-OVERSCAN);
        const end=Math.min(count,Math.ceil((top+visible)/HEIGHT)+OVERSCAN);
        this.spacer.style.height=count*HEIGHT+'px';
        const frag=document.createDocumentFragment();
        for(let i=start;i<end;i++){
            const oldIndex=this.order[i],message=this.source.messages[oldIndex];
            const row=el('div','stmn-reorder-row');
            row.style.top=i*HEIGHT+'px';
            row.dataset.position=String(i);
            row.setAttribute('role','listitem');
            if(i!==oldIndex)row.classList.add('stmn-reorder-changed');
            if(this.drag?.from===i)row.classList.add('stmn-reorder-dragging');
            if(this.drag?.to===i)row.classList.add('stmn-reorder-target');
            const grip=button('⠿','stmn-reorder-handle',()=>{});
            grip.setAttribute('aria-label','원래 #'+oldIndex+' 메시지 드래그 손잡이');
            grip.title='드래그해서 새 위치로 옮기기';
            grip.addEventListener('pointerdown',e=>this.pointerDown(e,i));
            row.append(grip);
            const nums=el('span','stmn-reorder-ids',
                '새 #'+i+' · 원래 #'+oldIndex);
            const body=el('div','stmn-reorder-row-text');
            const title=el('strong','',getTitle(message,this.source.metadata));
            title.title=title.textContent;
            const sub=el('small','',String(message.name||'')+
                (message.is_system?' · 숨김':''));
            body.append(title,sub);
            row.append(nums,body);
            const up=button('↑','stmn-reorder-up',()=>{
                if(i>0)this.move(i,i-1);
            });
            up.setAttribute('aria-label','새 #'+i+' 메시지 한 칸 위로');
            up.disabled=i===0 || this.busy;
            const down=button('↓','stmn-reorder-down',()=>{
                if(i<count-1)this.move(i,i+1);
            });
            down.setAttribute('aria-label','새 #'+i+' 메시지 한 칸 아래로');
            down.disabled=i===count-1 || this.busy;
            row.append(up,down);
            frag.append(row);
        }
        this.spacer.replaceChildren(frag);
    }
    move(from,to){
        if(!this.valid() || this.busy || from===to)return;
        this.order=moveReorderItem(this.order,from,to);
        this.onOrderChanged();
    }
    pointerDown(e,from){
        if(!this.valid() || this.busy || !e.isPrimary || e.button!==0)return;
        e.preventDefault();e.stopPropagation();
        this.drag={pointer:e.pointerId,from,to:from,y:e.clientY};
        window.addEventListener('pointermove',this.onPointerMove,{passive:false});
        window.addEventListener('pointerup',this.onPointerUp);
        window.addEventListener('pointercancel',this.onPointerCancel);
        this.showTarget(from);
        this.edgeRaf=requestAnimationFrame(()=>this.edgeScroll());
    }
    targetAt(y){
        const bounds=this.viewport.getBoundingClientRect();
        const clamped=Math.min(Math.max(y-bounds.top,0),Math.max(0,bounds.height-1));
        return Math.min(this.order.length-1,Math.max(0,
            Math.floor((this.viewport.scrollTop+clamped)/HEIGHT)));
    }
    showTarget(target){
        if(!this.drag)return;
        this.drag.to=target;
        for(const row of this.spacer.querySelectorAll('.stmn-reorder-row')){
            const i=Number(row.dataset.position);
            row.classList.toggle('stmn-reorder-target',i===target);
            row.classList.toggle('stmn-reorder-dragging',i===this.drag.from);
        }
    }
    pointerMove(e){
        if(!this.drag || e.pointerId!==this.drag.pointer)return;
        e.preventDefault();
        this.drag.y=e.clientY;
        this.showTarget(this.targetAt(e.clientY));
    }
    edgeScroll(){
        this.edgeRaf=null;
        if(!this.drag)return;
        const bounds=this.viewport.getBoundingClientRect(),y=this.drag.y;
        const zone=45;
        const dy=y<bounds.top+zone?-18:y>bounds.bottom-zone?18:0;
        if(dy){
            this.viewport.scrollTop+=dy;
            this.showTarget(this.targetAt(y));
            this.scheduleRender();
        }
        this.edgeRaf=requestAnimationFrame(()=>this.edgeScroll());
    }
    pointerUp(e){
        if(!this.drag || e.pointerId!==this.drag.pointer)return;
        const {from}=this.drag;
        const to=this.targetAt(e.clientY);
        this.cancelDrag();
        if(from!==to)this.move(from,to);
    }
    cancelDrag(){
        this.drag=null;
        window.removeEventListener('pointermove',this.onPointerMove);
        window.removeEventListener('pointerup',this.onPointerUp);
        window.removeEventListener('pointercancel',this.onPointerCancel);
        if(this.edgeRaf!==null){
            cancelAnimationFrame(this.edgeRaf);this.edgeRaf=null;
        }
    }
    async download(){
        if(!this.valid() || this.busy || !reorderedCount(this.order))return;
        this.busy=true;this.update();
        this.status.textContent='현재 채팅을 저장하고 원본 JSONL을 검증하고 있습니다…';
        try{
            const backup=await prepareReorderBackup(
                this.view.callbacks.context,this.source);
            if(!this.valid())throw new Error('백업 도중 채팅이 변경됐습니다.');
            downloadBackupBlob(backup.blob,backup.source.id+'-before-reorder.zip');
            this.backup=backup;
            this.status.textContent='ZIP 다운로드를 요청했습니다. 실제 파일을 보관한 다음 확인란을 선택하세요.';
        }catch(error){
            this.clearBackup();
            this.status.textContent='백업 실패: '+(error?.message||'원본 확인 실패')+
                ' · 실제 채팅 순서는 변경하지 않았습니다.';
        }finally{
            this.busy=false;this.update();
        }
    }
    async apply(){
        if(!this.valid() || this.busy || !this.backup || !this.checked.checked ||
           !reorderedCount(this.order))return;
        this.busy=true;this.update();
        this.status.textContent='서버 원본을 다시 확인한 뒤 수정한 순서를 저장하고 검증하고 있습니다…';
        let result=null,problem=null;
        try{
            result=await applyReorder(this.view.callbacks.context,this.backup,
                this.order.slice());
        }catch(error){problem=error;}
        finally{
            this.busy=false;
            this.reset();
        }
        if(problem){
            this.view.setStatus(problem.message,true);
        }else if(result?.changed){
            this.view.rebuild();
            this.view.setStatus(result.reloaded
                ?'메시지 순서 변경 저장·재로드 확인 완료. 원본 ZIP을 보관해 주세요.'
                :'서버 저장은 확인했습니다. '+result.warning,result.reloaded===false);
        }
    }
    destroy(){
        this.busy=false;
        this.reset();
        if(this.raf!==null)cancelAnimationFrame(this.raf);
        this.modeBar.remove();this.panel.remove();
    }
}
