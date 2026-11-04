import test from 'node:test';
import assert from 'node:assert/strict';
import {MESSAGE_KEY,DATA_KEY} from '../model.js';
import {
    DETAILED_SEARCH_RESPONSE_BYTES,DETAILED_SEARCH_YIELD_EVERY,
    projectDetailedChatMatches,readDetailedChatMatches,
} from '../chat-search-detail.js';
import {projectChatMatches} from '../chat-search.js';

const scope='character:hero.png';
const item={id:'chapter-a',name:'Chapter A'};
const content=[
    {chat_metadata:{[DATA_KEY]:{titles:{m1:'비밀 통로'}}}},
    {name:'Hero',mes:'일상적인 대화',swipes:['다른 결말을 생각해.','숨겨진 보물']},
    {name:'Bot',mes:'마지막 장면',swipes:['두 번째 다른 결말','마지막 장면'],
        swipe_id:1,[MESSAGE_KEY]:'m1'},
    {name:'Hero',mes:'비밀',is_system:true,swipes:['평범한 내용']},
];
const state=()=>({
    characterId:0,characters:[{avatar:'hero.png',name:'Hero'}],groupId:null,
    chatId:'other-chat',chat:[{mes:'other'}],chatMetadata:{},
    getRequestHeaders:()=>({'Content-Type':'application/json'}),
});
const raw=lines=>lines.map(x=>JSON.stringify(x)).join('\n')+'\n';
const response=lines=>Response.json({result:raw(lines)});

test('E03C exact finder locates alternate swipe #0 and a custom-title match #1',async()=>{
    const result=await projectDetailedChatMatches(content,{
        query:'다른 결말',titles:false,body:false,swipes:true,yieldEvery:2,
    });
    assert.deepEqual(result.matches.map(x=>[x.index,x.field,x.swipeIndex]),
        [[0,'swipe',0],[1,'swipe',0]]);
    assert.ok(result.matches.every(x=>x.excerpt.length<=182));
    assert.equal(result.truncated,false);
    const title=await projectDetailedChatMatches(content,{
        query:'비밀 통로',titles:true,body:false,swipes:false,
    });
    assert.deepEqual(title.matches.map(x=>[x.index,x.field]),[[1,'title']]);
    const hidden=await projectDetailedChatMatches(content,{
        query:'비밀',titles:false,body:true,swipes:false,
    });
    assert.deepEqual(hidden.matches.map(x=>x.index),[2]);
    const previous=projectChatMatches(content,{query:'다른 결말',titles:false,body:true});
    assert.deepEqual(previous,[],'E03A defaults must not index alternate swipes');
});

test('E03C reads only explicitly selected character chat via bounded export',async()=>{
    const ctx=state(),calls=[];
    const found=await readDetailedChatMatches({
        context:()=>ctx,scope,buildings:[item],item,query:'다른 결말',
        titles:false,body:false,swipes:true,
        fetcher:async(url,opts)=>{
            calls.push({url,opts});
            return response(content);
        },
    });
    assert.equal(found.id,'chapter-a');
    assert.equal(found.source,'server-jsonl');
    assert.deepEqual(found.matches.map(x=>x.index),[0,1]);
    assert.deepEqual(calls.map(x=>x.url),['/api/chats/export']);
    assert.deepEqual(JSON.parse(calls[0].opts.body),{
        is_group:false,avatar_url:'hero.png',file:'chapter-a.jsonl',
        exportfilename:'chapter-a.jsonl',format:'jsonl',
    });
    assert.equal(found.matches.some(x=>Object.hasOwn(x,'mes')||
        Object.hasOwn(x,'swipes')),false);
});

test('E03C uses current in-memory unsaved edits without requesting server files',async()=>{
    const ctx=state();
    ctx.chatId='chapter-a';ctx.chat=[...content.slice(1)];
    ctx.chat[0]={...ctx.chat[0],mes:'비밀의 기록'};
    ctx.chatMetadata=content[0].chat_metadata;
    let calls=0;
    const result=await readDetailedChatMatches({
        context:()=>ctx,scope,buildings:[item],item,
        query:'비밀',titles:false,body:true,swipes:false,
        fetcher:()=>{calls++;throw Error('network must not be called');},
    });
    assert.deepEqual(result.matches.map(x=>x.index),[0,2],
        'active unsaved text and previously present hidden-message body both match');
    assert.equal(result.source,'current-memory');
    assert.equal(calls,0);
});

test('E03C blocks out-of-scope character and missing/foreign group chats before request',async()=>{
    let calls=0;
    const fetcher=()=>{calls++;throw Error('must not fetch');};
    const ctx=state();
    await assert.rejects(readDetailedChatMatches({
        context:()=>ctx,scope:'character:another.png',buildings:[item],item,query:'비밀',
        fetcher,
    }),/변경/);
    await assert.rejects(readDetailedChatMatches({
        context:()=>ctx,scope,buildings:[item],item:{id:'not-in-list'},query:'비밀',
        fetcher,
    }),/목록/);
    for(const id of ['../escape','other/foreign','bad\\\\file']){
        await assert.rejects(readDetailedChatMatches({
            context:()=>ctx,scope,buildings:[{id}],item:{id},query:'비밀',fetcher,
        }),/안전하지/);
    }
    const group={groupId:44,groups:[{id:44,chats:['safe']},{id:55,chats:['foreign']}],
        chatId:'safe',chat:[],chatMetadata:{},getRequestHeaders:()=>({})};
    await assert.rejects(readDetailedChatMatches({
        context:()=>group,scope:'group:44',buildings:[{id:'foreign'}],
        item:{id:'foreign'},query:'비밀',fetcher,
    }),/선택된 그룹/);
    assert.equal(calls,0);
});

test('E03C verifies safe group export arguments and original exact message # indexes',async()=>{
    const ctx={groupId:44,groups:[{id:44,chats:['safe','other']}],
        chatId:'safe',chat:[],chatMetadata:{},getRequestHeaders:()=>({})};
    const result=await readDetailedChatMatches({
        context:()=>ctx,scope:'group:44',buildings:[{id:'other'}],
        item:{id:'other'},query:'숨겨진 보물',
        titles:false,body:false,swipes:true,
        fetcher:async(url,opts)=>{
            assert.equal(url,'/api/chats/export');
            assert.deepEqual(JSON.parse(opts.body),{
                is_group:true,avatar_url:null,file:'other.jsonl',
                exportfilename:'other.jsonl',format:'jsonl',
            });
            return response(content);
        },
    });
    assert.deepEqual(result.matches.map(x=>[x.index,x.swipeIndex]),[[0,1]]);
});

test('E03C rejects oversized response before reading and aborted HTTP',async()=>{
    assert.equal(DETAILED_SEARCH_RESPONSE_BYTES,32*1024*1024);
    const ctx=state();
    await assert.rejects(readDetailedChatMatches({
        context:()=>ctx,scope,buildings:[item],item,query:'비밀',
        fetcher:async()=>new Response('{}',{headers:{
            'content-length':String(DETAILED_SEARCH_RESPONSE_BYTES+1),
        }}),
    }),/제한/);
    const controller=new AbortController();controller.abort();
    let calls=0;
    await assert.rejects(readDetailedChatMatches({
        context:()=>ctx,scope,buildings:[item],item,query:'비밀',
        signal:controller.signal,
        fetcher:()=>{calls++;return response(content);},
    }),/AbortError/);
    assert.equal(calls,0);
});

test('E03C marks first 72 results as truncated and yields without retaining raw text',async()=>{
    const records=[{chat_metadata:{}},...Array.from({length:600},(_,i)=>({
        mes:'찾는 문장 '+i,swipes:['비밀스와이프 '+i],
    }))];
    const found=await projectDetailedChatMatches(records,{
        query:'비밀스와이프',titles:false,body:false,swipes:true,yieldEvery:19,
    });
    assert.equal(found.matches.length,72);
    assert.equal(found.truncated,true);
    assert.ok(found.scanned<=73);
    assert.deepEqual(found.matches.map(x=>x.index),Array.from({length:72},(_,i)=>i));
    assert.equal(found.total,600);
    assert.equal(DETAILED_SEARCH_YIELD_EVERY,256);
});

test('E03C canceled after yielding cannot display stale results',async()=>{
    const ctl=new AbortController();
    const rows=[{chat_metadata:{}},...Array.from({length:1050},(_,i)=>({mes:'needle '+i}))];
    const work=projectDetailedChatMatches(rows,{
        query:'없는값',titles:false,body:true,swipes:false,
        signal:ctl.signal,yieldEvery:2,
    });
    queueMicrotask(()=>ctl.abort());
    await assert.rejects(work,/AbortError/);
    let fresh=true;
    const work2=projectDetailedChatMatches(rows,{
        query:'없는값',titles:false,body:true,swipes:false,
        yieldEvery:2,stillValid:()=>fresh,
    });
    queueMicrotask(()=>{fresh=false;});
    await assert.rejects(work2,/AbortError/);
});

test('E03C scope change during asynchronous export discards results',async()=>{
    const ctx=state();
    await assert.rejects(readDetailedChatMatches({
        context:()=>ctx,scope,buildings:[item],item,query:'비밀',
        fetcher:async()=>{
            ctx.characterId=1;
            ctx.characters.push({name:'Different',avatar:'different.png'});
            return response(content);
        },
    }),/AbortError/);
});
