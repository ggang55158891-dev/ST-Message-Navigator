import test from 'node:test';
import assert from 'node:assert/strict';
import {validateFilePlan,validateNewChatName,renameInactiveChat,deleteInactiveChat} from '../file-operations.js';
import {moveLibraryReference,forgetLibraryReference} from '../library-operations.js';
import {chatReference,emptyLibrary,emptyRecord} from '../library-data.js';

const scope='character:hero.png';
const buildings=[{id:'current',name:'current'},{id:'other',name:'other'}];
function ctx() {
    const events=[];
    return {
        chatId:'current', chat:[],characterId:0,groupId:null,
        characters:[{name:'Hero',avatar:'hero.png',chat:'current'}],groups:[],
        getRequestHeaders:()=>({'Content-Type':'application/json', 'X-CSRF-Token':'ok'}),
        eventTypes:{CHAT_RENAMED:'renamed',CHAT_DELETED:'deleted',
            GROUP_CHAT_DELETED:'groupDeleted'},
        eventSource:{emit:async(type,detail)=>events.push({type,detail})},
        events,
    };
}
const ok=(data={ok:true})=>({ok:true,json:async()=>data});
const bad=(status=500)=>({ok:false,status,json:async()=>({error:true})});
function fixture(fetcher,original=ctx(),sc=scope,available=buildings) {
    return {context:()=>original,scope:sc,buildings:available,fetcher};
}

test('Q07B rejects active chat, cross-scope, unsafe names, collisions and shared-group IDs before mutation',()=>{
    const state=ctx();
    assert.throws(()=>validateFilePlan(state,scope,buildings,'current','delete'),/현재 열려/);
    assert.throws(()=>validateFilePlan(state,'character:other.png',buildings,'other','delete'),/범위/);
    assert.throws(()=>validateFilePlan(state,scope,buildings,'other','rename','current'),/중복/);
    for(const name of ['','../escape','bad.jsonl','CON','aux.txt','x/y','x\\y','hi.','hi ','a'.repeat(121),'.hidden','foo:bar','other']) {
        assert.throws(()=>validateFilePlan(state,scope,buildings,'other','rename',name),name);
    }
    assert.equal(validateNewChatName('라쟉 이야기-2'),'라쟉 이야기-2');
    assert.equal(validateFilePlan(state,scope,buildings,'other','rename','new-story').destination,'new-story');
    const group={...state,groupId:42,groups:[
        {id:42,chats:['current','other']},{id:43,chats:['other']},
    ]};
    assert.throws(()=>validateFilePlan(group,'group:42',buildings,'other','delete'),/다른 그룹/);
});

test('Q07B character rename verifies server result and emits native event with original metadata intact',async()=>{
    const state=ctx(),calls=[];
    const result=await renameInactiveChat({
        ...fixture(async(path,opts)=>{
            calls.push({path,body:JSON.parse(opts.body)});
            return ok({ok:true,sanitizedFileName:'바뀐 이름'});
        },state),id:'other',newName:'바뀐 이름',
    });
    assert.equal(result.newId,'바뀐 이름');
    assert.equal(calls.length,1);
    assert.equal(calls[0].path,'/api/chats/rename');
    assert.deepEqual(calls[0].body,{
        is_group:false,avatar_url:'hero.png',
        original_file:'other.jsonl',renamed_file:'바뀐 이름.jsonl',
    });
    assert.equal(state.characters[0].chat,'current');
    assert.equal(state.chatId,'current');
    assert.deepEqual(state.events[0],{
        type:'renamed',detail:{
            avatarId:'hero.png',groupId:null,
            oldFileName:'other.jsonl',newFileName:'바뀐 이름.jsonl',
        },
    });
});

test('Q07B character delete only inactive file; server failures never fake success',async()=>{
    const state=ctx(),requests=[];
    const success=await deleteInactiveChat({
        ...fixture(async(path,opts)=>{
            requests.push({path,payload:JSON.parse(opts.body)});return ok();
        },state),id:'other',
    });
    assert.equal(success.deletedId,'other');
    assert.deepEqual(requests,[{
        path:'/api/chats/delete',payload:{chatfile:'other.jsonl',avatar_url:'hero.png'},
    }]);
    assert.equal(state.chatId,'current');
    assert.equal(state.events[0].type,'deleted');
    const fail=ctx();
    await assert.rejects(()=>deleteInactiveChat({
        ...fixture(async()=>bad(503),fail),id:'other',
    }),/503/);
    assert.equal(fail.events.length,0);
});

test('Q07B group rename updates group membership and emits after server commits',async()=>{
    const state={...ctx(),groupId:42,
        groups:[{id:42,chats:['current','other'],chat_id:'current',name:'Test'}]};
    const calls=[];
    const outcome=await renameInactiveChat({
        ...fixture(async(path,opts)=>{calls.push({path,body:JSON.parse(opts.body)});
            return path==='/api/chats/rename'?ok({ok:true,sanitizedFileName:'renamed'}):ok();
        },state,'group:42'),
        id:'other',newName:'renamed',
    });
    assert.equal(outcome.groupUpdated,true);
    assert.deepEqual(calls.map(c=>c.path),['/api/chats/rename','/api/groups/edit']);
    assert.deepEqual(calls[1].body.chats,['current','renamed']);
    assert.deepEqual(state.groups[0].chats,['current','renamed']);
    assert.equal(state.groups[0].chat_id,'current');
    assert.equal(state.events[0].type,'renamed');
});

test('Q07B group rename failure restores old file name without touching group references',async()=>{
    const state={...ctx(),groupId:42,
        groups:[{id:42,chats:['current','other'],chat_id:'current'}]};
    const requests=[];
    await assert.rejects(()=>renameInactiveChat({
        ...fixture(async(path,opts)=>{
            requests.push({path,body:JSON.parse(opts.body)});
            return path==='/api/groups/edit'?bad(500):ok({ok:true,sanitizedFileName:
                JSON.parse(opts.body).renamed_file.replace(/\.jsonl$/,'')});
        },state,'group:42'),
        id:'other',newName:'renamed',
    }),/되돌렸습니다/);
    assert.deepEqual(requests.map(r=>r.path),
        ['/api/chats/rename','/api/groups/edit','/api/chats/rename']);
    assert.deepEqual(requests[2].body,{
        is_group:true,avatar_url:null,
        original_file:'renamed.jsonl',renamed_file:'other.jsonl',
    });
    assert.deepEqual(state.groups[0].chats,['current','other']);
    assert.equal(state.events.length,0);
});

test('Q07B failed group rename rollback reports uncertainty and does not emit success',async()=>{
    const state={...ctx(),groupId:42,groups:[{id:42,chats:['current','other']}]};
    let n=0;
    await assert.rejects(()=>renameInactiveChat({
        ...fixture(async(path)=>{
            n++;
            if(path==='/api/groups/edit' || n===3)return bad(500);
            return ok({ok:true,sanitizedFileName:'renamed'});
        },state,'group:42'),id:'other',newName:'renamed',
    }),/수동 확인/);
    assert.deepEqual(state.groups[0].chats,['current','other']);
    assert.equal(state.events.length,0);
});

test('Q07B group delete removes reference first, then file, and updates in-memory only after success',async()=>{
    const state={...ctx(),groupId:42,
        groups:[{id:42,chats:['current','other'],chat_id:'current'}]};
    const requests=[];
    const outcome=await deleteInactiveChat({
        ...fixture(async(path,opts)=>{requests.push({path,body:JSON.parse(opts.body)});return ok();},
            state,'group:42'),id:'other',
    });
    assert.equal(outcome.groupUpdated,true);
    assert.deepEqual(requests.map(r=>r.path),['/api/groups/edit','/api/chats/group/delete']);
    assert.deepEqual(requests[0].body.chats,['current']);
    assert.deepEqual(requests[1].body,{id:'other'});
    assert.deepEqual(state.groups[0].chats,['current']);
    assert.equal(state.groups[0].chat_id,'current');
    assert.equal(state.events[0].type,'groupDeleted');
});

test('Q07B failed group deletion restores group membership and leaves events untouched',async()=>{
    const state={...ctx(),groupId:42,
        groups:[{id:42,chats:['current','other'],chat_id:'current'}]};
    const requests=[];
    await assert.rejects(()=>deleteInactiveChat({
        ...fixture(async(path,opts)=>{requests.push(path);
            return path==='/api/chats/group/delete'?bad(404):ok();
        },state,'group:42'),id:'other',
    }),/되돌렸습니다/);
    assert.deepEqual(requests,['/api/groups/edit','/api/chats/group/delete','/api/groups/edit']);
    assert.deepEqual(state.groups[0].chats,['current','other']);
    assert.equal(state.events.length,0);
});

test('Q07B library metadata migration preserves notes/favorites/folders and prevents overwrite',()=>{
    const library=emptyLibrary();
    library.folders=[{id:'f1',name:'진행 중'}];
    library.tags=[{id:'t1',name:'메인'}];
    const oldKey=chatReference(scope,'other'),newKey=chatReference(scope,'new');
    library.records[oldKey]={...emptyRecord(),favorite:true,folderId:'f1',
        tagIds:['t1'],description:'내 이야기'};
    const copy=structuredClone(library);
    const moved=moveLibraryReference(library,scope,'other','new').library;
    assert.deepEqual(library,copy,'pure migration cannot mutate original');
    assert.equal(moved.records[oldKey],undefined);
    assert.equal(moved.records[newKey].description,'내 이야기');
    assert.equal(moved.records[newKey].favorite,true);
    assert.deepEqual(moved.records[newKey].tagIds,['t1']);
    const deleted=forgetLibraryReference(moved,scope,'new').library;
    assert.equal(deleted.records[newKey],undefined);
    assert.equal(deleted.folders[0].id,'f1');
    assert.equal(deleted.tags[0].id,'t1');
    moved.records[oldKey]={...emptyRecord(),favorite:false};
    assert.throws(()=>moveLibraryReference(moved,scope,'other','new'),/덮어쓰지/);
});
