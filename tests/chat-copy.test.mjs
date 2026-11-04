import test from 'node:test';
import assert from 'node:assert/strict';
import {copyChatFile,validateCopyPlan,suggestCopyName} from '../chat-copy.js';
import {cloneLibraryReference} from '../library-operations.js';
import {emptyRecord,emptyLibrary,chatReference,LIBRARY_KEY} from '../library-data.js';
import {LibraryRepository} from '../library-repository.js';

const raw='{"chat_metadata":{"keep":1}}\n{"mes":"원문","swipes":["일","이"],"swipe_id":1}\n';
const scope='character:hero.png';
const buildings=[{id:'active'},{id:'source'}];
const makeState=()=>({
    chatId:'active',chat:[],characterId:0,groupId:null,
    characters:[{name:'Hero',avatar:'hero.png'}],groups:[],
    extensionSettings:{},getRequestHeaders:()=>({'Content-Type':'application/json'}),
    saveSettingsDebounced(){},
});
function fakeServer(initial=new Map([['source',raw]]),{failOn=null}={}){
    const files=new Map(initial),calls=[];
    const fetcher=async(path,opts)=>{
        const body=JSON.parse(opts.body);calls.push({path,body});
        if(failOn===path)return new Response('{}',{status:503});
        if(path==='/api/chats/export'){
            const id=body.file.slice(0,-6);
            if(!files.has(id))return new Response('{}',{status:404});
            return Response.json({result:files.get(id)});
        }
        if(path==='/api/chats/save'||path==='/api/chats/group/save'){
            const id=body.file_name??body.id;
            files.set(id,body.chat.map(x=>JSON.stringify(x)).join('\n'));
            return Response.json({ok:true});
        }
        if(path==='/api/chats/rename'){
            const from=body.original_file.slice(0,-6),to=body.renamed_file.slice(0,-6);
            if(!files.has(from)||files.has(to))return new Response('{}',{status:400});
            files.set(to,files.get(from));files.delete(from);
            return Response.json({ok:true,sanitizedFileName:to});
        }
        if(path==='/api/groups/edit')return Response.json({ok:true});
        throw new Error('unexpected '+path);
    };
    return {files,calls,fetcher};
}
const params=(state,server,extras={})=>({
    context:()=>state,scope,buildings,id:'source',
    newName:'새 복사본',random:()=> '12345678-1234-4123-8123-123456789abc',
    fetcher:server.fetcher,...extras,
});

test('Q09 source stays intact and semantic swipes preserved after staged rename',async()=>{
    const state=makeState(),server=fakeServer();
    const result=await copyChatFile(params(state,server));
    assert.equal(result.newId,'새 복사본');
    assert.equal(server.files.get('source'),raw);
    assert.ok(server.files.get('새 복사본').includes('"swipes":["일","이"]'));
    assert.ok(!server.files.has('stmn-copy-12345678-1234-4123-8123-123456789abc'));
    assert.deepEqual(server.calls.filter(x=>x.path!=='/api/chats/export').map(x=>x.path),
        ['/api/chats/save','/api/chats/rename']);
    assert.equal(state.chatId,'active');
});

test('Q09 rejects unsafe names and existing destinations before any writes',async()=>{
    const state=makeState(),server=fakeServer(new Map([['source',raw],['dup',raw]]));
    assert.throws(()=>validateCopyPlan(state,scope,buildings,'source','source'),/중복/);
    assert.throws(()=>validateCopyPlan(state,scope,buildings,'source','../bad'),/파일 이름/);
    assert.throws(()=>validateCopyPlan(state,'character:other.png',buildings,'source','new'),/범위/);
    assert.equal(suggestCopyName('source'),'source - 복사본');
    await assert.rejects(copyChatFile(params(state,server,{newName:'dup'})),/이미/);
    assert.ok(server.calls.every(x=>x.path==='/api/chats/export'));
});

test('Q09 writes nothing if source changed between preflight and save',async()=>{
    const state=makeState(),server=fakeServer();
    let reads=0;
    const fetcher=async(path,options)=>{
        const body=JSON.parse(options.body);
        if(path==='/api/chats/export'&&body.file==='source.jsonl'&&++reads===2)
            server.files.set('source',raw.replace('원문','다른 원문'));
        return server.fetcher(path,options);
    };
    await assert.rejects(copyChatFile(params(state,server,{fetcher})),/변경/);
    assert.ok(!server.calls.some(x=>x.path.includes('save')));
});

test('Q09 stage or rename failure reports a concrete temp filename for recovery',async()=>{
    const state=makeState(),server=fakeServer(undefined,{failOn:'/api/chats/rename'});
    await assert.rejects(copyChatFile(params(state,server)),/임시 파일 "stmn-copy-/);
    assert.equal(server.files.get('source'),raw);
    assert.ok(server.files.has('stmn-copy-12345678-1234-4123-8123-123456789abc'));
});

test('Q09 group clone appends only after rename verification and retains old memberships',async()=>{
    const state=makeState();
    state.groupId=42;
    state.groups=[{id:42,chats:['source','active'],name:'Group'},{id:43,chats:['source']}];
    const server=fakeServer();
    const result=await copyChatFile(params(state,server,{scope:'group:42'}));
    assert.equal(result.newId,'새 복사본');
    assert.deepEqual(state.groups[0].chats,['source','active','새 복사본']);
    assert.deepEqual(state.groups[1].chats,['source']);
    assert.deepEqual(server.calls.filter(x=>x.path!=='/api/chats/export').map(x=>x.path),
        ['/api/chats/group/save','/api/chats/rename','/api/groups/edit']);
});

test('Q09 group membership failure leaves source untouched and reports orphan possibility',async()=>{
    const state=makeState();state.groupId=42;
    state.groups=[{id:42,chats:['source','active']}];
    const server=fakeServer(undefined,{failOn:'/api/groups/edit'});
    await assert.rejects(copyChatFile(params(state,server,{scope:'group:42'})),/부분적으로/);
    assert.equal(server.files.get('source'),raw);
    assert.ok(server.files.has('새 복사본'));
    assert.deepEqual(state.groups[0].chats,['source','active']);
});

test('Q09 active chat flush is required before copying its server version',async()=>{
    const state=makeState(),server=fakeServer(new Map([['active',raw]]));
    let flushes=0;
    state.saveChat=async()=>{flushes++;return true;};
    await copyChatFile(params(state,server,{id:'active',newName:'복제-A'}));
    assert.equal(flushes,1);
    assert.equal(server.files.get('active'),raw);
    const other=makeState();
    await assert.rejects(copyChatFile(params(other,fakeServer(new Map([['active',raw]])),{
        id:'active',newName:'복제-A',
    })),/먼저/);
});

test('Q09 metadata clones only under destination chat, keeps old and rejects collisions',()=>{
    const lib=emptyLibrary();
    lib.folders=[{id:'f1',name:'연재'}];lib.tags=[{id:'t1',name:'중요'}];
    const old=chatReference(scope,'source'),copy=chatReference(scope,'새 복사본');
    lib.records[old]={...emptyRecord(),description:'설명',folderId:'f1',tagIds:['t1'],
        favorite:true,lastRead:12,createdAt:'2026-01-01T00:00:00Z',createdAtSource:'metadata'};
    const changed=cloneLibraryReference(lib,scope,'source','새 복사본').library;
    assert.equal(changed.records[old].description,'설명');
    assert.equal(changed.records[copy].description,'설명');
    assert.equal(changed.records[copy].lastRead,null);
    assert.equal(changed.records[copy].createdAt,null);
    assert.equal(lib.records[copy],undefined);
    assert.throws(()=>cloneLibraryReference(changed,scope,'source','새 복사본'),/이미/);
    const state=makeState();
    state.extensionSettings[LIBRARY_KEY]=lib;
    let saved=0;
    state.saveSettingsDebounced=()=>{saved++;};
    const repo=new LibraryRepository(()=>state);
    assert.equal(repo.cloneChatRecord(scope,'source','새 복사본'),true);
    assert.equal(saved,1);
    assert.equal(state.extensionSettings[LIBRARY_KEY].records[copy].folderId,'f1');
});
