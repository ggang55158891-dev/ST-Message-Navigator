import test from 'node:test';
import assert from 'node:assert/strict';
import {
    cleanChatId, buildingScope, parseLastActivity, normalizeBuildings, findBuildings,
} from '../building-data.js';

test('building IDs use SillyTavern chat filenames without extension', () => {
    assert.equal(cleanChatId('first-chapter.jsonl'), 'first-chapter');
    assert.equal(cleanChatId('Another.JSONL'), 'Another');
    assert.equal(cleanChatId('2026-11-01'), '2026-11-01');
    assert.equal(cleanChatId(null), '');
});

test('character/group scopes do not overlap even for identical chat names', () => {
    const ctx = { characterId: 1, characters: [{avatar:'a.png'}, {avatar:'b.png'}], groups: [] };
    assert.equal(buildingScope(ctx), 'character:b.png');
    assert.equal(buildingScope({...ctx, groupId:'12'}), 'group:12');
    assert.equal(buildingScope({...ctx, characterId:99}), null);
});

test('building list de-duplicates names, keeps file identity and includes currently open chat', () => {
    const rows = [
        { file_name: 'sceneA.jsonl', message_count: 22, preview_message: 'Hello' },
        { file_name: 'sceneA.jsonl', message_count: 15 },
        { file_name: 'sceneB.jsonl', message_count: 0 },
    ];
    const buildings = normalizeBuildings(rows, 'current');
    assert.deepEqual(buildings.map(b=>b.id), ['sceneA','sceneB','current']);
    assert.equal(buildings[0].count, 22);
    assert.equal(buildings[0].preview, 'Hello');
    assert.equal(buildings[2].count, null);
});

test('recent order uses activity timestamps, name order is alphabetical', () => {
    const a = [
        { id:'old', name:'Zulu', preview:'', lastActivity:100 },
        { id:'new', name:'Alpha', preview:'', lastActivity:300 },
        { id:'middle', name:'Beta', preview:'', lastActivity:200 },
    ];
    assert.deepEqual(findBuildings(a,'','recent').map(x=>x.id),['new','middle','old']);
    assert.deepEqual(findBuildings(a,'','name').map(x=>x.id),['new','middle','old']);
});

test('search matches building name, chat filename and preview without changing list', () => {
    const buildings = normalizeBuildings([
        {file_name:'scene-1.jsonl',display_name:'유리 건물',preview_message:'구름 위에서 만난 날'},
        {file_name:'scene-2.jsonl',display_name:'기계실',preview_message:'녹슨 문'},
    ]);
    assert.equal(findBuildings(buildings,'구름').length,1);
    assert.equal(findBuildings(buildings,'SCENE-2')[0].id,'scene-2');
    assert.equal(findBuildings(buildings,'없는 이름').length,0);
    assert.equal(buildings.length,2);
});

test('timestamp parsing accepts ISO strings, Unix seconds and milliseconds', () => {
    assert.equal(parseLastActivity('2026-11-01T00:00:00Z'), Date.UTC(2026,10,1));
    assert.equal(parseLastActivity(1761955200), 1761955200000);
    assert.equal(parseLastActivity(1761955200000), 1761955200000);
    assert.equal(parseLastActivity('not a date'),0);
});
