/** D-stage pure library edits. No browser state and no SillyTavern chat writes. */
import { chatReference, emptyRecord, validateLibrary, MAX_CHAT_DESCRIPTION } from './library-data.js';

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const validName = (name, max = 80) =>
    typeof name === 'string' && name.trim() === name && name.length > 0 && name.length <= max;

function editCatalog(store, kind, action) {
    const field = kind === 'folder' ? 'folders' : 'tags';
    if (!['folder','tag'].includes(kind)) throw new Error('지원하지 않는 분류 유형입니다.');
    const rows = store[field];
    const index = rows.findIndex(x => x.id === action.id);
    if (action.type === 'create') {
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(action.id) || !validName(action.name) ||
            rows.some(x => x.id === action.id) ||
            rows.some(x => x.name.toLocaleLowerCase() === action.name.toLocaleLowerCase())) {
            throw new Error('이름 또는 분류 ID가 올바르지 않거나 이미 사용 중입니다.');
        }
        rows.push({ id: action.id, name: action.name });
    } else {
        if (index < 0) throw new Error('분류 항목을 찾을 수 없습니다.');
        if (action.type === 'rename') {
            if (!validName(action.name) ||
                rows.some(x => x.id !== action.id &&
                    x.name.toLocaleLowerCase() === action.name.toLocaleLowerCase())) {
                throw new Error('분류 이름이 올바르지 않거나 이미 사용 중입니다.');
            }
            rows[index] = { id: action.id, name: action.name };
        } else if (action.type === 'delete') {
            rows.splice(index, 1);
            for (const record of Object.values(store.records)) {
                if (kind === 'folder' && record.folderId === action.id) record.folderId = null;
                if (kind === 'tag') record.tagIds = record.tagIds.filter(id => id !== action.id);
            }
        } else throw new Error('지원하지 않는 관리 작업입니다.');
    }
}

export function changeLibrary(existing, action) {
    const store = validateLibrary(existing);
    if (!action || typeof action !== 'object') throw new Error('관리 요청이 올바르지 않습니다.');
    if (action.kind === 'folder' || action.kind === 'tag') {
        editCatalog(store, action.kind, action);
    } else if (action.kind === 'chat') {
        const pair = (() => { try { return JSON.parse(action.reference); } catch { return null; } })();
        if (!Array.isArray(pair) || pair.length !== 2 || chatReference(...pair) !== action.reference) {
            throw new Error('유효하지 않은 채팅 식별자입니다.');
        }
        const record = { ...emptyRecord(), ...(store.records[action.reference] || {}) };
        switch (action.type) {
            case 'alias':
                if (typeof action.value !== 'string' || action.value.trim() !== action.value ||
                    action.value.length > 120) throw new Error('별명은 최대 120자까지 입력할 수 있습니다.');
                record.alias = action.value;
                break;
            case 'description':
                if (typeof action.value !== 'string' || action.value.trim() !== action.value ||
                    action.value.length > MAX_CHAT_DESCRIPTION || /[\u0000-\u001f\u007f]/.test(action.value)) {
                    throw new Error('채팅 설명은 최대 240자이며 줄바꿈과 제어문자를 포함할 수 없습니다.');
                }
                record.description = action.value;
                break;
            case 'favorite':
                if (typeof action.value !== 'boolean') throw new Error('즐겨찾기 상태가 유효하지 않습니다.');
                record.favorite = action.value;
                break;
            case 'folder':
                if (action.value !== null && !store.folders.some(x => x.id === action.value)) {
                    throw new Error('존재하지 않는 폴더입니다.');
                }
                record.folderId = action.value;
                break;
            case 'tag': {
                if (typeof action.value !== 'string' || !store.tags.some(x => x.id === action.value) ||
                    typeof action.enabled !== 'boolean') throw new Error('유효하지 않은 태그입니다.');
                const existingTags = new Set(record.tagIds);
                if (action.enabled) existingTags.add(action.value);
                else existingTags.delete(action.value);
                record.tagIds = [...existingTags];
                break;
            }
            default: throw new Error('지원하지 않는 채팅 관리 작업입니다.');
        }
        // Unmodified fields (including future image/createdAt) are preserved.
        store.records[action.reference] = record;
    } else throw new Error('지원하지 않는 관리 작업입니다.');
    return validateLibrary(store);
}

/** Low-cost view projection; caller supplies a library already validated on read. */
export function selectLibraryChats(buildings, scope, library, {
    query = '', view = 'all', folderId = '', sort = 'recent',
} = {}) {
    const folderMap = new Map(library.folders.map(x => [x.id, x.name]));
    const tagMap = new Map(library.tags.map(x => [x.id, x.name]));
    const search = String(query).trim().toLocaleLowerCase();
    const list = [];
    for (const building of buildings) {
        let reference;
        try { reference = chatReference(scope, building.id); } catch { continue; }
        const record = library.records[reference] || emptyRecord();
        const folderName = folderMap.get(record.folderId) || '';
        const tagNames = record.tagIds.map(id => tagMap.get(id) || '').filter(Boolean);
        if (view === 'favorites' && !record.favorite) continue;
        if (view === 'folders' && record.folderId !== (folderId || null)) continue;
        const text = [building.name, building.id, record.alias, record.description, folderName, ...tagNames]
            .join(' ').toLocaleLowerCase();
        if (search && !text.includes(search)) continue;
        list.push({ ...building, reference, alias: record.alias, description: record.description, favorite: record.favorite,
            folderId: record.folderId, folderName, tagIds: record.tagIds,
            tagNames, displayName: record.alias || building.name,
            createdAt: record.createdAt ? Date.parse(record.createdAt) || 0 : 0 });
    }
    const alpha = (a, b) => a.displayName.localeCompare(b.displayName, undefined, {
        sensitivity: 'base', numeric: true,
    });
    const recent = (a, b) => b.lastActivity - a.lastActivity || alpha(a,b);
    list.sort((a,b) => {
        if (sort === 'name') return alpha(a,b);
        if (sort === 'created') {
            // An unknown creation date is NOT replaced with file modification time.
            return b.createdAt - a.createdAt || recent(a,b);
        }
        if (sort === 'folders') {
            // Explicitly place unfiled chats after named folders. Unicode
            // collation does not reliably order '~' after Korean text.
            if (Boolean(a.folderId) !== Boolean(b.folderId)) return a.folderId ? -1 : 1;
            return a.folderName.localeCompare(b.folderName, undefined, {
                sensitivity: 'base', numeric: true,
            }) || recent(a,b);
        }
        return recent(a,b);
    });
    return list;
}

export function libraryRecordChanged(before, after) {
    // Avoid a save for a repeated click choosing an existing value.
    return JSON.stringify(before) !== JSON.stringify(after);
}


/**
 * Q-07B reference maintenance after confirmed server success.
 * Detach/validate the entire library; never overwrite a different record.
 */
export function moveLibraryReference(existing,scope,fromId,toId) {
    const lib=validateLibrary(existing);
    const oldKey=chatReference(scope,fromId),newKey=chatReference(scope,toId);
    if(oldKey===newKey)return {library:lib,changed:false};
    if(!Object.prototype.hasOwnProperty.call(lib.records,oldKey))
        return {library:lib,changed:false};
    if(Object.prototype.hasOwnProperty.call(lib.records,newKey))
        throw new Error('변경할 파일 이름에 이미 다른 관리 정보가 저장돼 있습니다. 해당 관리 정보를 덮어쓰지 않았습니다.');
    lib.records[newKey]=lib.records[oldKey];
    delete lib.records[oldKey];
    return {library:validateLibrary(lib),changed:true};
}
export function forgetLibraryReference(existing,scope,id) {
    const lib=validateLibrary(existing);
    const key=chatReference(scope,id);
    if(!Object.prototype.hasOwnProperty.call(lib.records,key))
        return {library:lib,changed:false};
    delete lib.records[key];
    return {library:validateLibrary(lib),changed:true};
}


/** Q-08/G-01: one atomic, non-destructive change for up to 20 chat records.
 * The caller must pass the current-scope server list, not a stale filtered UI.
 * This never fetches or mutates a JSONL file or other extensions' metadata.
 */
export const MAX_BULK_LIBRARY_CHATS = 20;
export function bulkChangeLibrary(existing,{
    scope,ids,availableIds,operation,value=null,
}={}){
    if(typeof scope!=='string' || !/^(character|group):.+$/.test(scope))
        throw new Error('채팅 범위를 확인할 수 없습니다.');
    if(!Array.isArray(ids) || !ids.length || ids.length>MAX_BULK_LIBRARY_CHATS ||
       !Array.isArray(availableIds))
        throw new Error('1~20개의 현재 채팅만 일괄 관리할 수 있습니다.');
    const known=new Set(availableIds);
    const unique=new Set(ids);
    if(unique.size!==ids.length ||
       ids.some(id=>typeof id!=='string' || !id ||
           id.endsWith('.jsonl') || !known.has(id)))
        throw new Error('선택한 채팅이 현재 목록에 없거나 중복됐습니다. 새로고침 후 다시 선택해 주세요.');
    const library=validateLibrary(existing);
    if(operation==='folder'){
        if(value!==null && !library.folders.some(x=>x.id===value))
            throw new Error('선택한 폴더가 존재하지 않습니다.');
    } else if(['tag-add','tag-remove'].includes(operation)){
        if(typeof value!=='string' || !library.tags.some(x=>x.id===value))
            throw new Error('선택한 태그가 존재하지 않습니다.');
    } else if(!['favorite-add','favorite-remove'].includes(operation)){
        throw new Error('지원하지 않는 일괄 정리 작업입니다.');
    }
    let changed=0;
    for(const id of ids){
        const ref=chatReference(scope,id);
        const old=library.records[ref]||emptyRecord();
        const next={...old,tagIds:[...old.tagIds]};
        if(operation==='folder')next.folderId=value;
        if(operation==='favorite-add')next.favorite=true;
        if(operation==='favorite-remove')next.favorite=false;
        if(operation==='tag-add' && !next.tagIds.includes(value))next.tagIds.push(value);
        if(operation==='tag-remove')next.tagIds=next.tagIds.filter(x=>x!==value);
        if(JSON.stringify(old)!==JSON.stringify(next)){
            library.records[ref]=next;
            changed++;
        }
    }
    return {library:validateLibrary(library),changed};
}
