/** Optional library foundation controls; work is done only on button clicks. */
import {
    MAX_LIBRARY_BACKUP_BYTES, createLibraryBackup, parseLibraryBackup,
    librarySummary, mergeLibrary,
} from './library-data.js';

const node = (tag, text, className) => {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (className) item.className = className;
    return item;
};
function triggerDownload(payload) {
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json;charset=utf-8' }));
    const link = node('a');
    link.href = url;
    link.download = 'stmn-library-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.append(link);
    try { link.click(); } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}

export function installLibraryBackupUI(host, { readLibrary, importLibrary } = {}) {
    if (typeof readLibrary !== 'function' || typeof importLibrary !== 'function') return;
    const panel = node('details', undefined, 'stmn-library-settings');
    panel.append(node('summary', '채팅 관리 데이터 · 백업 및 점검'));
    const body = node('div', undefined, 'stmn-library-controls');
    body.append(node('p',
        '채팅 관리 데이터의 전용 저장소를 점검하고 백업합니다. 현재 채팅 원본·메시지 제목·이미지는 포함되지 않습니다. 별명·폴더 등 관리 UI는 다음 단계에서 추가됩니다.'));
    const actions = node('div', undefined, 'stmn-library-actions');
    const inspectButton = node('button', '관리 데이터 상태 확인');
    const exportButton = node('button', '관리 데이터 JSON 다운로드');
    for (const b of [inspectButton, exportButton]) b.type = 'button';
    actions.append(inspectButton, exportButton);
    const fileLabel = node('label', '관리 데이터 백업 파일 선택');
    const input = node('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    fileLabel.append(input);
    const preview = node('pre', '', 'stmn-library-preview');
    preview.hidden = true;
    const consent = node('label', undefined, 'stmn-library-consent');
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    consent.append(checkbox, document.createTextNode(' 기존 데이터를 덮어쓰지 않고 새 관리 정보만 추가하는 데 동의합니다.'));
    consent.hidden = true;
    const restoreButton = node('button', '관리 데이터 병합 복원');
    restoreButton.type = 'button';
    restoreButton.disabled = true;
    const feedback = node('p', '', 'stmn-library-feedback');
    feedback.setAttribute('role', 'status');
    let pending = null;
    let sequence = 0;
    const clearPending = () => {
        pending = null; checkbox.checked = false; consent.hidden = true; restoreButton.disabled = true;
    };
    checkbox.addEventListener('change', () => { restoreButton.disabled = !(pending && checkbox.checked); });
    inspectButton.addEventListener('click', () => {
        try {
            const summary = librarySummary(readLibrary());
            preview.textContent = '관리 데이터 상태 (읽기 전용)\n' +
                '채팅: ' + summary.chats + ' · 폴더: ' + summary.folders +
                ' · 태그: ' + summary.tags + '\n별명: ' + summary.aliases +
                ' · 즐겨찾기: ' + summary.favorites;
            preview.hidden = false;
            feedback.textContent = '현재 데이터는 올바른 형식입니다. 읽기만 수행했습니다.';
        } catch (error) {
            feedback.textContent = error?.message || '관리 데이터 상태를 확인할 수 없습니다.';
        }
    });
    exportButton.addEventListener('click', () => {
        try {
            triggerDownload(createLibraryBackup(readLibrary(), { version: '1.5.0' }));
            feedback.textContent = '관리 데이터 백업 다운로드를 요청했습니다.';
        } catch (error) {
            feedback.textContent = error?.message || '백업을 생성할 수 없습니다.';
        }
    });
    input.addEventListener('change', async () => {
        const id = ++sequence;
        clearPending();
        preview.hidden = true;
        const file = input.files?.[0];
        if (!file) return;
        if (file.size > MAX_LIBRARY_BYTES + 65536) {
            feedback.textContent = '백업 파일이 허용 크기를 초과했습니다.';
            return;
        }
        try {
            const parsed = parseLibraryBackup(await file.text());
            if (id !== sequence) return;
            // Preview conflict check against the CURRENT state, not an older cache.
            const before = librarySummary(readLibrary());
            const after = librarySummary(mergeLibrary(readLibrary(), parsed.library));
            pending = parsed.library;
            preview.textContent = [
                '백업 날짜: ' + parsed.exportedAt,
                '현재 채팅 관리 항목: ' + before.chats,
                '복원 후 채팅 관리 항목: ' + after.chats,
                '현재 폴더/태그: ' + before.folders + ' / ' + before.tags,
                '복원 후 폴더/태그: ' + after.folders + ' / ' + after.tags,
                '기존 값과 충돌하면 복원이 중단됩니다.',
            ].join('\n');
            preview.hidden = false;
            consent.hidden = false;
            feedback.textContent = '차이를 확인한 후 동의해야 복원됩니다. 미리보기에서는 저장하지 않습니다.';
        } catch (error) {
            if (id === sequence) feedback.textContent = error?.message || '백업 파일을 읽지 못했습니다.';
        }
    });
    restoreButton.addEventListener('click', () => {
        if (!pending || !checkbox.checked) return;
        restoreButton.disabled = true;
        try {
            const result = importLibrary(pending);
            feedback.textContent = result?.changed
                ? '관리 데이터 저장을 요청했습니다. 내보내기로 복원 결과를 확인할 수 있습니다.'
                : '이미 같은 관리 정보가 있습니다. 변경하지 않았습니다.';
            clearPending(); ++sequence; input.value = '';
        } catch (error) {
            feedback.textContent = error?.message || '병합 복원에 실패했습니다.';
            // Retain preview for inspection, but require renewed confirmation.
            checkbox.checked = false;
        }
    });
    body.append(actions, fileLabel, preview, consent, restoreButton, feedback);
    panel.append(body);
    host.append(panel);
}
