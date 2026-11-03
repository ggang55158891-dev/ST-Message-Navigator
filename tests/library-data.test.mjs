import test from 'node:test';
import assert from 'node:assert/strict';
import {
    LIBRARY_KEY, MAX_LIBRARY_BYTES, chatReference, currentChatReference,
    emptyLibrary, emptyRecord, validateLibrary, setChatRecord, librarySummary,
    createLibraryBackup, parseLibraryBackup, mergeLibrary,
} from '../library-data.js';
import { LibraryRepository } from '../library-repository.js';

function ctx() {
    return {
        characterId: 1, chatId: 'same-chat.jsonl',
        characters: [{ avatar: 'a.png' }, { avatar: 'b.png' }],
        groups: [{ id: 77, chats: ['same-chat'] }],
        extensionSettings: { other_extension: { marker: 'KEEP' } },
        saveSettingsDebounced() { this.saveCount = (this.saveCount || 0) + 1; },
    };
}
function item(alias, folderId = null, tagIds = []) {
    return { ...emptyRecord(), alias, folderId, tagIds };
}
function filled() {
    const library = emptyLibrary();
    library.folders.push({ id: 'f_1', name: '진행 중' });
    library.tags.push({ id: 't_1', name: '판타지' });
    library.records[chatReference('character:b.png', 'same-chat')] = item('안개 속의 건물', 'f_1', ['t_1']);
    return library;
}

test('character and group scopes separate identical chat filenames', () => {
    const c = ctx();
    const a = currentChatReference(c);
    const b = currentChatReference({ ...c, characterId: 0 });
    const group = currentChatReference({ ...c, groupId: 77 });
    assert.notEqual(a, b);
    assert.notEqual(a, group);
    assert.notEqual(b, group);
    assert.equal(a, chatReference('character:b.png', 'same-chat'));
});

test('identity ignores display name and normalizes .jsonl but rejects invalid paths', () => {
    assert.equal(chatReference('character:b.png', 'same-chat.jsonl'),
        chatReference('character:b.png', 'same-chat'));
    assert.throws(() => chatReference(null, 'same-chat'), /유효하지/);
    assert.throws(() => chatReference('character:b.png', '../secret'), /유효하지/);
    assert.throws(() => chatReference('character:b.png', '/name'), /유효하지/);
    assert.throws(() => chatReference('character:b.png', ''), /유효하지/);
});

test('pure record update does not touch original chat metadata or previous library', () => {
    const original = emptyLibrary();
    const reference = chatReference('character:b.png', 'scene');
    const chat = [{ mes: 'private text' }];
    const updated = setChatRecord(original, reference, { alias: '별명', favorite: true });
    assert.deepEqual(original, emptyLibrary());
    assert.equal(updated.records[reference].alias, '별명');
    assert.equal(updated.records[reference].favorite, true);
    assert.equal(chat[0].mes, 'private text');
});

test('valid folder/linked tag records survive backup roundtrip', () => {
    const data = filled();
    const backup = createLibraryBackup(data, {
        now: new Date('2026-11-02T00:00:00Z'), version: '1.5.0',
    });
    const parsed = parseLibraryBackup(backup);
    assert.equal(parsed.exportedAt, '2026-11-02T00:00:00.000Z');
    assert.deepEqual(parsed.library.folders, data.folders);
    assert.equal(librarySummary(parsed.library).aliases, 1);
    assert.equal(parsed.library.records[chatReference('character:b.png', 'same-chat')].folderId, 'f_1');
});

test('backups cannot include other extension secrets or original message text', () => {
    const fake = { ...filled(), unrelated: { chat: 'NEVER BACK UP' } };
    assert.throws(() => validateLibrary(fake), /손상된/);
    assert.equal(createLibraryBackup(emptyLibrary()).includes('NEVER BACK UP'), false);
});

test('validator refuses unknown schemas, malformed records and dangling folders/tags', () => {
    const future = filled(); future.schemaVersion = 999;
    assert.throws(() => validateLibrary(future), /손상된/);
    const dangling = filled();
    dangling.records[chatReference('character:b.png', 'same-chat')].folderId = 'missing';
    assert.throws(() => validateLibrary(dangling), /유효하지/);
    const bad = filled();
    bad.records[chatReference('character:b.png', 'same-chat')].tagIds = ['t_1','t_1'];
    assert.throws(() => validateLibrary(bad), /유효하지/);
    const unrecognized = filled();
    unrecognized.records[chatReference('character:b.png', 'same-chat')].surprise = true;
    assert.throws(() => validateLibrary(unrecognized), /필드/);
});

test('backup parser rejects wrong types, invalid JSON and future migration schema', () => {
    assert.throws(() => parseLibraryBackup('{broken'), /JSON/);
    const future = JSON.parse(createLibraryBackup(emptyLibrary()));
    future.schemaVersion = 999;
    assert.throws(() => parseLibraryBackup(JSON.stringify(future)), /지원하지/);
    future.schemaVersion = 1;
    future.type = 'other-extension';
    assert.throws(() => parseLibraryBackup(JSON.stringify(future)), /지원하지/);
    assert.throws(() => parseLibraryBackup('x'.repeat(MAX_LIBRARY_BYTES * 4)), /너무 큽니다/);
});

test('additive import includes new tags, folders, and chat without overwriting existing', () => {
    const previous = filled();
    const other = emptyLibrary();
    other.tags.push({ id: 't_2', name: '공포' });
    other.records[chatReference('group:77', 'same-chat')] = item('다른 건물');
    const before = JSON.stringify(previous);
    const merged = mergeLibrary(previous, other);
    assert.equal(Object.keys(merged.records).length, 2);
    assert.equal(merged.tags.length, 2);
    assert.equal(JSON.stringify(previous), before);
});

test('equal records with reordered JSON keys do not cause false conflicts', () => {
    const old = filled();
    const incoming = filled();
    const key = chatReference('character:b.png', 'same-chat');
    const original = incoming.records[key];
    incoming.records[key] = Object.fromEntries(Object.entries(original).reverse());
    const merged = mergeLibrary(old, incoming);
    assert.equal(merged.records[key].alias, '안개 속의 건물');
    assert.equal(Object.keys(merged.records).length, 1);
});

test('conflicting imported alias and catalog IDs are rejected; existing data unchanged', () => {
    const previous = filled();
    const incoming = filled();
    incoming.records[chatReference('character:b.png', 'same-chat')].alias = '강제로 덮어쓰기';
    const before = JSON.stringify(previous);
    assert.throws(() => mergeLibrary(previous, incoming), /충돌/);
    const conflicts = filled();
    conflicts.folders[0].name = '다른 폴더';
    assert.throws(() => mergeLibrary(previous, conflicts), /충돌/);
    assert.equal(JSON.stringify(previous), before);
});

test('duplicate catalog IDs and malformed references are not silently repaired', () => {
    const data = filled();
    data.tags.push({ id: 't_1', name: '중복' });
    assert.throws(() => validateLibrary(data), /식별자/);
    const injected = emptyLibrary();
    injected.records['["character:b.png","../../outside"]'] = item('no');
    assert.throws(() => validateLibrary(injected), /식별자/);
});

test('prototype keys do not mutate the Object prototype', () => {
    const json = JSON.parse(createLibraryBackup(emptyLibrary()));
    // Direct assignment to __proto__ changes prototype rather than creating
    // an own JSON field; simulate a real crafted backup property instead.
    Object.defineProperty(json.library.records, '__proto__', {
        value: { polluted: true }, enumerable: true, writable: true, configurable: true,
    });
    assert.throws(() => parseLibraryBackup(JSON.stringify(json)), /식별자/);
    assert.equal(({}).polluted, undefined);
});

test('no read or app start creates library namespace and import triggers one save', () => {
    const current = ctx();
    const store = new LibraryRepository(() => current);
    assert.deepEqual(store.inspect(), { chats: 0, folders: 0, tags: 0, aliases: 0, favorites: 0 });
    assert.equal(Object.hasOwn(current.extensionSettings, LIBRARY_KEY), false);
    const result = store.importAdditively(filled());
    assert.equal(result.changed, true);
    assert.equal(current.saveCount, 1);
    assert.equal(current.extensionSettings.other_extension.marker, 'KEEP');
    const noChange = store.importAdditively(filled());
    assert.equal(noChange.changed, false);
    assert.equal(current.saveCount, 1);
});

test('repository import never mutates old data on conflict or validation failure', () => {
    const current = ctx();
    current.extensionSettings[LIBRARY_KEY] = filled();
    const store = new LibraryRepository(() => current);
    const before = JSON.stringify(current.extensionSettings);
    const conflicting = filled();
    conflicting.records[chatReference('character:b.png', 'same-chat')].alias = 'wrong';
    assert.throws(() => store.importAdditively(conflicting), /충돌/);
    assert.throws(() => store.importAdditively({schemaVersion:10}), /손상된/);
    assert.equal(JSON.stringify(current.extensionSettings), before);
    assert.equal(current.saveCount, undefined);
});

test('synchronous SillyTavern save failure rolls back without touching other namespaces', () => {
    const current = ctx();
    current.saveSettingsDebounced = () => { throw new Error('settings are unavailable'); };
    const store = new LibraryRepository(() => current);
    assert.throws(() => store.importAdditively(filled()), /settings are unavailable/);
    assert.equal(Object.hasOwn(current.extensionSettings, LIBRARY_KEY), false);
    assert.equal(current.extensionSettings.other_extension.marker, 'KEEP');
});

test('invalid stored library is not replaced by an empty library on read/import', () => {
    const current = ctx();
    current.extensionSettings[LIBRARY_KEY] = {schemaVersion:17, important:'retain this'};
    const store = new LibraryRepository(() => current);
    assert.throws(() => store.read(), /손상된/);
    assert.throws(() => store.importAdditively(emptyLibrary()), /손상된/);
    assert.equal(current.extensionSettings[LIBRARY_KEY].important, 'retain this');
});


test('legacy v1 library backup migrates in memory without overwriting alias values', () => {
    const old = filled();
    old.schemaVersion = 1;
    for (const record of Object.values(old.records)) delete record.description;
    const frozen = JSON.stringify(old);
    const validated = validateLibrary(old);
    assert.equal(JSON.stringify(old), frozen, 'a read must not write');
    assert.equal(validated.schemaVersion, 2);
    const reference = chatReference('character:b.png','same-chat');
    assert.equal(validated.records[reference].alias,'안개 속의 건물');
    assert.equal(validated.records[reference].description,'');
    const backup = JSON.parse(createLibraryBackup(emptyLibrary()));
    backup.schemaVersion = 1;
    backup.library = old;
    const imported = parseLibraryBackup(JSON.stringify(backup)).library;
    assert.equal(imported.records[reference].alias,'안개 속의 건물');
    assert.equal(imported.records[reference].description,'');
    const merged = mergeLibrary(emptyLibrary(), imported);
    assert.equal(merged.records[reference].alias,'안개 속의 건물');
});

test('descriptions survive v2 backup roundtrip, invalid data is not written', () => {
    const current = ctx();
    const reference = currentChatReference(current);
    const store = new LibraryRepository(() => current);
    store.update({kind:'chat',type:'description',reference,value:'라쟉과 로폰의 이야기'});
    const record = store.read().records[reference];
    assert.equal(record.description,'라쟉과 로폰의 이야기');
    assert.equal(record.alias,'');
    const parsed = parseLibraryBackup(createLibraryBackup(store.read()));
    assert.equal(parsed.library.records[reference].description,'라쟉과 로폰의 이야기');
    const snapshot = JSON.stringify(current.extensionSettings);
    assert.throws(()=>store.update({kind:'chat',type:'description',reference,value:'x'.repeat(241)}),/240/);
    assert.equal(JSON.stringify(current.extensionSettings),snapshot);
});

test('old saved v1 library is migrated only on a meaningful edit', () => {
    const current = ctx();
    const legacy = filled();
    legacy.schemaVersion = 1;
    for(const row of Object.values(legacy.records)) delete row.description;
    current.extensionSettings[LIBRARY_KEY] = legacy;
    const snapshot = JSON.stringify(legacy);
    const store = new LibraryRepository(()=>current);
    assert.equal(store.read().schemaVersion,2);
    assert.equal(JSON.stringify(current.extensionSettings[LIBRARY_KEY]),snapshot);
    const reference = chatReference('character:b.png','same-chat');
    store.update({kind:'chat',type:'description',reference,value:'새로운 설명'});
    assert.equal(current.extensionSettings[LIBRARY_KEY].schemaVersion,2);
    assert.equal(current.extensionSettings[LIBRARY_KEY].records[reference].alias,'안개 속의 건물');
    assert.equal(current.extensionSettings[LIBRARY_KEY].records[reference].description,'새로운 설명');
    assert.equal(current.extensionSettings.other_extension.marker,'KEEP');
    assert.equal(current.saveCount,1);
});
