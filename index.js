/* Toast History Wand Panel: independent implementation inspired by LenAnderson/SillyTavern-ToastHistory. */
(() => {
'use strict';
if (window.__toastHistoryWandPanel) return;
window.__toastHistoryWandPanel = true;
const KEY = 'st-toast-history-wand-panel-v1';
const LIMIT = 400;
const TYPES = ['info','success','warning','error'];
const NAMES = {info:'정보',success:'성공',warning:'경고',error:'오류'};
const callbacks = new Map();
let entries = [], blocked = [], nextId = Date.now();
let panel, listing, counter, filter, query, status, topButton, wandButton;

function textOf(input) {
    if (input == null) return '';
    if (typeof input === 'string' || typeof input === 'number') return String(input);
    if (input instanceof Node) return input.textContent || '';
    if (input.jquery) return input.text() || '';
    return String(input);
}
function read() {
    try {
        const data = JSON.parse(localStorage.getItem(KEY) || '{}');
        if (Array.isArray(data.entries)) entries = data.entries.filter(x =>
            x && TYPES.includes(x.level) && typeof x.message === 'string' && Number.isFinite(x.time)
        ).slice(-LIMIT).map(x => ({
            id:String(x.id || ++nextId), level:x.level, title:String(x.title || '').slice(0,200),
            message:x.message.slice(0,6000), time:x.time
        }));
        if (Array.isArray(data.blocked)) blocked = data.blocked.filter(x =>
            x && TYPES.includes(x.level) && typeof x.message === 'string'
        ).slice(0,500);
    } catch (e) { console.warn('[Toast History Panel] Cannot read saved history', e); }
}
function save() {
    try { localStorage.setItem(KEY, JSON.stringify({entries,blocked})); }
    catch (e) { console.warn('[Toast History Panel] Cannot save local history', e); }
}
function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
}
function action(label, title, cb) {
    const n = node('button','stthp-action',label);
    n.type = 'button'; n.title = title;
    n.addEventListener('click', cb);
    return n;
}
function isBlocked(x) { return blocked.some(b => b.level === x.level && b.message === x.message); }
function visibleEntries() {
    const q = query.value.trim().toLocaleLowerCase();
    return entries.slice().reverse().filter(x =>
        (filter.value === 'all' || x.level === filter.value) &&
        (!q || (x.title + '\n' + x.message).toLocaleLowerCase().includes(q))
    );
}
function refreshTop() {
    if (!topButton) return;
    topButton.hidden = entries.length === 0;
    topButton.title = '저장된 알림 ' + entries.length + '개';
    topButton.querySelector('.stthp-top-number').textContent = String(entries.length);
}
function render() {
    if (!panel) return;
    const scroll = listing.scrollTop;
    const found = visibleEntries();
    counter.textContent = String(entries.length);
    listing.replaceChildren();
    if (found.length === 0) listing.append(node('p','stthp-empty',
        entries.length ? '조건에 맞는 알림이 없어요.' : '아직 저장된 알림이 없어요.'));
    for (const item of found) {
        const muted = isBlocked(item);
        const card = node('article','stthp-card stthp-' + item.level + (muted ? ' stthp-muted' : ''));
        const head = node('div','stthp-meta');
        head.append(node('b','',NAMES[item.level]));
        const ts = node('time','',new Date(item.time).toLocaleString());
        ts.dateTime = new Date(item.time).toISOString();
        head.append(ts); card.append(head);
        if (item.title) card.append(node('strong','stthp-title',item.title));
        card.append(node('div','stthp-message',item.message));
        const actions = node('div','stthp-card-actions');
        actions.append(action('복사','이 알림을 복사',() => void copyText(
            [item.title,item.message].filter(Boolean).join('\n'))));
        actions.append(action(muted ? '차단 해제' : '기록 차단',
            '같은 종류/내용의 새 알림을 기록에서만 제외하거나 다시 기록합니다.',
            () => {
                if (muted) blocked = blocked.filter(b => !(b.level === item.level && b.message === item.message));
                else blocked.push({level:item.level,message:item.message});
                save(); render();
            }));
        const callback = callbacks.get(item.id);
        if (callback) actions.append(action('원래 동작','이 세션에서 원래 알림의 클릭 동작 실행',
            () => { try { callback(); } catch (e) { console.error('[Toast History Panel] Callback failed',e); } }));
        card.append(actions); listing.append(card);
    }
    listing.scrollTop = scroll;
    refreshTop();
}
async function copyText(value) {
    try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
        else {
            const tmp = node('textarea');
            tmp.value = value; tmp.style.position = 'fixed'; tmp.style.opacity = '0';
            document.body.append(tmp); tmp.select();
            const copied = document.execCommand('copy'); tmp.remove();
            if (!copied) throw new Error('Copy not supported');
        }
        status.textContent = '복사했어요.';
    } catch (e) {
        console.error('[Toast History Panel] Copy failed',e);
        status.textContent = '복사 실패: 브라우저 권한을 확인해 주세요.';
    }
}
function openPanel() {
    panel.hidden = false;
    wandButton?.setAttribute('aria-expanded','true');
    render(); query.focus();
}
function closePanel() {
    panel.hidden = true;
    wandButton?.setAttribute('aria-expanded','false');
}
function togglePanel() { panel.hidden ? openPanel() : closePanel(); }
function makePanel() {
    panel = node('aside','stthp-panel');
    panel.id = 'stthp-panel'; panel.hidden = true;
    panel.setAttribute('role','dialog');
    panel.setAttribute('aria-label','알림 기록 패널');
    panel.setAttribute('aria-modal','false');
    const heading = node('header','stthp-heading');
    const title = node('div','stthp-heading-title');
    counter = node('span','stthp-counter','0');
    title.append(node('b','','알림 기록'),counter);
    heading.append(title,action('×','닫기',closePanel));
    panel.append(heading);
    const controls = node('div','stthp-filters');
    query = node('input','stthp-query');
    query.type = 'search'; query.placeholder = '알림 내용 검색';
    query.setAttribute('aria-label','알림 내용 검색');
    query.addEventListener('input',render);
    filter = node('select','stthp-filter');
    filter.setAttribute('aria-label','알림 종류 필터');
    for (const pair of [['all','전체'],...TYPES.map(t=>[t,NAMES[t]])]) {
        const o = node('option','',pair[1]); o.value = pair[0]; filter.append(o);
    }
    filter.addEventListener('change',render);
    controls.append(query,filter); panel.append(controls);
    const bar = node('div','stthp-toolbar');
    bar.append(
        action('보이는 기록 복사','현재 필터에 맞는 기록 전체 복사',() => {
            const s = visibleEntries().map(x =>
                '[' + new Date(x.time).toLocaleString() + '] ' + NAMES[x.level] +
                (x.title ? ' / ' + x.title : '') + '\n' + x.message).join('\n\n');
            if (s) void copyText(s);
            else status.textContent = '복사할 기록이 없어요.';
        }),
        action('기록 비우기','모든 기록 삭제 (차단 목록은 유지)',() => {
            if (!entries.length || !confirm('저장된 알림 기록을 모두 지울까요?')) return;
            entries = []; callbacks.clear(); save(); render();
            status.textContent = '기록을 삭제했어요.';
        })
    );
    panel.append(bar);
    listing = node('div','stthp-list');
    panel.append(listing);
    status = node('div','stthp-status','브라우저에만 저장됩니다. 최근 최대 400개.');
    status.setAttribute('role','status'); panel.append(status);
    document.body.append(panel);
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !panel.hidden) closePanel();
    });
}
function makeTriggers() {
    const menu = document.getElementById('extensionsMenu');
    if (menu) {
        const wrap = node('div','extension_container');
        wrap.id = 'stthp-wand-container';
        wandButton = node('div','list-group-item flex-container flexGap5 stthp-wand');
        wandButton.id = 'stthp-wand-button';
        wandButton.role = 'button'; wandButton.tabIndex = 0;
        wandButton.setAttribute('aria-controls','stthp-panel');
        wandButton.setAttribute('aria-expanded','false');
        wandButton.append(node('div','fa-solid fa-clock-rotate-left extensionsMenuExtensionButton'),
            node('span','','알림 기록 패널'));
        wandButton.addEventListener('click',togglePanel);
        wandButton.addEventListener('keydown',e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePanel(); }
        });
        wrap.append(wandButton); menu.append(wrap);
        document.getElementById('extensionsMenuButton')?.style.removeProperty('display');
    } else console.warn('[Toast History Panel] Wand menu not found');
    const top = document.getElementById('top-settings-holder');
    if (top) {
        topButton = node('button','stthp-top');
        topButton.type = 'button'; topButton.title = '알림 기록 열기';
        topButton.append(node('span','fa-solid fa-bell'),
            node('span','stthp-top-number','0'));
        topButton.addEventListener('click',togglePanel);
        top.prepend(topButton);
    }
    refreshTop();
}
function capture(level,message,title,result,options) {
    const toast = result?.[0];
    const entry = {
        id:String(++nextId), level, time:Date.now(),
        title:(toast?.querySelector?.('.toast-title')?.textContent || textOf(title)).slice(0,200),
        message:(toast?.querySelector?.('.toast-message')?.textContent || textOf(message)).slice(0,6000)
    };
    if ((!entry.title && !entry.message) || isBlocked(entry)) return;
    entries.push(entry);
    if (typeof options?.onclick === 'function') callbacks.set(entry.id,options.onclick);
    while (entries.length > LIMIT) {
        const old = entries.shift(); callbacks.delete(old.id);
    }
    save();
    if (!panel.hidden) render();
    else refreshTop();
}
function hookToastr() {
    if (!window.toastr) {
        console.warn('[Toast History Panel] toastr missing; capture unavailable.');
        return;
    }
    for (const level of TYPES) {
        if (typeof toastr[level] !== 'function') continue;
        const original = toastr[level];
        toastr[level] = function(message,title,options) {
            const result = original.apply(this,arguments);
            try { capture(level,message,title,result,options); }
            catch (e) { console.error('[Toast History Panel] Capture failed',e); }
            return result;
        };
    }
}
function init() {
    read(); makePanel(); makeTriggers(); hookToastr(); render();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',init,{once:true});
else init();
})();
