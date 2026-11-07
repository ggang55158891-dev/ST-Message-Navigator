import {inspectRuntimeCompatibility} from './compatibility-preflight.js';

/**
 * Diagnostic settings UI. All exported data comes from the strict Diagnostics
 * serializer; never include original chat text, IDs, names or exception messages.
 */
export function installDiagnosticsSettings(container, settings, onChange, diagnostics, contextProvider) {
    if (!diagnostics) return;
    const create = (tag, label = '', className = '') => {
        const node = document.createElement(tag);
        if (label) node.textContent = label;
        if (className) node.className = className;
        return node;
    };
    const details = create('details', '', 'stmn-diagnostics');
    details.id = 'stmn-diagnostics';
    details.append(create('summary', '오류 진단 및 내보내기'));
    const body = create('div', '', 'stmn-diagnostics-body');
    const desc = create('p',
        '자세한 진단은 기본적으로 꺼져 있습니다. 오류는 꺼진 상태에서도 최근 항목만 메모리에 보관합니다. 채팅 원문·파일명·캐릭터명·오류 메시지는 수집하지 않습니다.');
    // H-01: one opt-in, read-only availability check. Unlike a destructive
    // self-test it never invokes any ST mutation or opens browser storage.
    const environment = create('div','','stmn-environment-check');
    const environmentButton=create('button','사용 환경 점검 (읽기 전용)');
    environmentButton.type='button';
    environmentButton.className='stmn-environment-check-button';
    const environmentResult=create('div','','stmn-environment-check-result');
    environmentResult.setAttribute('role','status');
    environmentResult.hidden=true;
    environmentButton.addEventListener('click',()=>{
        try{
            const report=inspectRuntimeCompatibility(contextProvider);
            const heading=create('p',
                '준비 확인 '+report.ready+'개 · 추가 확인 '+report.needsAttention+'개');
            const list=create('ul');
            for(const check of report.checks){
                const item=create('li');
                item.textContent=(check.status==='ready'?'✓ ':'! ')+check.label+
                    (check.status==='ready'?' · 인터페이스 확인':' · '+check.help);
                list.append(item);
            }
            const note=create('p',report.note);
            environmentResult.replaceChildren(heading,list,note);
            environmentResult.hidden=false;
        }catch{
            environmentResult.textContent='점검 중 오류가 발생했습니다. SillyTavern을 다시 열어 주세요.';
            environmentResult.hidden=false;
        }
    });
    environment.append(environmentButton,environmentResult);
    const label = create('label', '', 'stmn-diagnostics-toggle');
    const toggle = create('input');
    toggle.type = 'checkbox';
    toggle.id = 'stmn-diagnostics-enabled';
    toggle.checked = settings.diagnosticsEnabled === true;
    toggle.addEventListener('change', () => onChange('diagnosticsEnabled', toggle.checked));
    label.append(toggle, document.createTextNode(' 자세한 진단 기록 켜기'));

    const actions = create('div', '', 'stmn-diagnostics-actions');
    const preview = create('button', '기록 미리보기');
    const download = create('button', 'JSON 다운로드');
    const clear = create('button', '기록 지우기');
    for (const button of [preview, download, clear]) button.type = 'button';
    actions.append(preview, download, clear);

    const feedback = create('p', '', 'stmn-diagnostics-feedback');
    feedback.setAttribute('role', 'status');
    const output = create('pre', '', 'stmn-diagnostics-preview');
    output.hidden = true;
    output.setAttribute('aria-label', '최근 진단 이벤트 미리보기');

    const refresh = () => {
        const events = diagnostics.snapshot();
        // Display at most the 20 most recent events, still schema-sanitized.
        output.textContent = JSON.stringify(events.slice(-20), null, 2);
        output.hidden = false;
        feedback.textContent = events.length + '개 이벤트 (최근 20개 미리보기)';
    };
    preview.addEventListener('click', refresh);
    clear.addEventListener('click', () => {
        diagnostics.clear();
        feedback.textContent = '진단 기록을 지웠습니다.';
        output.textContent = '';
        output.hidden = true;
    });
    download.addEventListener('click', () => {
        try {
            const text = diagnostics.exportJSON({ extensionVersion: '1.29.0' });
            const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = 'stmn-diagnostics.json';
            document.body.append(link);
            try {
                link.click();
            } finally {
                link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            }
            feedback.textContent = '진단 JSON 다운로드를 요청했습니다. 공유하기 전에 내용을 확인하세요.';
        } catch {
            feedback.textContent = '다운로드가 실패했습니다. 브라우저 파일 저장 권한을 확인하세요.';
        }
    });
    body.append(desc, environment, label, actions, feedback, output);
    details.append(body);
    container.append(details);
}
