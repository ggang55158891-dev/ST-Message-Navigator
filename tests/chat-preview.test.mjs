import test from 'node:test';
import assert from 'node:assert/strict';
import {DATA_KEY,MESSAGE_KEY} from '../model.js';
import {projectChatPreview,validateChatPreviewTarget,readChatPreview,
    ChatPreviewCache,CHAT_PREVIEW_EXCERPT,CHAT_PREVIEW_ROW_HEIGHT} from '../chat-preview.js';

const scope='character:hero.png';
const ctx={
    characterId:0,chatId:'current',
    characters:[{name:'Hero',avatar:'hero.png'}],
    groups:[],groupId:null,
    getRequestHeaders(){return {'Content-Type':'application/json','X-CSRF-Token':'safe'};},
};
const buildings=[{id:'current',name:'Current'},{id:'another',name:'Another'}];

test('character chat preview parses JSONL header, custom titles and last five in numeric order',()=>{
    const raw=[{chat_metadata:{[DATA_KEY]:{schema:1,titles:{message_2:'두 번째 장면'}}}}];
    for(let i=0;i<15;i++)raw.push({
        name:i%2?'Character':'User',is_user:i%2===0,
        mes:'내용 '+i+' '+(i===14?'끝'.repeat(800):'가'.repeat(100)),
        ...(i===2?{[MESSAGE_KEY]:'message_2'}:{}),
    });
    const before=JSON.stringify(raw);
    const p=projectChatPreview(raw);
    assert.equal(p.messageCount,15);
    assert.equal(p.entries[2].title,'두 번째 장면');
    assert.deepEqual(p.lastFive.map(x=>x.index),[10,11,12,13,14]);
    assert.equal(p.excerpt.length,CHAT_PREVIEW_EXCERPT+1);
    assert.equal(p.excerpt.endsWith('…'),true);
    assert.equal(JSON.stringify(raw),before,'preview never mutates original messages');
    assert.equal(CHAT_PREVIEW_ROW_HEIGHT,43);
    assert.equal(projectChatPreview([{chat_metadata:{}},{mes:'x'}]).messageCount,1);
    assert.equal(projectChatPreview([]).messageCount,0);
    assert.throws(()=>projectChatPreview({error:true}),/형식/);
});

test('character chat fetch uses read-only canonical endpoint and never switches current chat',async()=>{
    let request=null;
    const fetcher=async (url,opts)=>{
        request={url,opts};
        return {ok:true,json:async()=>[{chat_metadata:{}},{mes:'첫 문장.'},{mes:'마지막 문장.'}]};
    };
    const preview=await readChatPreview(ctx,scope,buildings,buildings[1],{fetcher});
    assert.equal(preview.entries.length,2);
    assert.equal(preview.excerpt,'마지막 문장.');
    assert.equal(request.url,'/api/chats/get');
    assert.deepEqual(JSON.parse(request.opts.body),{
        file_name:'another',avatar_url:'hero.png',ch_name:'Hero',
    });
    assert.equal(request.opts.method,'POST');
    assert.equal(request.opts.cache,'no-store');
    assert.equal(ctx.chatId,'current');
});

test('group endpoint validates membership of chosen group; same ID in other scope cannot leak',async()=>{
    const group={
        ...ctx,groupId:77,groups:[{id:77,chats:['current','another']},{id:88,chats:['foreign']}],
    };
    const targets=[{id:'current',name:'Current'},{id:'another',name:'Another'}, {id:'foreign',name:'Foreign'}];
    const expected=validateChatPreviewTarget(group,'group:77',targets,{id:'another'});
    assert.equal(expected.endpoint,'/api/chats/group/get');
    assert.deepEqual(expected.body,{id:'another'});
    assert.throws(()=>validateChatPreviewTarget(group,'group:77',targets,{id:'foreign'}),/선택된 그룹/);
    assert.throws(()=>validateChatPreviewTarget(ctx,scope,buildings,{id:'not-in-list'}),/현재 채팅 목록/);
    assert.throws(()=>validateChatPreviewTarget(group,scope,targets,{id:'another'}),/변경/);
    assert.throws(()=>validateChatPreviewTarget(group,'group:77',targets,{id:'../bad'}),/채팅 목록/);
});

test('same endpoint read failures or unexpected responses show errors, never delete file',async()=>{
    await assert.rejects(()=>readChatPreview(ctx,scope,buildings,buildings[1],{
        fetcher:async()=>({ok:false,status:503}),
    }),/503/);
    await assert.rejects(()=>readChatPreview(ctx,scope,buildings,buildings[1],{
        fetcher:async()=>({ok:true,json:async()=>({})}),
    }),/파일/);
});

test('small LRU cache expires, evicts, and stores only projected content',()=>{
    let clock=0;
    const cache=new ChatPreviewCache(100,2,()=>clock);
    cache.set('a',{entries:[{index:0,title:'A'}]});
    cache.set('b',{entries:[{index:0,title:'B'}]});
    assert.equal(cache.get('a').entries[0].title,'A');
    cache.set('c',{entries:[{index:0,title:'C'}]});
    assert.equal(cache.get('b'),null);
    clock=101;
    assert.equal(cache.get('a'),null);
    assert.equal(cache.get('c'),null);
    assert.equal(cache.data.size,0);
});
