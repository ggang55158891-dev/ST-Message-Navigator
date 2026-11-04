import test from 'node:test';
import assert from 'node:assert/strict';
import {MESSAGE_KEY,DATA_KEY} from '../model.js';
import {
    SEARCH_BATCH_SIZE,SEARCH_MAX_RESULTS,SEARCH_SNIPPET_CHARS,
    normalizeSearchQuery,metadataMatches,searchExcerpt,projectChatMatches,
    readBoundedChatResponse,readChatMatches,
} from '../chat-search.js';

const scope='character:hero.png';
const item={id:'chat-a',name:'여름 이야기'};
const rows=[
    {chat_metadata:{[DATA_KEY]:{titles:{m1:'비밀의 정원'}}}},
    {name:'사용자',is_user:true,mes:'첫 번째 평범한 대화', [MESSAGE_KEY]:'m0'},
    {name:'캐릭터',is_user:false,mes:'사과와 꽃이 있는 메시지', [MESSAGE_KEY]:'m1'},
    {name:'사용자',is_user:true,mes:'끝에서 사과를 하나 더 찾았다.'},
];

test('E03A search query is strictly bounded and metadata includes description, folder, tags',()=>{
    assert.equal(normalizeSearchQuery('  사과  '),'사과');
    for(const query of ['', 'a','x'.repeat(101),'a\nb',null])assert.throws(()=>normalizeSearchQuery(query));
    const record={...item,alias:'구 별명',description:'신규 설명',folderName:'보관',
        tagNames:['중요','판타지']};
    for(const q of ['여름','별명','설명','보관','판타지'])
        assert.equal(metadataMatches(record,q),true);
    assert.equal(metadataMatches(record,'다른 채팅'),false);
    assert.equal(SEARCH_BATCH_SIZE,12);
    assert.equal(SEARCH_MAX_RESULTS,72);
});

test('E03A title and body hits use exact original zero-based indexes and tiny excerpts',()=>{
    const titleHits=projectChatMatches(rows,{query:'비밀',titles:true,body:false});
    assert.equal(titleHits.length,1);
    assert.equal(titleHits[0].index,1);
    assert.equal(titleHits[0].title,'비밀의 정원');
    assert.equal(titleHits[0].field,'title');
    const bodyHits=projectChatMatches(rows,{query:'사과',titles:false,body:true});
    assert.deepEqual(bodyHits.map(hit=>hit.index),[1,2]);
    assert.equal(bodyHits[0].field,'body');
    assert.deepEqual(projectChatMatches(rows,{query:'사과',titles:false,body:false}),[]);
    const long='앞'.repeat(500)+'검색어'+'뒤'.repeat(600);
    const excerpt=searchExcerpt(long,'검색어');
    assert.ok(excerpt.includes('검색어'));
    assert.ok(excerpt.length<=SEARCH_SNIPPET_CHARS+2);
    assert.ok(!excerpt.includes('앞'.repeat(200)),'full message must not be retained');
});

test('E03A browser-stream bounded JSON fetch supports current-character read only',async()=>{
    const calls=[];
    const ctx={
        characterId:0,characters:[{name:'Hero',avatar:'hero.png'}],groupId:null,
        getRequestHeaders:()=>({'Content-Type':'application/json'}),
    };
    const read=await readChatMatches(ctx,scope,[item],item,{
        query:'사과',titles:true,body:true,
        fetcher:async(url,init)=>{
            calls.push({url,init});
            return new Response(JSON.stringify(rows),{
                status:200,headers:{'Content-Type':'application/json'},
            });
        },
    });
    assert.deepEqual(read.matches.map(x=>x.index),[1,2]);
    assert.equal(read.id,'chat-a');
    assert.equal(calls[0].url,'/api/chats/get');
    assert.equal(JSON.parse(calls[0].init.body).file_name,'chat-a');
    assert.equal(calls[0].init.method,'POST');
    assert.equal(calls.length,1);
    assert.ok(read.matches.every(x=>x.excerpt.length<=SEARCH_SNIPPET_CHARS+2));
    assert.ok(read.matches.every(x=>!Object.hasOwn(x,'mes') && !Object.hasOwn(x,'swipes')));
});

test('E03A protects scope and avoids any unauthorized cross-character file fetch',async()=>{
    let calls=0;
    const ctx={
        characterId:0,characters:[{name:'Hero',avatar:'hero.png'}],groupId:null,
        getRequestHeaders:()=>({}),
    };
    const fetcher=()=>{calls++;throw Error('never fetch');};
    await assert.rejects(readChatMatches(ctx,'character:other.png',[item],item,
        {query:'비밀',fetcher}),/변경/);
    await assert.rejects(readChatMatches(ctx,scope,[item],{id:'missing'},
        {query:'비밀',fetcher}),/목록/);
    const controller=new AbortController();controller.abort();
    await assert.rejects(readChatMatches(ctx,scope,[item],item,
        {query:'비밀',signal:controller.signal,fetcher}),/AbortError/);
    assert.equal(calls,0);
});

test('E03A response rejects too-large stream and content length before parsing',async()=>{
    const bytes=Buffer.from(JSON.stringify(rows));
    const huge=new Response(bytes,{headers:{'Content-Length':String(bytes.length)}});
    await assert.rejects(readBoundedChatResponse(huge,{maxBytes:20}),/제한/);
    const stream=new Response(bytes,{headers:{'Content-Type':'application/json'}});
    await assert.rejects(readBoundedChatResponse(stream,{maxBytes:25}),/제한/);
    await assert.rejects(readBoundedChatResponse(new Response('{"not":"a list"}'),
        {maxBytes:300}),/배열/);
    await assert.rejects(readBoundedChatResponse(new Response('not-json'),
        {maxBytes:300}),/JSON/);
});
