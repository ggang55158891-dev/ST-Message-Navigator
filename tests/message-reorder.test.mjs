import test from 'node:test';
import assert from 'node:assert/strict';
import {
    captureReorderSource,verifyReorderSource,validateReorderOrder,
    moveReorderItem,reorderedCount,serverMatchesReorderedBackup,
    prepareReorderBackup,applyReorder,
} from '../message-reorder.js';
import {DATA_KEY,MESSAGE_KEY} from '../model.js';

function fixture(){
    const chat=[
        {name:'User',is_user:true,is_system:false,mes:'첫째',extra:{thirdParty:'keep'}},
        {name:'Bot',is_user:false,is_system:false,mes:'둘째',swipes:['A','B','C'],
            swipe_id:2,[MESSAGE_KEY]:'stable-b',extra:{file:'attachment'}},
        {name:'Bot',is_user:false,is_system:true,mes:'셋째',swipes:['원본'],swipe_id:0},
        {name:'User',is_user:true,is_system:false,mes:'넷째'},
    ];
    const metadata={
        [DATA_KEY]:{schema:1,titles:{'stable-b':'두 번째 메시지 제목'},
            bookmarks:{'stable-b':true},
            swipeAnnotations:{'stable-b':{'key':{favorite:true,tags:['keep']}}}},
        lastInContextMessageId:2,external:{setting:'preserve'},
    };
    const ctx={
        chatId:'chat-A',characterId:0,groupId:null,
        characters:[{avatar:'hero.png',name:'Hero'}],groups:[],
        chat,chatMetadata:metadata,
        getRequestHeaders:()=>({'Content-Type':'application/json'}),
        saveChat:async()=>undefined,
        reloadCurrentChat:async()=>undefined,
    };
    return ctx;
}
function raw(ctx){
    return JSON.stringify({chat_metadata:ctx.chatMetadata})+'\n'+
        ctx.chat.map(m=>JSON.stringify(m)).join('\n')+'\n';
}
function server(ctx){
    let data=raw(ctx);
    let writes=0,reads=0,reloads=0;
    const fetcher=async(path,opts)=>{
        assert.equal(path,'/api/chats/export');
        assert.equal(JSON.parse(opts.body).file,'chat-A.jsonl');
        reads++;
        return Response.json({result:data});
    };
    ctx.saveChat=async()=>{data=raw(ctx);writes++;};
    ctx.reloadCurrentChat=async()=>{reloads++;};
    return {fetcher,get data(){return data;},set data(x){data=x;},
        get writes(){return writes;},get reads(){return reads;},
        get reloads(){return reloads;}};
}

test('Q11 move is pure permutation, supports edge and long-distance movement',()=>{
    const initial=[0,1,2,3,4],copy=initial.slice();
    assert.deepEqual(moveReorderItem(initial,0,3),[1,2,3,0,4]);
    assert.deepEqual(moveReorderItem(initial,4,0),[4,0,1,2,3]);
    assert.deepEqual(moveReorderItem(initial,2,2),initial);
    assert.deepEqual(initial,copy);
    assert.equal(reorderedCount([0,1,2,3]),0);
    assert.equal(reorderedCount([1,2,0,3]),3);
    for(const order of [[0,0,2],[0,1],[0,1,5],[-1,1,2],[0,1,2.5]]){
        assert.throws(()=>validateReorderOrder(order,3),/중복|올바르/);
    }
});

test('Q11 capture detects scope/chat/list identity changes before any writes',()=>{
    const ctx=fixture(),source=captureReorderSource(ctx);
    assert.deepEqual(source.messages.map(x=>x.mes),['첫째','둘째','셋째','넷째']);
    ctx.chat[1]={...ctx.chat[1]};
    assert.throws(()=>verifyReorderSource(ctx,source),/바뀌었/);
    ctx.chat[1]=source.messages[1];
    ctx.chatId='another-chat';
    assert.throws(()=>verifyReorderSource(ctx,source),/바뀌었/);
});

test('Q11 preview and ZIP backup do not move any live messages',async()=>{
    const ctx=fixture(),api=server(ctx),original=ctx.chat.slice(),meta=structuredClone(ctx.chatMetadata);
    const source=captureReorderSource(ctx);
    const preview=moveReorderItem([0,1,2,3],1,3);
    const result=await prepareReorderBackup(()=>ctx,source,{fetcher:api.fetcher});
    assert.equal(result.hash.length,64);
    assert.ok(result.blob.size>0);
    assert.deepEqual(ctx.chat,original);
    assert.deepEqual(ctx.chatMetadata,meta);
    assert.equal(api.writes,1,'flush before snapshot');
    assert.equal(api.reads,1);
    assert.equal(api.reloads,0);
    assert.deepEqual(preview,[0,2,3,1]);
});

test('Q11 explicit commit preserves message objects, speaker, swipes and custom title IDs',async()=>{
    const ctx=fixture(),api=server(ctx);
    const chatRef=ctx.chat,source=captureReorderSource(ctx);
    const objects=ctx.chat.slice(),oldMeta=structuredClone(ctx.chatMetadata);
    const backup=await prepareReorderBackup(()=>ctx,source,{fetcher:api.fetcher});
    const order=[0,2,3,1];
    const result=await applyReorder(()=>ctx,backup,order,{fetcher:api.fetcher});
    assert.deepEqual(result,{changed:true,reloaded:true,count:4});
    assert.equal(ctx.chat,chatRef,'same native ST chat reference');
    assert.deepEqual(ctx.chat,[objects[0],objects[2],objects[3],objects[1]]);
    assert.equal(ctx.chat[3][MESSAGE_KEY],'stable-b');
    assert.deepEqual(ctx.chat[3].swipes,['A','B','C']);
    assert.equal(ctx.chat[3].swipe_id,2);
    assert.equal(ctx.chat[3].extra.file,'attachment');
    assert.deepEqual(ctx.chatMetadata[DATA_KEY],oldMeta[DATA_KEY]);
    assert.equal(ctx.chatMetadata.lastInContextMessageId,2);
    assert.deepEqual(ctx.chatMetadata.external,{setting:'preserve'});
    assert.equal(ctx.chatMetadata.tainted,true);
    assert.equal(api.writes,2,'one flush before backup, one commit save');
    assert.equal(api.reads,3,'backup, pre-commit recheck, post-commit verification');
    assert.equal(api.reloads,1);
    assert.equal(serverMatchesReorderedBackup(backup.raw,api.data,order),true);
    assert.equal(serverMatchesReorderedBackup(backup.raw,api.data,[0,1,2,3]),false);
});

test('Q11 server conflict after preview blocks commit before mutation',async()=>{
    const ctx=fixture(),api=server(ctx);
    const source=captureReorderSource(ctx);
    const backup=await prepareReorderBackup(()=>ctx,source,{fetcher:api.fetcher});
    const old=ctx.chat.slice();
    api.data=api.data.replace('첫째','외부 수정');
    await assert.rejects(applyReorder(()=>ctx,backup,[1,0,2,3],
        {fetcher:api.fetcher}),/변경/);
    assert.deepEqual(ctx.chat,old);
    assert.equal(api.writes,1);
    assert.equal(api.reloads,0);
});

test('Q11 native save silently failing never reports success and leaves ZIP intact',async()=>{
    const ctx=fixture(),api=server(ctx);
    const source=captureReorderSource(ctx);
    const backup=await prepareReorderBackup(()=>ctx,source,{fetcher:api.fetcher});
    const before=ctx.chat.slice();
    ctx.saveChat=async()=>undefined; // ST can swallow a failed network save
    await assert.rejects(applyReorder(()=>ctx,backup,[1,0,2,3],
        {fetcher:api.fetcher}),/확정할 수 없습니다/);
    assert.equal(api.reloads,0);
    assert.deepEqual(ctx.chat,[before[1],before[0],before[2],before[3]],
        'uncertain post-write state is not overwritten by an unsafe rollback');
    assert.ok(backup.blob.size>0);
});

test('Q11 verified save + native reload failure reports saved state separately',async()=>{
    const ctx=fixture(),api=server(ctx);
    const backup=await prepareReorderBackup(()=>ctx,captureReorderSource(ctx),{fetcher:api.fetcher});
    ctx.reloadCurrentChat=async()=>{throw Error('render unavailable');};
    const result=await applyReorder(()=>ctx,backup,[1,0,2,3],{fetcher:api.fetcher});
    assert.equal(result.changed,true);
    assert.equal(result.reloaded,false);
    assert.match(result.warning,/render unavailable/);
});

test('Q11 no-op order does not require server writes or native reload',async()=>{
    const ctx=fixture();
    const source=captureReorderSource(ctx);
    const result=await applyReorder(()=>ctx,{source,raw:'unused',hash:'hash'},[0,1,2,3]);
    assert.deepEqual(result,{changed:false,reloaded:false});
});

test('Q11 cannot commit duplicate or missing messages with a verified backup',async()=>{
    const ctx=fixture(),api=server(ctx);
    const backup=await prepareReorderBackup(()=>ctx,captureReorderSource(ctx),{fetcher:api.fetcher});
    await assert.rejects(applyReorder(()=>ctx,backup,[0,0,2,3],
        {fetcher:api.fetcher}),/누락|중복/);
    assert.equal(api.writes,1);
});

test('Q11 server readback also refuses lost title/bookmark or third-party metadata',()=>{
    const ctx=fixture(),original=raw(ctx);
    const swapped=[ctx.chat[1],ctx.chat[0],ctx.chat[2],ctx.chat[3]];
    const modified=structuredClone(ctx.chatMetadata);
    modified[DATA_KEY].bookmarks={};
    modified.tainted=true;
    const after=JSON.stringify({chat_metadata:modified})+'\n'+
        swapped.map(m=>JSON.stringify(m)).join('\n')+'\n';
    assert.equal(serverMatchesReorderedBackup(original,after,[1,0,2,3]),false);
});

test('Q11 content-based readback rejects swaps that lost a swipe or custom ID',()=>{
    const ctx=fixture(),original=raw(ctx);
    const rearranged=[ctx.chat[1],ctx.chat[0],ctx.chat[2],ctx.chat[3]];
    const metadata=JSON.stringify({chat_metadata:ctx.chatMetadata});
    const valid=metadata+'\n'+rearranged.map(JSON.stringify).join('\n')+'\n';
    assert.equal(serverMatchesReorderedBackup(original,valid,[1,0,2,3]),true);
    rearranged[0]={...rearranged[0],swipes:['A','B']};
    const broken=metadata+'\n'+rearranged.map(JSON.stringify).join('\n')+'\n';
    assert.equal(serverMatchesReorderedBackup(original,broken,[1,0,2,3]),false);
});
