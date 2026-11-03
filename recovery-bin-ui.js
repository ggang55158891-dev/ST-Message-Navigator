/**
 * Q-07C recovery drawer, lazy/explicit. No payloads loaded while rendering
 * the list; raw JSONL is fetched and checksum-verified only for restore/export.
 */
import {buildingScope} from './building-data.js';
import {restoreFromVault,archiveAsZip} from './recovery-operations.js';
import {downloadBackupBlob} from './file-backup.js';

const el=(tag,cls='',text)=>{
    const e=document.createElement(tag);if(cls)e.className=cls;
    if(text!==undefined)e.textContent=String(text);return e;
};
const btn=(text,fn)=>{
    const b=el('button','stmn-bin-button',text);b.type='button';
    b.addEventListener('click',fn);return b;
};
export class RecoveryBinUI {
    constructor(actions){
        this.actions=actions;
        this.library=actions.library;
        this.owner=this.library.owner;
        this.busy=false;
        this.opened=false;
        this.panel=el('section','stmn-recovery-bin');
        this.panel.hidden=true;
        this.panel.setAttribute('aria-label','엘리베이터 복구 보관함');
        const header=el('div','stmn-bin-header');
        header.append(el('strong','','복구 보관함'));
        header.append(btn('닫기',()=>this.close()));
        const intro=el('p','stmn-bin-note',
            '채팅 변경 전에 브라우저에 자동 보관한 사본입니다. 브라우저 데이터 삭제나 저장 공간 회수 시 사라질 수 있습니다. 중요한 기록은 ZIP으로 별도 보관하세요.');
        const row=el('div','stmn-bin-controls');
        const label=el('label','','자동 보관 기간');
        this.retention=el('select');
        this.retention.setAttribute('aria-label','복구 보관 기간');
        for(const [value,name] of [[7,'7일'],[30,'30일'],[90,'90일'],[0,'무기한']]){
            const opt=el('option','',name);opt.value=String(value);
            this.retention.append(opt);
        }
        this.retention.addEventListener('change',()=>void this.changeRetention());
        label.append(this.retention);
        this.refreshButton=btn('새로고침',()=>void this.refresh());
        row.append(label,this.refreshButton);
        this.status=el('p','stmn-bin-status');
        this.status.setAttribute('role','status');
        this.list=el('div','stmn-bin-list');
        this.panel.append(header,intro,row,this.status,this.list);
        this.owner.buildingsPane.insertBefore(this.panel,this.owner.contentArea);
    }
    async open(){
        if(this.actions.disposed)return;
        if(this.owner.view.root.dataset.elevatorTheme!=='quiet')
            return;
        this.owner.setTab('buildings');
        this.actions.reset();
        this.opened=true;this.panel.hidden=false;
        try{
            this.retention.value=String(await this.actions.vault.retention());
            await this.refresh();
        }catch(error){this.status.textContent=error.message;}
        this.panel.scrollIntoView({block:'nearest'});
    }
    close(){
        if(this.busy)return;
        this.opened=false;this.panel.hidden=true;
        this.list.replaceChildren();this.status.textContent='';
    }
    async changeRetention(){
        try{
            await this.actions.vault.setRetention(Number(this.retention.value));
            await this.refresh();
            this.status.textContent='보관 기간을 변경했습니다. 기한이 지난 완료 기록은 다음 목록 갱신 때 정리됩니다.';
        }catch(error){this.status.textContent=error.message;}
    }
    async refresh(){
        if(!this.opened || this.busy)return;
        this.busy=true;this.refreshButton.disabled=true;
        try{
            await this.actions.vault.pruneExpired();
            const rows=await this.actions.vault.list();
            this.list.replaceChildren();
            if(!rows.length){this.list.append(el('p','stmn-bin-empty','아직 보관된 채팅이 없습니다.'));return;}
            const currentScope=buildingScope(this.owner.callbacks.context());
            for(const meta of rows.slice(0,250)){
                const card=el('article','stmn-bin-entry');
                card.append(el('strong','',meta.name));
                const state={
                    prepared:'작업 준비',uncertain:'결과 확인 필요',
                    deleted:'삭제 후 보관',renamed:'이름 변경 전 보관',restored:'복구 기록',
                }[meta.state]||meta.state;
                card.append(el('small','',
                    new Date(meta.createdAt).toLocaleString()+' · '+state+' · '+(meta.bytes/1024).toFixed(1)+'KB'));
                const sub=el('small','',meta.scope+(meta.expiresAt?
                    ' · 만료 '+new Date(meta.expiresAt).toLocaleDateString():' · 무기한 보관'));
                card.append(sub);
                const buttons=el('div','stmn-bin-item-actions');
                const restore=btn('복구본 만들기',()=>void this.restore(meta.id));
                restore.disabled=meta.scope!==currentScope;
                restore.title=restore.disabled?'복구하려면 원래 캐릭터 또는 그룹을 선택해 주세요.':
                    '원래 채팅을 덮어쓰지 않고 별도의 새 채팅으로 복구합니다.';
                const exportButton=btn('원본 ZIP',()=>void this.download(meta.id));
                const remove=btn('보관본 삭제',()=>void this.remove(meta.id,meta.name));
                buttons.append(restore,exportButton,remove);
                card.append(buttons);
                this.list.append(card);
            }
        }catch(error){this.status.textContent='보관함을 불러오지 못했습니다: '+error.message;}
        finally{this.busy=false;this.refreshButton.disabled=false;}
    }
    async withBusy(task){
        if(this.busy)return;
        this.busy=true;
        for(const button of this.panel.querySelectorAll('button,select'))button.disabled=true;
        try{await task();}
        catch(error){this.status.textContent=error.message;}
        finally{
            this.busy=false;
            for(const button of this.panel.querySelectorAll('button,select'))button.disabled=false;
            await this.refresh();
        }
    }
    async download(id){
        await this.withBusy(async()=>{
            const {blob,name}=await archiveAsZip(this.actions.vault,id);
            downloadBackupBlob(blob,'Elevator-Recovery-'+name);
            this.status.textContent='원본 JSONL ZIP 다운로드를 요청했습니다. 다운로드 폴더에서 확인해 주세요.';
        });
    }
    async restore(id){
        await this.withBusy(async()=>{
            const result=await restoreFromVault({
                vault:this.actions.vault,context:this.owner.callbacks.context,
                archiveId:id,libraryRepository:this.actions.libraryRepository,
            });
            this.status.textContent='새 채팅 "'+result.newId+'"으로 복구했습니다.'+
                (result.warning?' 주의: '+result.warning:'');
            void this.owner.refreshBuildings(true);
        });
    }
    async remove(id,name){
        if(!window.confirm('"' + name + '" 복구용 사본을 영구 삭제할까요? 이 작업은 되돌릴 수 없습니다.'))return;
        await this.withBusy(async()=>{
            await this.actions.vault.remove(id);
            this.status.textContent='보관본을 삭제했습니다.';
        });
    }
    destroy(){this.panel.remove();}
}
