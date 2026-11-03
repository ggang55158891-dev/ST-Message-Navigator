import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, chatReference, LIBRARY_KEY } from '../library-data.js';
import { changeLibrary, selectLibraryChats } from '../library-operations.js';
import { LibraryRepository } from '../library-repository.js';

const scope = 'character:two.png';
const ref = chatReference(scope, 'same-file');
const another = chatReference('character:one.png', 'same-file');
const base = [
    { id:'same-file', name:'File A', lastActivity: 500, count:4, preview:'some text' },
    { id:'old-file', name:'File B', lastActivity: 200, count:2, preview:'' },
    { id:'new-file', name:'File C', lastActivity: 800, count:8, preview:'' },
];
const doChange = (data, action) => changeLibrary(data, action);

test('alias is isolated by character scope without renaming JSONL files', () => {
    const start = emptyLibrary();
    const next = doChange(start, {kind:'chat',type:'alias',reference:ref,value:'겨울의 별명'});
    assert.equal(next.records[ref].alias, '겨울의 별명');
    assert.equal(next.records[another], undefined);
    assert.deepEqual(start, emptyLibrary());
    assert.equal(selectLibraryChats(base,scope,next)[1].displayName,'겨울의 별명');
    assert.equal(selectLibraryChats(base,'character:one.png',next)[1].displayName,'File A');
});

test('favorites filter, tag assignment, tag deletion preserve unrelated fields', () => {
    let data = emptyLibrary();
    data = doChange(data, {kind:'tag',type:'create',id:'t1',name:'판타지'});
    data = doChange(data, {kind:'chat',type:'favorite',reference:ref,value:true});
    data = doChange(data, {kind:'chat',type:'tag',reference:ref,value:'t1',enabled:true});
    assert.equal(selectLibraryChats(base,scope,data,{view:'favorites'}).length,1);
    assert.equal(selectLibraryChats(base,scope,data,{query:'판타지'})[0].id,'same-file');
    data = doChange(data, {kind:'tag',type:'rename',id:'t1',name:'공포'});
    assert.equal(data.records[ref].tagIds[0],'t1');
    data = doChange(data, {kind:'tag',type:'delete',id:'t1'});
    assert.deepEqual(data.records[ref].tagIds,[]);
    assert.equal(data.records[ref].favorite,true);
});

test('virtual folder CRUD never moves or deletes a chat file', () => {
    let data = emptyLibrary();
    data = doChange(data,{kind:'folder',type:'create',id:'f1',name:'진행 중'});
    data = doChange(data,{kind:'chat',type:'folder',reference:ref,value:'f1'});
    assert.deepEqual(selectLibraryChats(base,scope,data,{view:'folders',folderId:'f1'}).map(x=>x.id),['same-file']);
    assert.equal(selectLibraryChats(base,scope,data,{view:'folders',folderId:''}).length,2);
    data = doChange(data,{kind:'folder',type:'rename',id:'f1',name:'완성'});
    assert.equal(data.records[ref].folderId,'f1');
    data = doChange(data,{kind:'folder',type:'delete',id:'f1'});
    assert.equal(data.records[ref].folderId,null);
    assert.ok(data.records[ref]);
    assert.equal(data.folders.length,0);
});

test('sort recent, folder+recent, explicit creation date, unknown creation date last', () => {
    let data = emptyLibrary();
    data = doChange(data,{kind:'folder',type:'create',id:'f1',name:'A 폴더'});
    data = doChange(data,{kind:'chat',type:'folder',reference:ref,value:'f1'});
    const createdRef = chatReference(scope,'old-file');
    data.records[createdRef] = {
        alias:'',description:'',folderId:null,favorite:false,tagIds:[],imageRef:null,lastRead:null,
        customSortOrder:null,createdAt:'2026-05-01T00:00:00Z',createdAtSource:'metadata',
    };
    assert.deepEqual(selectLibraryChats(base,scope,data,{sort:'recent'}).map(x=>x.id), ['new-file','same-file','old-file']);
    assert.deepEqual(selectLibraryChats(base,scope,data,{sort:'created'}).map(x=>x.id), ['old-file','new-file','same-file']);
    assert.equal(selectLibraryChats(base,scope,data,{sort:'folders'})[0].id,'same-file');
});

test('search only lightweight metadata, not chat text or preview', () => {
    const data = emptyLibrary();
    assert.equal(selectLibraryChats(base,scope,data,{query:'File A'}).length,1);
    assert.equal(selectLibraryChats(base,scope,data,{query:'some text'}).length,0);
    assert.equal(selectLibraryChats(base,scope,data,{query:'never there'}).length,0);
});

test('duplicate folder/tag names, unknown IDs, overlong alias and invalid actions rejected', () => {
    let data = emptyLibrary();
    data = doChange(data,{kind:'folder',type:'create',id:'f1',name:'Moon'});
    assert.throws(()=>doChange(data,{kind:'folder',type:'create',id:'f2',name:'moon'}),/이미 사용/);
    assert.throws(()=>doChange(data,{kind:'chat',type:'folder',reference:ref,value:'missing'}),/존재하지/);
    assert.throws(()=>doChange(data,{kind:'chat',type:'tag',reference:ref,value:'t1',enabled:true}),/태그/);
    assert.throws(()=>doChange(data,{kind:'chat',type:'alias',reference:ref,value:'a'.repeat(121)}),/120/);
    assert.throws(()=>doChange(data,{kind:'chat',type:'remove-file',reference:ref}),/지원하지/);
    assert.equal(data.folders.length,1);
});

test('repository only saves on explicit edits; no-op updates are ignored', () => {
    const ctx={extensionSettings:{third_party:{secret:'preserve'}},count:0,
        saveSettingsDebounced(){this.count++;}};
    const repository=new LibraryRepository(()=>ctx);
    repository.update({kind:'chat',type:'favorite',reference:ref,value:true});
    assert.equal(ctx.count,1);
    repository.update({kind:'chat',type:'favorite',reference:ref,value:true});
    assert.equal(ctx.count,1);
    assert.equal(ctx.extensionSettings.third_party.secret,'preserve');
    assert.equal(ctx.extensionSettings[LIBRARY_KEY].records[ref].favorite,true);
});

test('repository save exception rolls back while leaving the old stored library', () => {
    const ctx={extensionSettings:{third_party:'safe'},saveSettingsDebounced(){throw new Error('blocked');}};
    const repository=new LibraryRepository(()=>ctx);
    assert.throws(()=>repository.update({kind:'chat',type:'favorite',reference:ref,value:true}),/blocked/);
    assert.equal(Object.hasOwn(ctx.extensionSettings,LIBRARY_KEY),false);
    assert.equal(ctx.extensionSettings.third_party,'safe');
});


test('chat descriptions are searchable, separate from aliases, and safe to clear', () => {
    let library=emptyLibrary();
    library=changeLibrary(library,{kind:'chat',type:'alias',reference:ref,value:'예전 별명'});
    library=changeLibrary(library,{kind:'chat',type:'description',reference:ref,value:'따뜻한 겨울 이야기'});
    assert.equal(library.records[ref].alias,'예전 별명');
    assert.equal(library.records[ref].description,'따뜻한 겨울 이야기');
    assert.equal(selectLibraryChats(base,scope,library,{query:'겨울 이야기'})[0].id,'same-file');
    library=changeLibrary(library,{kind:'chat',type:'description',reference:ref,value:''});
    assert.equal(library.records[ref].alias,'예전 별명');
    assert.equal(library.records[ref].description,'');
    assert.throws(()=>changeLibrary(library,{kind:'chat',type:'description',reference:ref,value:'a\nb'}),/제어문자/);
});
