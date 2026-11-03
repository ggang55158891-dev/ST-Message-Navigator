import test from 'node:test';
import assert from 'node:assert/strict';
import {hashJsonl,parseChatJsonl,sameChatJsonl,expiryFor,TRASH_RETENTION} from '../recovery-vault.js';
import {archiveBeforeAction,confirmActionResult,restoreFromVault,recoveredFilename} from '../recovery-operations.js';
import {emptyLibrary,emptyRecord,chatReference} from '../library-data.js';

const raw='{"chat_metadata":{"test":1}}\n{"mes":"안녕","swipes":["원본","대안"],"swipe_id":1}\n';
const scope='character:hero.png';
const buildings=[{id:'old',name:'Old'},{id:'current',name:'Current'}];
const ctx=()=>{
    const state={
        chat:[],chatId:'current',characterId:0,
        characters:[{name:'Hero',avatar:'hero.png'}],
        groups:[],groupId:null,
        getRequestHeaders:()=>({'Content-Type':'application/json'}),
    };
    return state;
};
const response=(result)=>({ok:true,json:async()=>result});
function memory(){
    const map=new Map(),entries=new Map();
    return {
        map,entries,async store(args){
            const id='archive-'+(entries.size+1);
            const meta={...args,id,hash:await hashJsonl(args.raw),
                bytes:args.raw.length,createdAt:Date.now(),state:'prepared'};
            entries.set(id,{meta,raw:args.raw});return meta;
        },
        async read(id){const item=entries.get(id);if(!item)throw Error('missing');return item;},
        async mark(id,state,newId){const item=entries.get(id);item.meta.state=state;item.meta.resultName=newId;},
    };
}
test('Q07C JSONL parsing is strict and raw checksum preserves character content',async()=>{
    const digest=await hashJsonl(raw);
    assert.match(digest,/^[0-9a-f]{64}$/);
    assert.equal(parseChatJsonl(raw)[1].swipes[1],'대안');
    assert.equal(sameChatJsonl(raw,raw.trimEnd()),true);
    assert.equal(sameChatJsonl(raw,raw.replace('안녕','다름')),false);
    assert.throws(()=>parseChatJsonl('{"mes":"no header"}\n'),/헤더/);
    assert.throws(()=>parseChatJsonl('{"chat_metadata":{}}\nINVALID'),/2번째/);
    assert.equal(expiryFor(10,0),null);
    assert.equal(expiryFor(10,30),10+30*86400_000);
    assert.deepEqual(TRASH_RETENTION,[7,30,90,0]);
});
test('Q07C archive fetches original twice, verifies stable source and snapshots only its management record',async()=>{
    const state=ctx(),vault=memory();let reads=0;
    const library=emptyLibrary();
    library.folders.push({id:'folder1',name:'진행'});
    library.tags.push({id:'tag1',name:'중요'});
    library.records[chatReference(scope,'old')]={...emptyRecord(),alias:'작품',
        folderId:'folder1',tagIds:['tag1'],favorite:true};
    const result=await archiveBeforeAction({
        vault,context:()=>state,scope,buildings,id:'old',kind:'delete',
        library,fetcher:async(path,opts)=>{
            assert.equal(path,'/api/chats/export');
            assert.equal(JSON.parse(opts.body).file,'old.jsonl');
            reads++;return response({result:raw});
        },
    });
    assert.equal(reads,2);
    assert.equal(result.name,'old');
    assert.equal(result.librarySnapshot.records[chatReference(scope,'old')].alias,'작품');
    assert.equal(result.librarySnapshot.folders.length,1);
    assert.equal(result.librarySnapshot.tags.length,1);
    assert.equal(Object.keys(result.librarySnapshot.records).length,1);
});
test('Q07C stale archive cannot authorize deletion if chat mutates after backup',async()=>{
    const state=ctx(),vault=memory();let count=0;
    await assert.rejects(()=>archiveBeforeAction({
        vault,context:()=>state,scope,buildings,id:'old',kind:'delete',
        library:emptyLibrary(),fetcher:async()=>{
            count++;return response({result:count===1?raw:raw.replace('안녕','수정됨')});
        },
    }),/원본 내용/);
    assert.equal(vault.entries.size,1,'Uncertain backup must remain for manual recovery');
});
test('Q07C independent post-delete and post-rename backend verification detects wrong results',async()=>{
    const state=ctx(),meta={scope,avatar:'hero.png',isGroup:false,name:'old',action:'delete'};
    const common={context:()=>state,record:meta};
    assert.equal(await confirmActionResult({...common,fetcher:async()=>({status:404,ok:false})}),true);
    await assert.rejects(()=>confirmActionResult({...common,fetcher:async()=>response({result:raw})}),/여전히/);
    const renamed={...meta,action:'rename',hash:await hashJsonl(raw)};
    const seen=[];
    assert.equal(await confirmActionResult({
        context:()=>state,record:renamed,result:{newId:'new'},
        fetcher:async(_path,opts)=>{
            const name=JSON.parse(opts.body).file;seen.push(name);
            return name==='new.jsonl'?response({result:raw}):{ok:false,status:404};
        },
    }),true);
    assert.deepEqual(seen,['new.jsonl','old.jsonl']);
});
test('Q07C restore only writes a novel filename, preserves swipes and never replaces existing chat',async()=>{
    const state=ctx(),vault=memory();
    const item=await vault.store({scope,name:'old',raw,isGroup:false,avatar:'hero.png',action:'delete'});
    const calls=[],existing=new Map([['current',raw]]);
    let libraryCopies=0;
    const result=await restoreFromVault({
        vault,context:()=>state,archiveId:item.id,
        libraryRepository:{importAdditively:()=>{libraryCopies++;}},
        fetcher:async(path,opts)=>{
            const body=JSON.parse(opts.body);
            calls.push({path,body});
            if(path==='/api/chats/export') {
                const id=body.file.replace(/\.jsonl$/,'');
                return existing.has(id)?response({result:existing.get(id)}):{ok:false,status:404};
            }
            assert.equal(path,'/api/chats/save');
            assert.ok(body.file_name.startsWith('old - restored'));
            assert.equal(existing.has(body.file_name),false);
            assert.equal(body.chat[1].swipes[1],'대안');
            existing.set(body.file_name,body.chat.map(x=>JSON.stringify(x)).join('\n'));
            return response({ok:true});
        },
    });
    assert.equal(state.chatId,'current');
    assert.equal(existing.get('current'),raw);
    assert.equal(result.newId.includes('restored'),true);
    assert.equal(vault.entries.get(item.id).meta.state,'restored');
    assert.equal(libraryCopies,0);
});
test('Q07C restore never writes if current scope is different; restored name is safe',async()=>{
    const vault=memory();const item=await vault.store({
        scope,name:'old',raw,isGroup:false,avatar:'hero.png',action:'delete',
    });
    const state={...ctx(),characterId:0,characters:[{avatar:'different.png'}]};
    let writes=0;
    await assert.rejects(()=>restoreFromVault({
        vault,context:()=>state,archiveId:item.id,
        libraryRepository:{importAdditively:()=>{}},
        fetcher:async()=>{writes++;return response({ok:true});},
    }),/원래 캐릭터/);
    assert.equal(writes,0);
    assert.match(recoveredFilename('거대한 이름'.repeat(20)),/restored-/);
    assert.ok(recoveredFilename('거대한 이름'.repeat(20)).length<=120);
});
