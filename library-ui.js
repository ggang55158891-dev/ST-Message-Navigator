/** D-stage lobby controls. No background chat scans and no dependency packages. */
import { cleanChatId } from './building-data.js';
import { chatReference, emptyLibrary } from './library-data.js';
import { selectLibraryChats } from './library-operations.js';

const make = (tag, className = '', text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = String(text);
    return el;
};
const button = (text, className, click) => {
    const b = make('button', className, text);
    b.type = 'button';
    b.addEventListener('click', click);
    return b;
};
function options(select, items, selected) {
    select.replaceChildren();
    for (const [id, name] of items) {
        const opt = make('option', '', name);
        opt.value = id;
        select.append(opt);
    }
    select.value = selected;
}
function newId(prefix) {
    // Both browsers and ST localhost provide Web Crypto.
    const digits = Array.from(crypto.getRandomValues(new Uint8Array(12)),
        byte => byte.toString(16).padStart(2,'0')).join('');
    return prefix + digits;
}

export class LibraryLobby {
    constructor(owner) {
        this.owner = owner;
        this.data = null;
        this.view = 'all';
        this.folderId = '';
        this.visible = 100;
        this.editing = false;
        const host = owner.buildingsPane;
        this.controls = make('div', 'stmn-library-controls');
        const selectorRow = make('div', 'stmn-library-selectors');
        this.viewSelect = make('select', 'stmn-library-view');
        this.viewSelect.setAttribute('aria-label', '채팅 보기 방식');
        options(this.viewSelect, [['all','전체 채팅'],['folders','폴더별 보기'],['favorites','즐겨찾기']], 'all');
        this.viewSelect.addEventListener('change', () => {
            this.view = this.viewSelect.value;
            this.visible = 100;
            this.draw();
        });
        this.folderSelect = make('select', 'stmn-library-folder-filter');
        this.folderSelect.setAttribute('aria-label', '표시할 폴더');
        this.folderSelect.addEventListener('change', () => {
            this.folderId = this.folderSelect.value;
            this.visible = 100;
            this.draw();
        });
        selectorRow.append(this.viewSelect, this.folderSelect);

        const folderToolbar = make('div', 'stmn-library-toolbar');
        folderToolbar.append(make('span', '', '폴더'));
        this.folderNew = button('+ 추가', 'stmn-library-small', () => this.nameEditor('폴더 만들기', '', value =>
            this.mutate({ kind: 'folder', type: 'create', id: newId('f_'), name: value })));
        this.folderRename = button('이름 변경', 'stmn-library-small', () => {
            const row = this.data.folders.find(x => x.id === this.folderId);
            if (row) this.nameEditor('폴더 이름 변경', row.name, value =>
                this.mutate({ kind: 'folder', type: 'rename', id: row.id, name: value }));
        });
        this.folderDelete = button('삭제', 'stmn-library-small', () => {
            if (!this.folderId) return;
            const row = this.data.folders.find(x => x.id === this.folderId);
            if (!row) return;
            if (!window.confirm('"' + row.name + '" 폴더만 삭제할까요?\n채팅 파일은 삭제되지 않고 미분류로 이동합니다.')) return;
            this.mutate({ kind: 'folder', type: 'delete', id: row.id });
            this.folderId = '';
            this.draw();
        });
        folderToolbar.append(this.folderNew, this.folderRename, this.folderDelete);

        const tagToolbar = make('div', 'stmn-library-toolbar');
        tagToolbar.append(make('span', '', '태그'));
        this.tagSelect = make('select', 'stmn-library-tag-filter');
        this.tagSelect.setAttribute('aria-label', '관리할 태그');
        this.tagNew = button('+ 추가', 'stmn-library-small', () => this.nameEditor('태그 만들기', '', value =>
            this.mutate({ kind: 'tag', type: 'create', id: newId('t_'), name: value })));
        this.tagRename = button('이름 변경', 'stmn-library-small', () => {
            const row = this.data.tags.find(x => x.id === this.tagSelect.value);
            if (row) this.nameEditor('태그 이름 변경', row.name, value =>
                this.mutate({ kind: 'tag', type: 'rename', id: row.id, name: value }));
        });
        this.tagDelete = button('삭제', 'stmn-library-small', () => {
            const row = this.data.tags.find(x => x.id === this.tagSelect.value);
            if (!row) return;
            if (!window.confirm('"' + row.name + '" 태그를 모든 채팅에서 제거할까요?\n채팅 파일은 삭제되지 않습니다.')) return;
            this.mutate({ kind: 'tag', type: 'delete', id: row.id });
            this.draw();
        });
        tagToolbar.append(this.tagSelect, this.tagNew, this.tagRename, this.tagDelete);
        this.editor = make('form', 'stmn-library-editor');
        this.editor.hidden = true;
        this.editorCaption = make('label', '', '이름 입력');
        this.editorInput = make('input');
        this.editorInput.type = 'text';
        this.editorInput.maxLength = 120;
        this.editorInput.required = true;
        this.editorInput.setAttribute('aria-label', '관리 이름');
        this.editorInput.placeholder = '이름을 입력하세요';
        const save = button('저장', 'stmn-library-small');
        save.type = 'submit';
        const cancel = button('취소', 'stmn-library-small', () => this.closeEditor());
        this.editor.append(this.editorCaption, this.editorInput, save, cancel);
        this.editor.addEventListener('submit', event => {
            event.preventDefault();
            const value = this.editorInput.value.trim();
            try {
                if (!value || value.length > this.editorInput.maxLength) throw new Error('올바른 이름을 입력하세요.');
                this.onEditorSave?.(value);
                this.closeEditor();
            } catch (error) {
                this.error.textContent = error?.message || '이름을 저장하지 못했습니다.';
            }
        });
        this.error = make('p', 'stmn-library-error');
        this.error.setAttribute('role', 'status');
        this.controls.append(selectorRow, folderToolbar, tagToolbar, this.editor, this.error);
        host.insertBefore(this.controls, owner.buildingList);
    }

    setData(data) {
        this.data = data;
        this.draw();
    }

    refreshSelectors() {
        const data = this.data || emptyLibrary();
        options(this.folderSelect,
            [['','미분류'], ...data.folders.map(x=>[x.id,x.name])],
            data.folders.some(x=>x.id === this.folderId) ? this.folderId : '');
        this.folderId = this.folderSelect.value;
        const currentTag = this.tagSelect.value;
        options(this.tagSelect,
            [['','태그 선택'], ...data.tags.map(x=>[x.id,x.name])],
            currentTag && data.tags.some(x => x.id === currentTag) ? currentTag : '');
        this.tagRename.disabled = this.tagDelete.disabled = !this.tagSelect.value;
        this.folderRename.disabled = this.folderDelete.disabled = !this.folderId;
        this.folderSelect.hidden = this.view !== 'folders';
    }

    closeEditor() {
        this.editor.hidden = true;
        this.editing = false;
        this.onEditorSave = null;
        this.editorInput.value = '';
    }

    nameEditor(label, initial, onSave) {
        if (!this.data) return;
        this.error.textContent = '';
        this.editorCaption.textContent = label;
        this.editorInput.value = initial;
        this.editorInput.maxLength = label.includes('별명') ? 120 : 80;
        this.onEditorSave = onSave;
        this.editing = true;
        this.editor.hidden = false;
        this.editorInput.focus();
        this.editorInput.select();
    }

    mutate(action) {
        if (!this.data || this.owner.busy) return;
        const owner = this.owner;
        // Prevent editing an old scope after a character/group switch.
        const scope = owner.scope;
        if (scope !== owner.callbacks.currentLibraryScope()) {
            throw new Error('채팅 대상이 변경되었습니다. 건물 목록을 새로고침해 주세요.');
        }
        const result = owner.callbacks.changeLibrary(action);
        this.data = result;
        this.error.textContent = '관리 정보 저장을 요청했습니다.';
        this.draw();
        owner.updateFloor(owner.view.currentIndex);
    }

    draw() {
        const owner = this.owner;
        const data = this.data;
        if (!data) {
            this.controls.hidden = true;
            return;
        }
        this.controls.hidden = false;
        this.refreshSelectors();
        const found = selectLibraryChats(owner.buildings, owner.scope, data, {
            query: owner.search.value, view: this.view, folderId: this.folderId,
            sort: owner.sort.value,
        });
        owner.buildingsCount.textContent = found.length.toLocaleString() + '개 채팅';
        owner.buildingList.replaceChildren();
        if (!found.length) {
            owner.buildingList.append(make('p','stmn-building-empty',
                '표시할 채팅이 없습니다. 검색이나 폴더 선택을 확인해 주세요.'));
            return;
        }
        const fragment = document.createDocumentFragment();
        const selected = cleanChatId(owner.callbacks.context().chatId);
        for (const item of found.slice(0,this.visible)) {
            const current = selected === item.id;
            const wrapper = make('div', 'stmn-library-card', '');
            wrapper.setAttribute('role','listitem');
            const line = make('div','stmn-library-card-line');
            const enter = button('', 'stmn-building-card' + (current ? ' stmn-building-current' : ''),
                () => void owner.enter(item));
            enter.disabled = owner.busy;
            enter.setAttribute('aria-label', item.displayName + (current ? ' · 현재 채팅' : ' · 채팅 열기'));
            const facade = make('span','stmn-building-facade');
            facade.setAttribute('aria-hidden','true');
            const info = make('span','stmn-building-card-body');
            info.append(make('strong','stmn-building-card-title',item.displayName));
            const badges = [
                current ? '현재 채팅' : null,
                item.alias ? '원본: ' + item.name : null,
                item.folderName || null,
                Number.isInteger(item.count) ? item.count + '개 메시지' : null,
                item.lastActivity ? new Date(item.lastActivity).toLocaleDateString() : null,
            ].filter(Boolean);
            info.append(make('small','stmn-building-card-meta',badges.join(' · ')));
            if (item.tagNames.length) info.append(make('small','stmn-library-tags',item.tagNames.map(x=>'#'+x).join(' ')));
            enter.append(facade, info, make('span','stmn-building-enter',current ? '●' : '›'));
            const favorite = button(item.favorite ? '★' : '☆','stmn-library-favorite',() => {
                try { this.mutate({kind:'chat',type:'favorite',reference:item.reference,value:!item.favorite}); }
                catch(error){ this.error.textContent = error.message; }
            });
            favorite.title = item.favorite ? '즐겨찾기 해제' : '즐겨찾기 추가';
            favorite.setAttribute('aria-label', item.displayName+' '+favorite.title);
            line.append(enter,favorite);
            wrapper.append(line);
            const details = make('details','stmn-library-details');
            details.append(make('summary','', '관리 · 별명 / 폴더 / 태그'));
            const body = make('div','stmn-library-detail-body');
            const alias = button('✎ 별명 변경', 'stmn-library-small', () => this.nameEditor(
                '채팅 별명 변경 (빈 값으로 지우려면 별명 삭제 버튼 사용)',item.alias,
                value=>this.mutate({kind:'chat',type:'alias',reference:item.reference,value})));
            const clearAlias = button('별명 삭제','stmn-library-small',() => {
                try { this.mutate({kind:'chat',type:'alias',reference:item.reference,value:''}); }
                catch(error){this.error.textContent=error.message;}
            });
            body.append(alias,clearAlias);
            const folder = make('select','stmn-library-card-folder');
            folder.setAttribute('aria-label',item.displayName+' 폴더');
            options(folder,[['','미분류'], ...data.folders.map(x=>[x.id,x.name])],item.folderId||'');
            folder.addEventListener('change', () => {
                try { this.mutate({kind:'chat',type:'folder',reference:item.reference,value:folder.value||null}); }
                catch(error){this.error.textContent=error.message;}
            });
            body.append(folder);
            if(data.tags.length){
                const tags = make('div','stmn-library-tag-checkboxes');
                for(const tag of data.tags){
                    const label = make('label','stmn-library-tag-checkbox');
                    const check = make('input');
                    check.type='checkbox';
                    check.checked = item.tagIds.includes(tag.id);
                    check.addEventListener('change',()=>{
                        try { this.mutate({kind:'chat',type:'tag',reference:item.reference,value:tag.id,enabled:check.checked}); }
                        catch(error){this.error.textContent=error.message;}
                    });
                    label.append(check,document.createTextNode(tag.name));
                    tags.append(label);
                }
                body.append(tags);
            }
            details.append(body);
            wrapper.append(details);
            fragment.append(wrapper);
        }
        owner.buildingList.append(fragment);
        if(found.length > this.visible){
            owner.buildingList.append(button('더 보기 ('+(found.length-this.visible)+'개 남음)', 'stmn-library-more',() => {
                this.visible += 100;
                this.draw();
            }));
        }
    }

    getAlias(scope,id) {
        if (!this.data || !scope || !id) return '';
        try { return this.data.records[chatReference(scope,id)]?.alias || ''; }
        catch { return ''; }
    }

    destroy() {
        this.closeEditor();
    }
}
