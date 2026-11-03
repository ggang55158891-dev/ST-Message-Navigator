/**
 * Git-backed extension updater. SillyTavern owns update/version APIs and
 * authentication; no direct git commands or public GitHub-version guesses.
 */
export const EXTENSION_FOLDER = 'ST-Message-Navigator';
export const EXTENSION_VERSION = '1.9.0';

/** Values are untrusted HTTP response data, never HTML. */
export function parseExtensionVersion(payload) {
    if (!payload || typeof payload !== 'object' ||
        typeof payload.isUpToDate !== 'boolean') {
        throw new Error('업데이트 상태 응답이 올바르지 않습니다.');
    }
    const branch = typeof payload.currentBranchName === 'string'
        ? payload.currentBranchName.slice(0, 100) : '';
    const remote = typeof payload.remoteUrl === 'string'
        ? payload.remoteUrl.slice(0, 500) : '';
    const commit = typeof payload.currentCommitHash === 'string'
        ? payload.currentCommitHash.slice(0, 12) : '';
    if (!branch || !remote || !commit) throw new Error(
        'Git으로 설치한 확장에서만 자동 업데이트를 사용할 수 있습니다.');
    return { isUpToDate:payload.isUpToDate,branch,remote,commit };
}

export function installExtensionUpdateUI(host, contextProvider = () => window.SillyTavern?.getContext?.()) {
    if (!host) return {check:async()=>{},destroy(){}};
    const wrapper = document.createElement('div');
    wrapper.className = 'stmn-update-controls';
    const button = document.createElement('button');
    button.type = 'button'; button.id = 'stmn-update-button';
    button.className = 'stmn-update-button';
    button.textContent = '업데이트 확인';
    const version = document.createElement('span');
    version.className = 'stmn-update-version';
    version.textContent = '현재 v' + EXTENSION_VERSION;
    const feedback = document.createElement('small');
    feedback.className = 'stmn-update-feedback';
    feedback.setAttribute('role','status');
    feedback.textContent = '설치한 Git 브랜치의 변경 사항을 확인합니다.';
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'stmn-update-reload';
    reload.textContent = '새로고침하여 적용';
    reload.hidden = true;
    reload.addEventListener('click', () => location.reload());
    wrapper.append(button,version,feedback,reload);
    host.prepend(wrapper);
    let state = 'idle';
    let installedBranch = '';
    let isGlobal = false;
    let destroyed = false;
    const setState = (next,label) => {
        if (destroyed) return;
        state = next;
        wrapper.dataset.updateState = next;
        feedback.textContent = label;
        button.disabled = next === 'checking' || next === 'updating' || next === 'updated';
        button.textContent = next === 'available' ? '업데이트 설치' :
            next === 'checking' ? '업데이트 확인 중…' :
            next === 'updating' ? '업데이트 설치 중…' :
            next === 'updated' ? '업데이트 완료' : '업데이트 확인';
    };
    async function headers() {
        const ctx = contextProvider();
        if (typeof ctx?.getRequestHeaders !== 'function') throw new Error(
            'SillyTavern 인증 헤더를 사용할 수 없습니다.');
        // Match the global/local extension scope selected by SillyTavern.
        // If the extension manager API isn't loaded, ST defaults to local.
        try {
            const { extensionTypes } = await import('../../../extensions.js');
            const key = 'third-party/' + EXTENSION_FOLDER;
            isGlobal = extensionTypes?.[key] === 'global';
        } catch {
            isGlobal = false;
        }
        return ctx.getRequestHeaders();
    }
    async function post(endpoint) {
        const header = await headers();
        const response = await fetch(endpoint, {
            method:'POST',headers:header,
            body:JSON.stringify({extensionName:EXTENSION_FOLDER,global:isGlobal}),
        });
        if (!response.ok) {
            const detail = (await response.text().catch(()=>'')).slice(0,160);
            throw new Error(response.status === 403
                ? '관리자 권한이 필요한 전역 확장입니다.'
                : '서버 요청 실패 (' + response.status + '): ' + detail);
        }
        return response.json();
    }
    async function check() {
        if (destroyed || ['checking','updating','updated'].includes(state)) return;
        setState('checking','현재 설치된 Git 브랜치를 확인하고 있습니다.');
        try {
            const result = parseExtensionVersion(await post('/api/extensions/version'));
            installedBranch = result.branch;
            setState(result.isUpToDate ? 'current' : 'available',
                result.isUpToDate
                    ? '최신 상태 · ' + result.branch + ' · ' + result.commit
                    : '업데이트 가능 · ' + result.branch + ' · ' + result.commit);
        } catch (error) {
            setState('error',error?.message || '업데이트 확인에 실패했습니다.');
        }
    }
    async function update() {
        if (state !== 'available' || destroyed) return;
        setState('updating',installedBranch + ' 브랜치에서 업데이트를 내려받고 있습니다.');
        try {
            const result = await post('/api/extensions/update');
            if (typeof result?.isUpToDate !== 'boolean') throw new Error('업데이트 응답이 올바르지 않습니다.');
            if (result.isUpToDate) {
                setState('current','이미 최신 상태입니다. (Git 브랜치: '+installedBranch+')');
            } else {
                setState('updated','업데이트가 설치되었습니다. 페이지를 새로고침하면 적용됩니다.');
                reload.hidden = false;
            }
        } catch (error) {
            setState('error',error?.message || '업데이트를 설치하지 못했습니다.');
        }
    }
    button.addEventListener('click', () => state === 'available' ? void update() : void check());
    // A single asynchronous check when the settings are installed. No polling.
    void check();
    return {check,update,destroy(){destroyed=true;wrapper.remove();}};
}
