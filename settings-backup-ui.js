import {
    MAX_BACKUP_BYTES, createSettingsBackup, diffSettings, parseSettingsBackup,
} from './settings-backup.js';

const make = (tag, text, className = '') => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
};

function downloadBackup(text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
    const link = make('a');
    const today = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = 'stmn-settings-' + today + '.json';
    document.body.append(link);
    try { link.click(); } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}

export function installSettingsBackupUI(host, { readSettings, restoreSettings, inspectTitles }) {
    if (typeof readSettings !== 'function' || typeof restoreSettings !== 'function') return;
    const panel = make('details', undefined, 'stmn-backup-settings');
    panel.append(make('summary', '설정 백업 · 복원 · 데이터 점검'));
    const body = make('div', undefined, 'stmn-backup-body');
    body.append(make('p',
        '현재는 이 확장의 버튼·테마·탐색·진단 설정만 백업합니다. 메시지 제목과 실제 채팅 파일은 포함되지 않습니다. 외부 서버로 전송하지 않습니다.'));

    const actions = make('div', undefined, 'stmn-backup-actions');
    const exportButton = make('button', '현재 설정 JSON 다운로드');
    exportButton.type = 'button';
    const titleAudit = make('button', '현재 채팅 제목 데이터 점검');
    titleAudit.type = 'button';
    actions.append(exportButton, titleAudit);

    const label = make('label', '설정 복원용 JSON 파일 선택');
    label.htmlFor = 'stmn-backup-file';
    const input = make('input');
    input.type = 'file';
    input.id = 'stmn-backup-file';
    input.accept = '.json,application/json';
    const preview = make('pre', undefined, 'stmn-backup-preview');
    preview.hidden = true;
    const consent = make('label', undefined, 'stmn-backup-confirm');
    const agreed = make('input');
    agreed.type = 'checkbox';
    consent.append(agreed, document.createTextNode(' 위 설정을 덮어쓰는 데 동의합니다.'));
    consent.hidden = true;
    const restore = make('button', '선택한 설정 복원');
    restore.type = 'button';
    restore.disabled = true;
    const feedback = make('p', '', 'stmn-backup-feedback');
    feedback.setAttribute('role', 'status');
    let pending = null;
    let requestId = 0;

    exportButton.addEventListener('click', () => {
        try {
            downloadBackup(createSettingsBackup(readSettings(), { version: '1.4.0' }));
            feedback.textContent = '현재 확장 설정의 JSON 다운로드를 요청했습니다.';
        } catch {
            feedback.textContent = '설정 백업 다운로드에 실패했습니다.';
        }
    });
    titleAudit.addEventListener('click', () => {
        try {
            const summary = inspectTitles?.();
            if (!summary) throw new Error('No metadata available');
            preview.textContent = [
                '현재 채팅 제목 데이터 점검 (읽기 전용)',
                '메시지 수: ' + summary.messages,
                '저장된 사용자 제목 수: ' + summary.customTitles,
                '연결되지 않은 제목: ' + summary.orphanTitles,
                '중복 메시지 ID: ' + summary.duplicateMessageIds,
                '유효하지 않은 제목: ' + summary.invalidTitles,
                '저장 구조 오류: ' + (summary.malformedStore ? '있음' : '없음'),
            ].join('\n');
            preview.hidden = false;
            feedback.textContent = '제목 데이터는 변경하지 않았습니다.';
        } catch {
            feedback.textContent = '제목 데이터 점검에 실패했습니다.';
        }
    });
    const invalidate = () => {
        pending = null;
        agreed.checked = false;
        consent.hidden = true;
        restore.disabled = true;
    };
    agreed.addEventListener('change', () => { restore.disabled = !pending || !agreed.checked; });
    input.addEventListener('change', async () => {
        const seq = ++requestId;
        invalidate();
        preview.hidden = true;
        const file = input.files?.[0];
        if (!file) return;
        if (file.size > MAX_BACKUP_BYTES) {
            feedback.textContent = '최대 32KB의 확장 설정 백업만 가져올 수 있습니다.';
            return;
        }
        try {
            const parsed = parseSettingsBackup(await file.text());
            if (seq !== requestId) return;
            const differences = diffSettings(readSettings(), parsed.settings);
            pending = parsed.settings;
            const displayValue = val => typeof val === 'object' ? JSON.stringify(val) : String(val);
            preview.textContent = [
                '백업 생성: ' + parsed.exportedAt,
                '변경될 설정: ' + differences.length + '개',
                ...differences.map(change => change.key + ': ' +
                    displayValue(change.before) + ' → ' + displayValue(change.after)),
                ...(differences.length ? [] : ['현재 설정과 동일합니다.']),
            ].join('\n');
            preview.hidden = false;
            consent.hidden = false;
            feedback.textContent = '설정 미리보기를 확인하고 동의한 후 복원하세요. 다른 확장의 설정은 건드리지 않습니다.';
        } catch (error) {
            if (seq === requestId) feedback.textContent = error?.message || '백업 파일을 읽을 수 없습니다.';
        }
    });
    restore.addEventListener('click', () => {
        if (!pending || !agreed.checked) return;
        const settings = pending;
        // Never restore unknown data, and never mutate until preview/consent.
        try {
            restoreSettings(settings);
            feedback.textContent = '확장 설정 복원을 요청했습니다. 버튼과 테마가 갱신되었습니다.';
            ++requestId;
            invalidate();
            input.value = '';
        } catch (error) {
            feedback.textContent = error?.message || '설정 복원 중 오류가 발생했습니다.';
        }
    });
    body.append(actions, label, input, preview, consent, restore, feedback);
    panel.append(body);
    host.append(panel);
}
