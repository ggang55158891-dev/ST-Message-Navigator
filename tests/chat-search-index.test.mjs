import test from 'node:test';
import assert from 'node:assert/strict';
import {ActiveChatSearchIndex,ACTIVE_INDEX_MAX_MESSAGES,
    ACTIVE_INDEX_MAX_SOURCE_BYTES,ACTIVE_INDEX_MAX_SWIPES_PER_MESSAGE} from '../chat-search-index.js';
import {projectDetailedChatMatches} from '../chat-search-detail.js';
import {DATA_KEY,MESSAGE_KEY} from '../model.js';

const initial=()=>({
    chat:[
        {mes:'보이지 않는 숲의 이야기',swipes:['모래시계 속 답','다른 선택의 밤']},
        {mes:'다른 달빛이 새어들었다',swipes:['다른 달빛','하늘이 푸르다']},
        {mes:'아침에 일어났어',is_system:true,
            [MESSAGE_KEY]:'custom',swipes:['평범한 대답']},
    ],
    meta:{[DATA_KEY]:{titles:{custom:'푸른 인사'}}},
});
const opts=(more={})=>({
    scope:'character:hero.png',chatId:'active-a',
    titles:true,body:true,swipes:false,...more,
});
async function reference(chat,meta,options){
    return projectDetailedChatMatches([{chat_metadata:meta},...chat],options);
}
test('E03D index matches reference search exactly across title/body/hidden/swipe configurations',async()=>{
    const {chat,meta}=initial(),cache=new ActiveChatSearchIndex();
    for(const query of ['다른','푸른','밤','보이지','없는 숲','달빛','없어']){
        for(const config of [{titles:true,body:true,swipes:false},
            {titles:false,body:true,swipes:true},
            {titles:true,body:false,swipes:false},
            {titles:false,body:false,swipes:true}]){
            const actual=await cache.search(chat,meta,opts({...config,query}));
            const expected=await reference(chat,meta,{...config,query});
            assert.deepEqual(actual.matches,expected.matches,query+' '+JSON.stringify(config));
            assert.equal(actual.truncated,expected.truncated);
            assert.equal(actual.mode,'indexed');
        }
    }
});
test('E03D repeated query reuses snapshots, in-place text edit updates one entry',async()=>{
    const {chat,meta}=initial(),cache=new ActiveChatSearchIndex();
    const first=await cache.search(chat,meta,opts({query:'달빛'}));
    assert.equal(first.updated,3);assert.equal(first.reused,0);
    const second=await cache.search(chat,meta,opts({query:'달빛'}));
    assert.equal(second.updated,0);assert.equal(second.reused,3);
    chat[1].mes='전혀 새로운 빛';
    const changed=await cache.search(chat,meta,opts({query:'달빛'}));
    assert.equal(changed.updated,1);
    assert.equal(changed.reused,2);
    assert.equal(changed.matches.some(x=>x.index===1),false);
    assert.deepEqual(changed.matches,(await reference(chat,meta,{query:'달빛'})).matches);
});
test('E03D catches in-place swipe edits and user title mutation even without ST events',async()=>{
    const {chat,meta}=initial(),cache=new ActiveChatSearchIndex();
    await cache.search(chat,meta,opts({query:'평범한',swipes:true}));
    chat[2].swipes[0]='아주 특별한 인사';
    let result=await cache.search(chat,meta,opts({
        query:'특별한 인사',titles:false,body:false,swipes:true,
    }));
    assert.deepEqual(result.matches.map(x=>[x.index,x.field,x.swipeIndex]),[[2,'swipe',0]]);
    assert.equal(result.updated,1);
    meta[DATA_KEY].titles.custom='새로운 개인 제목';
    result=await cache.search(chat,meta,opts({
        query:'새로운 개인 제목',titles:true,body:false,swipes:false,
    }));
    assert.deepEqual(result.matches.map(x=>x.index),[2]);
    assert.equal(result.updated,1);
});
test('E03D insertion, deletion and reordering always recalculate actual #position',async()=>{
    const {chat,meta}=initial(),cache=new ActiveChatSearchIndex();
    await cache.search(chat,meta,opts({query:'보이지'}));
    chat.splice(0,0,{mes:'새로운 첫 메시지'});
    let result=await cache.search(chat,meta,opts({query:'보이지'}));
    assert.deepEqual(result.matches.map(x=>x.index),[1]);
    assert.equal(result.updated,4);
    chat.splice(0,1);chat.reverse();
    result=await cache.search(chat,meta,opts({query:'보이지'}));
    assert.deepEqual(result.matches.map(x=>x.index),[2]);
    assert.equal(result.updated,3);
    chat.splice(2,1);
    result=await cache.search(chat,meta,opts({query:'보이지'}));
    assert.equal(result.matches.length,0);
    assert.equal(result.updated,2);
});
test('E03D event-driven dirty marker aborts in-flight work but preserves reusable snapshots',async()=>{
    const {chat,meta}=initial(),cache=new ActiveChatSearchIndex();
    await cache.search(chat,meta,opts({query:'달빛'}));
    cache.markDirty();
    const reused=await cache.search(chat,meta,opts({query:'달빛'}));
    assert.equal(reused.updated,0);
    assert.equal(reused.reused,3);
    const large=Array.from({length:1200},(_,i)=>({mes:'다른 '+i}));
    const ctl=new AbortController();
    const task=cache.search(large,meta,opts({query:'없는검색',signal:ctl.signal}));
    queueMicrotask(()=>ctl.abort());
    await assert.rejects(task,{name:'AbortError'});
    assert.equal(cache.chat,chat,'canceled search does not replace previous validated index');
    const task2=cache.search(large,meta,opts({query:'없는검색'}));
    queueMicrotask(()=>cache.markDirty());
    await assert.rejects(task2,{name:'AbortError'});
    assert.equal(cache.chat,chat);
});
test('E03D scope and chat identity are isolated, and close clears raw references',async()=>{
    const {chat,meta}=initial(),cache=new ActiveChatSearchIndex();
    await cache.search(chat,meta,opts({query:'달빛'}));
    let result=await cache.search(chat,meta,opts({
        query:'달빛',scope:'character:other.png',
    }));
    assert.equal(result.updated,3);
    result=await cache.search(chat,meta,opts({
        query:'달빛',scope:'character:other.png',chatId:'other-chat',
    }));
    assert.equal(result.updated,3);
    cache.clear();
    assert.equal(cache.chat,null);
    assert.equal(cache.metadata,null);
    assert.equal(cache.entries.length,0);
    assert.equal(cache.bytes,0);
});
test('E03D source byte, row and swipe-count caps fall back without storing index',async()=>{
    const {chat,meta}=initial();
    const cache=new ActiveChatSearchIndex();
    assert.equal(ACTIVE_INDEX_MAX_SOURCE_BYTES,6*1024*1024);
    assert.equal(ACTIVE_INDEX_MAX_MESSAGES,20000);
    assert.equal(ACTIVE_INDEX_MAX_SWIPES_PER_MESSAGE,64);
    const oversized=[{mes:'안녕하세요',swipes:Array.from({length:65},(_,i)=>'후보'+i)}];
    let found=await cache.search(oversized,meta,opts({
        query:'후보60',swipes:true,titles:false,body:false,
    }));
    assert.equal(found.mode,'fallback');
    assert.deepEqual(found.matches.map(x=>x.index),[0]);
    assert.equal(cache.chat,null);
    const many=Array.from({length:ACTIVE_INDEX_MAX_MESSAGES+1},(_,i)=>({
        mes:i===ACTIVE_INDEX_MAX_MESSAGES?'끝났어':'그냥 이야기',
    }));
    found=await cache.search(many,meta,opts({query:'끝났어',titles:false,body:true}));
    assert.equal(found.mode,'fallback');
    assert.deepEqual(found.matches.map(x=>x.index),[ACTIVE_INDEX_MAX_MESSAGES]);
    assert.equal(cache.chat,null);
});
test('E03D no index work until explicit search and no storage/network dependency',async()=>{
    const cache=new ActiveChatSearchIndex();
    assert.equal(cache.entries.length,0);
    assert.equal(cache.chat,null);
    assert.equal(cache.bytes,0);
    const {chat,meta}=initial();
    const result=await cache.search(chat,meta,opts({query:'보이지'}));
    assert.equal(result.matches[0].index,0);
    for(const match of result.matches){
        assert.equal(Object.hasOwn(match,'mes'),false);
        assert.equal(Object.hasOwn(match,'swipes'),false);
    }
});
test('E03D unicode, mixed case, duplicate swipe grams produce no false negative',async()=>{
    const {meta}=initial(),cache=new ActiveChatSearchIndex();
    const chat=[
        {mes:'SillyTavern🙂 한국어 XYZ',swipes:['대문자 HELLO','한글💗문자']},
        {mes:'世界こんにちはİstanbul',swipes:['독립적인 문자열']},
        {mes:'한글 가나다라마바사',swipes:[]},
    ];
    for(const query of ['silly','한국','XYZ','hello','한글','한글💗',
        '世界','İs','가나','바하','독립']){
        for(const config of [
            {titles:true,body:true,swipes:false},
            {titles:false,body:false,swipes:true},
            {titles:true,body:true,swipes:true},
        ]){
            const options=opts({...config,query});
            const actual=await cache.search(chat,meta,options);
            const expected=await reference(chat,meta,options);
            assert.deepEqual(actual.matches,expected.matches,query);
        }
    }
});
