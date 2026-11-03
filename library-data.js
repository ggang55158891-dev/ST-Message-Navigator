/** Pure management-data model; never reads or modifies SillyTavern chat JSONL. */
import { buildingScope, cleanChatId } from './building-data.js';

export const LIBRARY_KEY = 'stmn_library_v1';
export const LIBRARY_SCHEMA = 2;
export const LEGACY_LIBRARY_SCHEMA = 1;
export const MAX_CHAT_DESCRIPTION = 240;
export const MAX_LIBRARY_BYTES = 256 * 1024;
// Human-readable backup formatting can be larger than the compact store.
export const MAX_LIBRARY_BACKUP_BYTES = MAX_LIBRARY_BYTES * 3;
export const MAX_LIBRARY_RECORDS = 2000;
export const MAX_LIBRARY_FOLDERS = 200;
export const MAX_LIBRARY_TAGS = 300;
export const LIBRARY_BACKUP_KIND = 'stmn-chat-library';
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const idPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const exactly = (object, keys) =>
    isObject(object) && Object.keys(object).length === keys.length &&
    keys.every(key => own(object, key));
const byteLength = value => new TextEncoder().encode(JSON.stringify(value)).length;

export function chatReference(scope, filename) {
    const file = cleanChatId(filename);
    if (typeof scope !== 'string' || !/^(?:character|group):.+$/.test(scope) ||
        scope.length > 300 || /[\0\r\n]/.test(scope) ||
        !file || file.length > 200 || /[/\\\0\r\n]/.test(file) ||
        file === '.' || file === '..') {
        throw new Error('유효하지 않은 채팅 범위 또는 파일 식별자입니다.');
    }
    // JSON tuple avoids delimiters colliding with user-supplied file names.
    return JSON.stringify([scope, file]);
}

export function currentChatReference(context, filename = context?.chatId) {
    return chatReference(buildingScope(context), filename);
}

export function emptyLibrary() {
    return { schemaVersion: LIBRARY_SCHEMA, records: {}, folders: [], tags: [] };
}

export function emptyRecord() {
    return {
        alias: '', description: '', folderId: null, favorite: false, tagIds: [],
        imageRef: null, lastRead: null, customSortOrder: null,
        createdAt: null, createdAtSource: null,
    };
}

function validateName(name) {
    return typeof name === 'string' && name.trim() === name &&
        name.length >= 1 && name.length <= 80;
}
function validateCatalog(rows, max) {
    if (!Array.isArray(rows) || rows.length > max) throw new Error('관리 분류 데이터 수가 허용 범위를 초과했습니다.');
    const seen = new Set();
    for (const row of rows) {
        if (!exactly(row, ['id', 'name']) || !idPattern.test(row.id) || !validateName(row.name) ||
            seen.has(row.id)) throw new Error('폴더 또는 태그의 형식·식별자가 유효하지 않습니다.');
        seen.add(row.id);
    }
    return seen;
}

function validateRecord(record, folders, tags, version) {
    const fields = Object.keys(emptyRecord());
    const expected = version === LEGACY_LIBRARY_SCHEMA
        ? fields.filter(field => field !== 'description') : fields;
    if (!exactly(record, expected)) throw new Error('관리 데이터 필드가 누락되었거나 지원되지 않습니다.');
    if (version === LIBRARY_SCHEMA &&
        (typeof record.description !== 'string' ||
         record.description.length > MAX_CHAT_DESCRIPTION ||
         record.description.trim() !== record.description ||
         /[\u0000-\u001f\u007f]/.test(record.description))) {
        throw new Error('채팅 설명은 공백 양끝·제어문자 없이 최대 240자까지 입력할 수 있습니다.');
    }
    if (typeof record.alias !== 'string' || record.alias.length > 120 ||
        record.alias.trim() !== record.alias ||
        typeof record.favorite !== 'boolean' ||
        (record.folderId !== null && !folders.has(record.folderId)) ||
        !Array.isArray(record.tagIds) || record.tagIds.length > 20 ||
        new Set(record.tagIds).size !== record.tagIds.length ||
        record.tagIds.some(id => !tags.has(id)) ||
        (record.imageRef !== null &&
            (typeof record.imageRef !== 'string' || record.imageRef.length > 500 ||
             !record.imageRef.trim() || /^data:/i.test(record.imageRef))) ||
        (record.lastRead !== null &&
            (!Number.isSafeInteger(record.lastRead) || record.lastRead < 0)) ||
        (record.customSortOrder !== null &&
            (!Number.isSafeInteger(record.customSortOrder) || Math.abs(record.customSortOrder) > 1_000_000)) ||
        (record.createdAtSource !== null && !['metadata', 'inferred'].includes(record.createdAtSource)) ||
        (record.createdAt !== null && (
            typeof record.createdAt !== 'string' || record.createdAt.length > 40 ||
            !Number.isFinite(Date.parse(record.createdAt)))) ||
        ((record.createdAt === null) !== (record.createdAtSource === null))) {
        throw new Error('유효하지 않은 채팅 관리 데이터가 포함되어 있습니다.');
    }
}

export function validateLibrary(raw) {
    if (raw === undefined || raw === null) return emptyLibrary();
    if (!exactly(raw, ['schemaVersion', 'records', 'folders', 'tags']) ||
        ![LEGACY_LIBRARY_SCHEMA, LIBRARY_SCHEMA].includes(raw.schemaVersion) ||
        !isObject(raw.records)) {
        throw new Error('알 수 없거나 손상된 채팅 관리 데이터입니다. 기존 데이터를 덮어쓰지 않습니다.');
    }
    const folders = validateCatalog(raw.folders, MAX_LIBRARY_FOLDERS);
    const tags = validateCatalog(raw.tags, MAX_LIBRARY_TAGS);
    const entries = Object.entries(raw.records);
    if (entries.length > MAX_LIBRARY_RECORDS) throw new Error('관리 채팅이 허용 범위를 초과했습니다.');
    // Deep-copy validated fields only. Never pass through prototype keys.
    const records = Object.create(null);
    for (const [key, record] of entries) {
        let reference;
        try { reference = JSON.parse(key); } catch { throw new Error('채팅 식별자 형식이 손상되었습니다.'); }
        if (!Array.isArray(reference) || reference.length !== 2 ||
            chatReference(reference[0], reference[1]) !== key) {
            throw new Error('채팅 식별자 형식이 손상되었습니다.');
        }
        validateRecord(record, folders, tags, raw.schemaVersion);
        // v1 aliases are never silently reinterpreted as descriptions.
        // Migration remains in memory until the next explicit user edit.
        records[key] = { ...record, description: raw.schemaVersion === LEGACY_LIBRARY_SCHEMA
            ? '' : record.description, tagIds: [...record.tagIds] };
    }
    const clean = {
        schemaVersion: LIBRARY_SCHEMA, records,
        folders: raw.folders.map(item => ({ id: item.id, name: item.name })),
        tags: raw.tags.map(item => ({ id: item.id, name: item.name })),
    };
    if (byteLength(clean) > MAX_LIBRARY_BYTES) throw new Error('채팅 관리 데이터의 크기가 256KB를 초과했습니다.');
    return clean;
}

export function setChatRecord(library, reference, changes) {
    // All changes happen in a detached copy; invalid updates never mutate
    // the original library. Intended for later D-stage UX.
    const clean = validateLibrary(library);
    const tuple = JSON.parse(reference);
    if (!Array.isArray(tuple) || tuple.length !== 2 || chatReference(...tuple) !== reference) {
        throw new Error('채팅 식별자가 유효하지 않습니다.');
    }
    if (!isObject(changes) || Object.keys(changes).some(key => !own(emptyRecord(), key))) {
        throw new Error('지원하지 않는 관리 데이터 필드입니다.');
    }
    const next = { ...emptyRecord(), ...(clean.records[reference] || {}), ...changes };
    clean.records[reference] = next;
    return validateLibrary(clean);
}

export function librarySummary(library) {
    const safe = validateLibrary(library);
    const records = Object.values(safe.records);
    return {
        chats: records.length,
        folders: safe.folders.length,
        tags: safe.tags.length,
        aliases: records.filter(row => row.alias.length > 0).length,
        favorites: records.filter(row => row.favorite).length,
    };
}

export function createLibraryBackup(library, { now = new Date(), version = 'unknown' } = {}) {
    const safe = validateLibrary(library);
    return JSON.stringify({
        type: LIBRARY_BACKUP_KIND,
        schemaVersion: LIBRARY_SCHEMA,
        exportedAt: now.toISOString(),
        extensionVersion: /^\d+\.\d+\.\d+$/.test(version) ? version : 'unknown',
        library: safe,
    }, null, 2);
}

export function parseLibraryBackup(text) {
    if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_LIBRARY_BACKUP_BYTES) {
        throw new Error('관리 데이터 백업 파일이 너무 큽니다.');
    }
    let root;
    try { root = JSON.parse(text); } catch { throw new Error('유효한 JSON 백업 파일이 아닙니다.'); }
    if (!exactly(root, ['type', 'schemaVersion', 'exportedAt', 'extensionVersion', 'library']) ||
        root.type !== LIBRARY_BACKUP_KIND ||
        ![LEGACY_LIBRARY_SCHEMA, LIBRARY_SCHEMA].includes(root.schemaVersion) ||
        root.schemaVersion !== root.library?.schemaVersion ||
        typeof root.exportedAt !== 'string' ||
        !Number.isFinite(Date.parse(root.exportedAt)) ||
        typeof root.extensionVersion !== 'string') {
        throw new Error('지원하지 않는 관리 데이터 백업 형식입니다.');
    }
    return { exportedAt: root.exportedAt, library: validateLibrary(root.library) };
}

/** Conflict-safe additive restore. Existing different records never get replaced. */
export function mergeLibrary(existing, incoming) {
    const old = validateLibrary(existing);
    const next = validateLibrary(incoming);
    const folders = new Map(old.folders.map(item => [item.id, item]));
    const tags = new Map(old.tags.map(item => [item.id, item]));
    for (const [name, previous, incomingRows] of [
        ['폴더', folders, next.folders], ['태그', tags, next.tags],
    ]) {
        for (const item of incomingRows) {
            const found = previous.get(item.id);
            if (found && found.name !== item.name) {
                throw new Error(name + ' 식별자 충돌: 기존 데이터를 보존하기 위해 복원을 중단했습니다.');
            }
        }
    }
    const records = Object.assign(Object.create(null), old.records);
    for (const [key, record] of Object.entries(next.records)) {
        // JSON object member order is not meaningful. Preserve existing
        // records when their schema fields are equal, even if a backup was
        // reserialized with a different property order.
        if (own(records, key) && Object.keys(emptyRecord()).some(field =>
            JSON.stringify(records[key][field]) !== JSON.stringify(record[field]))) {
            throw new Error('채팅 관리 정보 충돌: 기존 값을 덮어쓰지 않습니다.');
        }
        records[key] = record;
    }
    const merged = {
        schemaVersion: LIBRARY_SCHEMA, records,
        folders: [...old.folders, ...next.folders.filter(x => !folders.has(x.id))],
        tags: [...old.tags, ...next.tags.filter(x => !tags.has(x.id))],
    };
    return validateLibrary(merged);
}
