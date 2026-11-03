import test from 'node:test';
import assert from 'node:assert/strict';
import {DATA_KEY,MESSAGE_KEY} from '../model.js';
import {swipeFingerprint,swipeKeys,swipeAnnotation,setSwipeAnnotation,markedSwipes,
    normalizedSwipeTags,MAX_SWIPE_TAGS} from '../swipe-marks.js';

const fixture=()=>({
    chat:[{name:'Character',mes:'첫 답변',swipes:['첫 답변','두 번째 답변','세 번째 답변'],swipe_id:0,
        swipe_info:[{send_date:1},{send_date:2},{send_date:3}]}],
    meta:{other_extension:{safe:true},[DATA_KEY]:{schema:1,titles:{},bookmarks:{}}},
});

test('Q06 swipe favorite and tags save without changing original text, order, selected swipe or other metadata',()=>{
    const {chat,meta}=fixture();
    const swipesBefore=JSON.stringify(chat[0].swipes);
    const infoBefore=JSON.stringify(chat[0].swipe_info);
    assert.equal(setSwipeAnnotation(chat,meta,0,1,{favorite:true},()=> 'swipe-msg-1'),true);
    assert.equal(chat[0][MESSAGE_KEY],'swipe-msg-1');
    assert.deepEqual(swipeAnnotation(chat[0],meta,1),{favorite:true,tags:[]});
    assert.deepEqual(swipeAnnotation(chat[0],meta,0),{favorite:false,tags:[]});
    assert.equal(setSwipeAnnotation(chat,meta,0,1,{tags:['재미','웃김','재미']}),true);
    assert.deepEqual(swipeAnnotation(chat[0],meta,1),{favorite:true,tags:['재미','웃김']});
    assert.equal(JSON.stringify(chat[0].swipes),swipesBefore);
    assert.equal(JSON.stringify(chat[0].swipe_info),infoBefore);
    assert.equal(chat[0].swipe_id,0);
    assert.equal(meta.other_extension.safe,true);
    assert.equal(setSwipeAnnotation(chat,meta,0,1,{favorite:true}),false,'unchanged metadata avoids duplicate saves');
});

test('Q06 marks track complete swipe text after reorder; changed answer does not inherit old mark',()=>{
    const {chat,meta}=fixture();
    setSwipeAnnotation(chat,meta,0,1,{favorite:true,tags:['좋음']},()=> 'id-2');
    const original=chat[0].swipes[1];
    chat[0].swipes.splice(1,1);
    chat[0].swipes.unshift(original);
    assert.deepEqual(markedSwipes(chat[0],meta).map(v=>v.favorite),[true,false,false]);
    chat[0].swipes[0]='수정된 답변';
    assert.equal(markedSwipes(chat[0],meta)[0].favorite,false);
    assert.equal(meta[DATA_KEY].swipeAnnotations['id-2'][
        swipeFingerprint(original)+':0'].favorite,true,'old mark kept without mislabelling replacement text');
});

test('Q06 duplicate exact-text swipes can be curated independently with ordinal keys',()=>{
    const {chat,meta}=fixture();
    chat[0].swipes=['같음','같음','다름'];
    assert.notEqual(swipeKeys(chat[0])[0],swipeKeys(chat[0])[1]);
    setSwipeAnnotation(chat,meta,0,1,{favorite:true},()=> 'id-duplicate');
    assert.deepEqual(markedSwipes(chat[0],meta).map(v=>v.favorite),[false,true,false]);
});

test('Q06 duplicate message IDs are split for pasted messages, preserving titles and bookmarks',()=>{
    const first={mes:'A',swipes:['X','Y'],[MESSAGE_KEY]:'shared'};
    const second={mes:'B',swipes:['X','Y'],[MESSAGE_KEY]:'shared'};
    const chat=[first,second];
    const key=swipeKeys(first)[1];
    const meta={[DATA_KEY]:{schema:1,titles:{shared:'기존 제목'},
        bookmarks:{shared:true},swipeAnnotations:{shared:{[key]:{favorite:true,tags:['기존']}}}}};
    setSwipeAnnotation(chat,meta,1,1,{tags:['새로운']},()=> 'fresh-id');
    assert.equal(first[MESSAGE_KEY],'shared');
    assert.equal(second[MESSAGE_KEY],'fresh-id');
    assert.deepEqual(meta[DATA_KEY].swipeAnnotations.shared[key].tags,['기존']);
    assert.deepEqual(meta[DATA_KEY].swipeAnnotations['fresh-id'][key].tags,['새로운']);
    assert.equal(meta[DATA_KEY].titles['fresh-id'],'기존 제목');
    assert.equal(meta[DATA_KEY].bookmarks['fresh-id'],true);
});

test('Q06 reject invalid tags, reserved IDs and unsupported patch values without altering messages',()=>{
    const {chat,meta}=fixture();
    const before=JSON.stringify({chat,meta});
    assert.throws(()=>setSwipeAnnotation(chat,meta,0,1,{tags:['나'.repeat(25)]}),/24/);
    assert.throws(()=>setSwipeAnnotation(chat,meta,0,1,{tags:['줄\n바꿈']}),/줄바꿈/);
    assert.throws(()=>setSwipeAnnotation(chat,meta,0,1,{tags:Array.from({length:MAX_SWIPE_TAGS+1},()=> 'x')}),/최대 6/);
    assert.throws(()=>setSwipeAnnotation(chat,meta,0,9,{favorite:true}),/유효한/);
    assert.throws(()=>setSwipeAnnotation(chat,meta,0,1,{favorite:'yes'}),/올바르지/);
    assert.equal(JSON.stringify({chat,meta}),before);
    assert.deepEqual(normalizedSwipeTags([' Hi ','hi','한글']),['Hi','한글']);
});

test('Q06 metadata can round-trip through JSON and retains branch-local annotations',()=>{
    const {chat,meta}=fixture();
    setSwipeAnnotation(chat,meta,0,2,{favorite:true,tags:['긴장감','후보']},()=> 'branch-message');
    const clonedChat=structuredClone(chat);
    const clonedMetadata=JSON.parse(JSON.stringify(meta));
    assert.deepEqual(swipeAnnotation(clonedChat[0],clonedMetadata,2),
        {favorite:true,tags:['긴장감','후보']});
    setSwipeAnnotation(clonedChat,clonedMetadata,0,2,{favorite:false});
    assert.equal(swipeAnnotation(chat[0],meta,2).favorite,true,'branch edits must not leak back to source');
});
