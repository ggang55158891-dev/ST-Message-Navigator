/** D-stage pure library edits. No browser state and no SillyTavern chat writes. */
import { chatReference, emptyRecord, validateLibrary } from './library-data.js';

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
        const text = [building.name, building.id, record.alias, folderName, ...tagNames]
            .join(' ').toLocaleLowerCase();
        if (search && !text.includes(search)) continue;
        list.push({ ...building, reference, alias: record.alias, favorite: record.favorite,
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
            return (a.folderName || '~~~~').localeCompare(b.folderName || '~~~~', undefined, {
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
