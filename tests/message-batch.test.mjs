import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_MESSAGE_SELECTION,captureMessageSelection,ensureSelectionCurrent,
    validateBatchTitle,prepareMessageBatch,commitMessageBatch,
    matchesCurrentChatSnapshot,prepareDeletionBackup,deleteMessageSelection,
} from '../message-batch.js';
import {DATA_KEY,MESSAGE_KEY,isMessageBookmarked} from '../model.js';

const character=()=>({
    groupId:null,characterId:0,characters:[{name:'Hero',avatar:'hero.png'}],
    chatId:'sample',chat:[{name:'A',mes:'first',is_system:false,swipes:['one','two'],swipe_id:1},
        {name:'B',mes:'second',is_system:false},
        {name:'C',mes:'third',is_system:false},
        {name:'D',mes:'fourth',is_system:false}],
    chatMetadata:{topic:'unchanged'},
    getRequestHeaders:()=>({'Content-Type':'application/json'}),
    saveMetadata:async()=>{},
});
const scope='character:hero.png';
const rawOf=ctx=>[JSON.stringify({chat_metadata:ctx.chatMetadata}),
    ...ctx.chat.map(m=>JSON.stringify(m))].join('\n')+'\n';
const fetcherFor=(ctx,handler=()=>{})=>async(path,opts)=>{
    assert.equal(path,'/api/chats/export');
    handler(opts);
    return Response.json({result:rawOf(ctx)});
};
function runSelection(ctx,ids){return captureMessageSelection(ctx,ids);}

test('Q10 selection rejects duplicates, out-of-bounds and stale references',()=>{
    const ctx=character();
    assert.deepEqual(runSelection(ctx,[3,1]).items.map(x=>x.index),[1,3]);
    assert.equal(MAX_MESSAGE_SELECTION,20);
    for(const indices of [[],[0,0],[-1],[4],[0.5],Array.from({length:21},(_,i)=>i)]){
        assert.throws(()=>runSelection(ctx,indices));
    }
    const selection=runSelection(ctx,[0,1]);
    ctx.chat[1]={...ctx.chat[1]};
    assert.throws(()=>ensureSelectionCurrent(ctx,selection),/변경/);
    assert.throws(()=>validateBatchTitle('x'.repeat(300),20),/300/);
});

test('Q10 bookmark add/remove preserves swipe text, original speaker and external metadata',async()=>{
    const ctx=character(),before=structuredClone(ctx.chat);
    let saves=0;ctx.saveMetadata=async()=>{saves++;};
    const sel=runSelection(ctx,[0,2]);
    const plan=prepareMessageBatch(ctx,sel,{
        operation:'bookmark-add',idFactory:()=>crypto.randomUUID(),
    });
    assert.deepEqual(ctx.chat,before,'staging must never mutate live chat');
    assert.equal(plan.changed,2);
    await commitMessageBatch(()=>ctx,plan);
    assert.equal(saves,1);
    assert.equal(isMessageBookmarked(ctx.chat[0],ctx.chatMetadata),true);
    assert.equal(isMessageBookmarked(ctx.chat[2],ctx.chatMetadata),true);
    assert.deepEqual(ctx.chat[0].swipes,['one','two']);
    assert.equal(ctx.chatMetadata.topic,'unchanged');
    const off=prepareMessageBatch(ctx,runSelection(ctx,[0,2]),{operation:'bookmark-remove'});
    await commitMessageBatch(()=>ctx,off);
    assert.equal(saves,2);
    assert.equal(isMessageBookmarked(ctx.chat[0],ctx.chatMetadata),false);
    assert.equal(isMessageBookmarked(ctx.chat[2],ctx.chatMetadata),false);
});

test('Q10 title numbering follows source index order and keeps duplicate-ID swipe/bookmark marks',async()=>{
    const ctx=character();
    ctx.chat[0][MESSAGE_KEY]='same';
    ctx.chat[2][MESSAGE_KEY]='same';
    ctx.chatMetadata[DATA_KEY]={
        schema:1,titles:{same:'old'},bookmarks:{same:true},
        swipeAnnotations:{same:{fp:{favorite:true,tags:['keep']}}},
    };
    const plan=prepareMessageBatch(ctx,runSelection(ctx,[2,0]),{
        operation:'title',baseTitle:'첫 만남',idFactory:()=> 'new-independent-id',
    });
    assert.equal(ctx.chat[0][MESSAGE_KEY],'same');
    assert.equal(ctx.chatMetadata[DATA_KEY].titles.same,'old');
    await commitMessageBatch(()=>ctx,plan);
    const a=ctx.chat[0][MESSAGE_KEY],b=ctx.chat[2][MESSAGE_KEY];
    assert.notEqual(a,b);
    assert.equal(ctx.chatMetadata[DATA_KEY].titles[a],'첫 만남 1');
    assert.equal(ctx.chatMetadata[DATA_KEY].titles[b],'첫 만남 2');
    assert.equal(ctx.chatMetadata[DATA_KEY].bookmarks[a],true);
    assert.equal(ctx.chatMetadata[DATA_KEY].bookmarks[b],true);
    assert.deepEqual(ctx.chatMetadata[DATA_KEY].swipeAnnotations[a],
        {fp:{favorite:true,tags:['keep']}});
    assert.equal(ctx.chat[0].name,'A');
});

test('Q10 hidden state toggles only chosen rows and is idempotent',async()=>{
    const ctx=character();
    const hide=prepareMessageBatch(ctx,runSelection(ctx,[1,3]),{operation:'hide'});
    assert.equal(hide.changed,2);
    await commitMessageBatch(()=>ctx,hide);
    assert.equal(ctx.chat[1].is_system,true);
    assert.equal(ctx.chat[3].is_system,true);
    assert.equal(ctx.chat[0].is_system,false);
    const noop=prepareMessageBatch(ctx,runSelection(ctx,[1]),{operation:'hide'});
    assert.equal(noop.changed,0);
    const show=prepareMessageBatch(ctx,runSelection(ctx,[1,3]),{operation:'show'});
    await commitMessageBatch(()=>ctx,show);
    assert.equal(ctx.chat[1].is_system,false);
    assert.equal(ctx.chat[3].is_system,false);
});

test('Q10 metadata save rejection reverts IDs, bookmarks and metadata but not other extensions',async()=>{
    const ctx=character(),original=structuredClone(ctx.chat);
    const metadata=ctx.chatMetadata;
    ctx.saveMetadata=async()=>{throw new Error('write failed');};
    const plan=prepareMessageBatch(ctx,runSelection(ctx,[0,3]),{operation:'bookmark-add'});
    await assert.rejects(commitMessageBatch(()=>ctx,plan),/write failed/);
    assert.deepEqual(ctx.chat,original);
    assert.equal(ctx.chatMetadata,metadata);
    assert.equal(ctx.chatMetadata[DATA_KEY],undefined);
    assert.equal(ctx.chatMetadata.topic,'unchanged');
});

test('Q10 delete ZIP preparation reads server raw before any native deletion',async()=>{
    const ctx=character(),calls=[];
    ctx.saveChat=async()=>{calls.push('save');};
    ctx.deleteMessage=async()=>{calls.push('delete');};
    const sel=runSelection(ctx,[1,2]);
    const backup=await prepareDeletionBackup(()=>ctx,sel,{
        fetcher:fetcherFor(ctx,()=>calls.push('export')),
    });
    assert.deepEqual(calls,['save','export']);
    assert.ok(backup.blob.size>0);
    assert.ok(backup.hash.length===64);
    assert.ok(matchesCurrentChatSnapshot(backup.raw,ctx.chat));
});

test('Q10 mismatched server backup blocks deletion and leaves chat untouched',async()=>{
    const ctx=character(),before=structuredClone(ctx.chat);
    ctx.saveChat=async()=>{};
    let deletes=0;ctx.deleteMessage=async()=>{deletes++;};
    await assert.rejects(prepareDeletionBackup(()=>ctx,runSelection(ctx,[1]),{
        fetcher:async()=>Response.json({result:'{"chat_metadata":{}}\n{"name":"X","mes":"wrong"}\n'}),
    }),/다릅니다/);
    assert.deepEqual(ctx.chat,before);
    assert.equal(deletes,0);
});

test('Q10 native deletion highest-first preserves unrelated messages and verifies server save',async()=>{
    const ctx=character(),order=[];
    ctx.saveChat=async()=>{};
    ctx.deleteMessage=async(index,swipe,confirm,withTools)=>{
        assert.equal(swipe,undefined);
        assert.equal(confirm,false);
        assert.equal(withTools,false);
        order.push(index);ctx.chat.splice(index,1);
    };
    const sel=runSelection(ctx,[1,3]);
    const backup=await prepareDeletionBackup(()=>ctx,sel,{fetcher:fetcherFor(ctx)});
    const oldDoc=globalThis.document;
    globalThis.document={querySelector:()=>({})};
    try{
        const result=await deleteMessageSelection(()=>ctx,backup,{
            fetcher:fetcherFor(ctx),ensureRendered:async()=>true,
        });
        assert.equal(result.deleted,2);
        assert.deepEqual(order,[3,1]);
        assert.deepEqual(ctx.chat.map(x=>x.mes),['first','third']);
    }finally{
        if(oldDoc===undefined)delete globalThis.document;
        else globalThis.document=oldDoc;
    }
});

test('Q10 missing native DOM prevents all deletes before mutation',async()=>{
    const ctx=character();ctx.saveChat=async()=>{};
    let calls=0;ctx.deleteMessage=async()=>{calls++;};
    const sel=runSelection(ctx,[0,2]);
    const backup=await prepareDeletionBackup(()=>ctx,sel,{fetcher:fetcherFor(ctx)});
    const oldDoc=globalThis.document;
    globalThis.document={querySelector:()=>null};
    try{
        await assert.rejects(deleteMessageSelection(()=>ctx,backup,{
            fetcher:fetcherFor(ctx),ensureRendered:async()=>false,
        }),/#2/);
        assert.equal(calls,0);
    }finally{
        if(oldDoc===undefined)delete globalThis.document;
        else globalThis.document=oldDoc;
    }
});

test('Q10 native deletion error reports partial completion; no optimistic rollback',async()=>{
    const ctx=character();ctx.saveChat=async()=>{};
    ctx.deleteMessage=async index=>{
        if(index===1)throw new Error('native failure');
        ctx.chat.splice(index,1);
    };
    const sel=runSelection(ctx,[1,3]);
    const backup=await prepareDeletionBackup(()=>ctx,sel,{fetcher:fetcherFor(ctx)});
    const oldDoc=globalThis.document;
    globalThis.document={querySelector:()=>({})};
    try{
        await assert.rejects(deleteMessageSelection(()=>ctx,backup,{
            fetcher:fetcherFor(ctx),ensureRendered:async()=>true,
        }),/1\/2.*ZIP/);
        assert.deepEqual(ctx.chat.map(x=>x.mes),['first','second','third']);
    }finally{
        if(oldDoc===undefined)delete globalThis.document;
        else globalThis.document=oldDoc;
    }
});
