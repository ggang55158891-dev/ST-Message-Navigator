import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyLibrary,chatReference,LIBRARY_KEY} from '../library-data.js';
import {changeLibrary,bulkChangeLibrary,MAX_BULK_LIBRARY_CHATS} from '../library-operations.js';
import {LibraryRepository} from '../library-repository.js';

const scope='character:hero.png';
const groupScope='group:7';
const ids=['chat-a','chat-b','chat-c'];
const key=id=>chatReference(scope,id);
const decorate=()=>{
    let lib=emptyLibrary();
    lib=changeLibrary(lib,{kind:'folder',type:'create',id:'f1',name:'연재'});
    lib=changeLibrary(lib,{kind:'tag',type:'create',id:'t1',name:'중요'});
    lib=changeLibrary(lib,{kind:'chat',type:'description',reference:key('chat-a'),value:'기존 설명'});
    lib=changeLibrary(lib,{kind:'chat',type:'favorite',reference:key('chat-a'),value:true});
    lib=changeLibrary(lib,{kind:'chat',type:'tag',reference:key('chat-a'),value:'t1',enabled:true});
    return lib;
};

test('Q08 bulk folder affects only selected current-scope chats and preserves descriptions/tags',()=>{
    const before=decorate();
    const outside=chatReference(groupScope,'chat-a');
    before.records[outside]={...before.records[key('chat-a')],description:'그룹 전용'};
    const result=bulkChangeLibrary(before,{scope,ids:['chat-a','chat-b'],
        availableIds:ids,operation:'folder',value:'f1'});
    assert.equal(result.changed,2);
    assert.equal(result.library.records[key('chat-a')].description,'기존 설명');
    assert.deepEqual(result.library.records[key('chat-a')].tagIds,['t1']);
    assert.equal(result.library.records[key('chat-a')].favorite,true);
    assert.equal(result.library.records[key('chat-b')].folderId,'f1');
    assert.equal(result.library.records[outside].description,'그룹 전용');
    assert.equal(before.records[key('chat-b')],undefined,'input must not mutate');
    assert.equal(before.records[key('chat-a')].folderId,null);
    const repeat=bulkChangeLibrary(result.library,{scope,ids:['chat-a','chat-b'],
        availableIds:ids,operation:'folder',value:'f1'});
    assert.equal(repeat.changed,0);
});

test('Q08 favorites and tag edits support both directions without erasing unrelated fields',()=>{
    let lib=decorate();
    const run=(operation,value=null)=>{
        const result=bulkChangeLibrary(lib,{scope,ids:['chat-a','chat-b'],
            availableIds:ids,operation,value});
        lib=result.library;return result.changed;
    };
    assert.equal(run('favorite-add'),1);
    assert.equal(run('favorite-remove'),2);
    assert.equal(run('tag-add','t1'),1);
    assert.deepEqual(lib.records[key('chat-a')].tagIds,['t1']);
    assert.deepEqual(lib.records[key('chat-b')].tagIds,['t1']);
    assert.equal(run('tag-remove','t1'),2);
    assert.deepEqual(lib.records[key('chat-a')].tagIds,[]);
    assert.equal(lib.records[key('chat-a')].description,'기존 설명');
    assert.equal(run('folder',null),0);
});

test('Q08 refuses stale, duplicate, cross-scope and oversized selections atomically',()=>{
    const original=decorate(),snapshot=JSON.stringify(original);
    const base={scope,availableIds:ids,operation:'favorite-add'};
    for(const bad of [
        {...base,ids:['chat-a','missing']},
        {...base,ids:['chat-a','chat-a']},
        {...base,ids:['chat-a.jsonl']},
        {...base,ids:[]},
        {...base,ids:Array.from({length:21},(_,i)=>'chat-'+i)},
        {...base,ids:['chat-a'],operation:'folder',value:'not-a-folder'},
        {...base,ids:['chat-a'],operation:'tag-add',value:'not-a-tag'},
    ])assert.throws(()=>bulkChangeLibrary(original,bad));
    assert.equal(JSON.stringify(original),snapshot);
    assert.equal(MAX_BULK_LIBRARY_CHATS,20);
});

test('Q08 repository makes one save request, no-op skips save and rejected save rolls back',()=>{
    let writes=0,fail=false;
    const settings={};
    const ctx={
        characterId:0,characters:[{avatar:'hero.png'}],groupId:null,
        extensionSettings:settings,
        saveSettingsDebounced:()=>{writes++;if(fail)throw Error('save rejected');},
    };
    const repo=new LibraryRepository(()=>ctx);
    settings[LIBRARY_KEY]=decorate();
    let result=repo.bulkUpdate({scope,ids:['chat-b','chat-c'],availableIds:ids,
        operation:'favorite-add'});
    assert.equal(result.changed,2);
    assert.equal(result.saved,true);
    assert.equal(writes,1,'two chats must be one settings write request');
    result=repo.bulkUpdate({scope,ids:['chat-b','chat-c'],availableIds:ids,
        operation:'favorite-add'});
    assert.equal(result.changed,0);
    assert.equal(writes,1);
    const previous=settings[LIBRARY_KEY];
    fail=true;
    assert.throws(()=>repo.bulkUpdate({scope,ids:['chat-a'],availableIds:ids,
        operation:'favorite-remove'}),/save rejected/);
    assert.equal(settings[LIBRARY_KEY],previous,'rollback must restore original object reference');
    ctx.groupId=7;
    assert.throws(()=>repo.bulkUpdate({scope,ids:['chat-a'],availableIds:ids,
        operation:'favorite-remove'}),/범위/);
    assert.equal(writes,2,'stale scope must be rejected before settings save');
});
