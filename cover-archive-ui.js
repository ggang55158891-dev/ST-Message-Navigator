/**
 * D-05B explicit controls. No IndexedDB read, import or mutation on startup.
 * The two opt-in operations are separate: install verified image bytes, and
 * optionally merge nonconflicting Library records.
 */
import {ChatCoverStore} from './chat-cover-store.js';
import {
    COVER_ARCHIVE_MAX_BYTES,createPortableCoverArchive,readPortableCoverArchive,
    previewCoverLibraryMerge,restorePortableCoverArchive,
    inspectCoverCleanup,executeCoverCleanup,
} from './cover-archive.js';
import {downloadBackupBlob} from './file-backup.js';

const el=(tag,cls='',value)=>{
    const node=document.createElement(tag);
    if(cls)node.className=cls;
    if(value!==undefined)node.textContent=String(value);
    return node;
};
const button=(label,fn)=>{
    const b=el('button','',label);
    b.type='button';b.addEventListener('click',fn);return b;
};
const check=(text)=>{
    const label=el('label','stmn-cover-consent');
    const input=el('input');input.type='checkbox';
    label.append(input,document.createTextNode(' '+text));
    return {label,input};
};
export function installCoverArchiveUI(host,{
    readLibrary,importLibrary,onCoverRestored,
}={}){
    if(typeof readLibrary!=='function'||
       typeof importLibrary!=='function')return;
    const store=new ChatCoverStore();
    const root=el('details','stmn-cover-settings');
    root.append(el('summary','', '채팅 표지 이미지 · 통합 ZIP 백업 / 복원 / 정리'));
    const body=el('div','stmn-cover-settings-body');
    root.append(body);
    body.append(el('p','',
        '포터블 ZIP에는 현재 브라우저의 표지 이미지와 채팅 관리 정보 JSON이 함께 들어갑니다. 채팅 원본 JSONL·메시지는 포함되지 않습니다. 새 PC에서도 같은 ZIP으로 표지와 관리 정보를 복원할 수 있습니다.'));
    const backup=button('전체 표지·관리 정보 ZIP 다운로드',()=>void exportArchive());
    const scan=button('미사용 표지 상태 점검',()=>void inspectUnused());
    const header=el('div','stmn-cover-actions');header.append(backup,scan);
    body.append(header);
    const select=el('label','stmn-cover-upload','복원할 포터블 표지 ZIP 선택');
    const picker=el('input');picker.type='file';picker.accept='.zip,application/zip';
    select.append(picker);
    body.append(select);
    const output=el('pre','stmn-cover-report');
    output.hidden=true;
    body.append(output);
    const libraryOption=check('이미지와 함께 백업의 별명·폴더·태그·즐겨찾기 등 관리 정보도 병합 (기존 값은 덮어쓰지 않음)');
    const installConsent=check('ZIP 내용과 추가/병합 정책을 확인했습니다.');
    const restore=button('검증된 표지 ZIP 복원',()=>void doRestore());
    const restoreGroup=el('div','stmn-cover-restore');
    restoreGroup.hidden=true;restore.disabled=true;
    restoreGroup.append(libraryOption.label,installConsent.label,restore);
    body.append(restoreGroup);
    const cleanupTitle=el('strong','stmn-cover-cleanup-heading','미사용 이미지 정리');
    const cleanupWarning=el('p','',
        '참조 여부는 현재 관리 정보만 검사합니다. 과거 JSON 백업이나 다른 브라우저의 참조까지 알 수 없으므로 자동 삭제하지 않습니다. 위의 전체 ZIP을 이 세션에서 내려받고 실제 보관을 확인해야 정리할 수 있습니다.');
    const cleanupReport=el('p','stmn-cover-cleanup-preview');
    const cleanupConsent=check('통합 ZIP을 실제로 보관했고, 현재 관리 정보에서 참조하지 않는 이미지의 로컬 삭제에 동의합니다.');
    const remove=button('미사용 이미지 정리 실행',()=>void doPrune());
    remove.disabled=true;
    const cleanup=el('div','stmn-cover-cleanup');
    cleanup.append(cleanupTitle,cleanupWarning,cleanupReport,cleanupConsent.label,remove);
    cleanup.hidden=true;
    body.append(cleanup);
    const feedback=el('p','stmn-cover-feedback');
    feedback.setAttribute('role','status');
    body.append(feedback);
    let busy=false,sequence=0,pending=null,plan=null,exported=null;

    const pendingReset=()=>{
        pending=null;installConsent.input.checked=false;
        libraryOption.input.checked=false;
        restoreGroup.hidden=true;restore.disabled=true;
        output.hidden=true;output.textContent='';
    };
    const clearCleanup=()=>{
        plan=null;cleanup.hidden=true;cleanupConsent.input.checked=false;
        remove.disabled=true;
    };
    const setBusy=value=>{
        busy=value;
        backup.disabled=scan.disabled=picker.disabled=value;
        restore.disabled=value || !pending || !installConsent.input.checked;
        libraryOption.input.disabled=value;
        installConsent.input.disabled=value;
        cleanupConsent.input.disabled=value;
        remove.disabled=value || !plan || !plan.unused.length ||
            !cleanupConsent.input.checked || !exported ||
            JSON.stringify(exported.keys)!==JSON.stringify(plan.keys) ||
            JSON.stringify(exported.used)!==JSON.stringify(plan.used) ||
            plan.missing.length>0;
    };
    const note=(text,error=false)=>{
        feedback.textContent=text;
        feedback.dataset.error=String(error);
    };
    const verifyMergeOption=()=>{
        if(!pending)return;
        try{
            const preview=previewCoverLibraryMerge(readLibrary(),pending,{
                includeLibrary:libraryOption.input.checked,
            });
            output.textContent=[
                'ZIP 내보낸 날짜: '+pending.exportedAt,
                '포함된 이미지: '+pending.assets.length+'개',
                '이미지 데이터 복원은 기존 동일 SHA-256 파일을 덮어쓰지 않습니다.',
                '관리 정보 병합: '+(libraryOption.input.checked?
                    (preview.changed?'충돌 없이 새 항목만 추가':'변경할 항목 없음'):
                    '선택하지 않음 · 이미지만 복원'),
            ].join('\n');
            note('ZIP 검증 완료. 미리보기만 수행했고 아직 저장하지 않았습니다.');
        }catch(error){
            libraryOption.input.checked=false;
            note('관리 정보 병합이 기존 값과 충돌합니다. 이미지 파일만 복원할 수 있습니다: '+error.message,true);
            output.textContent='관리 정보 병합 충돌 감지 · 기존 데이터는 보호됩니다.';
        }
    };
    installConsent.input.addEventListener('change',()=>setBusy(busy));
    libraryOption.input.addEventListener('change',()=>{
        installConsent.input.checked=false;
        verifyMergeOption();setBusy(busy);
    });
    cleanupConsent.input.addEventListener('change',()=>setBusy(busy));

    async function exportArchive(){
        if(busy)return;
        setBusy(true);note('로컬 표지·관리 정보를 읽고 ZIP 해시를 검증하는 중…');
        try{
            const result=await createPortableCoverArchive(store,readLibrary());
            downloadBackupBlob(result.blob,result.filename);
            exported={keys:result.refs,used:result.used};
            clearCleanup();
            note('통합 ZIP 다운로드를 요청했습니다: 이미지 '+result.refs.length+
                '개, 총 '+Math.ceil(result.blob.size/1024)+'KB. 실제 파일 저장을 확인하세요.');
        }catch(error){
            exported=null;clearCleanup();
            note('통합 표지 백업 실패: '+error.message,true);
        }finally{setBusy(false);}
    }
    picker.addEventListener('change',async()=>{
        const id=++sequence;
        pendingReset();clearCleanup();
        exported=null;
        const file=picker.files?.[0];
        if(!file)return;
        if(file.size>COVER_ARCHIVE_MAX_BYTES){
            note('ZIP 파일이 36MB 상한을 초과했습니다.',true);return;
        }
        setBusy(true);note('ZIP 구조·CRC32·SHA-256·관리 정보 참조를 검증하는 중…');
        try{
            const parsed=await readPortableCoverArchive(file);
            if(id!==sequence)return;
            pending=parsed;output.hidden=false;restoreGroup.hidden=false;
            verifyMergeOption();
        }catch(error){
            if(id===sequence)note('ZIP 복원 검증 실패: '+error.message,true);
        }finally{setBusy(false);}
    });
    async function doRestore(){
        if(busy || !pending || !installConsent.input.checked)return;
        setBusy(true);
        const archive=pending,withLibrary=libraryOption.input.checked;
        note('로컬 이미지와 선택한 관리 정보를 충돌 없이 복원하는 중…');
        try{
            const result=await restorePortableCoverArchive(store,archive,{
                readLibrary,importLibrary,includeLibrary:withLibrary,
            });
            pendingReset();picker.value='';
            clearCleanup();exported=null;
            if(typeof onCoverRestored==='function')await onCoverRestored();
            note('복원 및 이미지 재조회 검증 완료: 새 이미지 '+result.added+
                '개 · 기존 이미지 '+result.existing+'개 · 관리 정보 '+
                (result.libraryChanged?'새 항목 병합 요청':'변경 없음')+
                '. 채팅 원본 JSONL은 수정하지 않았습니다.');
        }catch(error){
            // If a different store (Library) refused a late save, images may
            // already have been installed. Avoid misreporting a rollback.
            installConsent.input.checked=false;
            note('복원 확인 필요: '+error.message+
                ' · 이미지 일부가 이미 추가됐을 수 있습니다. 다시 상태를 점검하세요.',true);
        }finally{setBusy(false);}
    }
    async function inspectUnused(){
        if(busy)return;
        clearCleanup();setBusy(true);
        note('현재 관리 정보의 모든 캐릭터·그룹 표지 참조를 검사 중…');
        try{
            plan=await inspectCoverCleanup(store,readLibrary());
            cleanup.hidden=false;
            cleanupReport.textContent='보관 이미지 '+plan.keys.length+'개 · 사용 중 '+
                (plan.keys.length-plan.unused.length)+'개 · 미사용 '+
                plan.unused.length+'개 · 참조하지만 없는 이미지 '+
                plan.missing.length+'개.';
            note(plan.missing.length
                ?'참조된 이미지가 누락됐습니다. 다시 등록해야 하며, 이 상태에서는 정리할 수 없습니다.'
                :plan.unused.length
                    ?'미사용 이미지가 있습니다. 삭제하려면 먼저 최신 전체 ZIP을 다운로드하고 보관하세요.'
                    :'정리할 미사용 이미지가 없습니다.');
        }catch(error){
            clearCleanup();
            note('표지 상태 점검 실패: '+error.message,true);
        }finally{setBusy(false);}
    }
    async function doPrune(){
        if(busy || !plan || !plan.unused.length || !cleanupConsent.input.checked ||
           !exported || JSON.stringify(exported.keys)!==JSON.stringify(plan.keys) ||
           JSON.stringify(exported.used)!==JSON.stringify(plan.used))return;
        setBusy(true);
        try{
            const result=await executeCoverCleanup(store,readLibrary,plan);
            exported=null;clearCleanup();
            note('미사용 표지 '+result.deleted+'개를 로컬 보관함에서 삭제했습니다. 다운로드한 통합 ZIP은 계속 보관하세요.');
        }catch(error){
            clearCleanup();
            note('정리 중단: '+error.message+' 삭제 결과가 불확실하면 로컬 보관함을 다시 점검하세요.',true);
        }finally{setBusy(false);}
    }
    host.append(root);
    return {root,store};
}
