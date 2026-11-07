import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectRuntimeCompatibility,PREFLIGHT_VERSION} from '../compatibility-preflight.js';

const fixture=()=>({
    chatId:'a-secret-file',chat:[{mes:'secret message',swipes:['secret swipe']}],
    saveMetadata(){throw Error('MUST NOT CALL');},
    saveChat(){throw Error('MUST NOT CALL');},
    getRequestHeaders(){throw Error('MUST NOT CALL');},
    deleteMessage(){throw Error('MUST NOT CALL');},
    swipe:{to(){throw Error('MUST NOT CALL');}},
    saveSettingsDebounced(){throw Error('MUST NOT CALL');},
});
const options={
    documentRef:{querySelector:selector=>selector==='#chat'?{}:null},
    indexedDBRef:{open(){throw Error('MUST NOT CALL');}},
    cryptoRef:{subtle:{digest(){throw Error('MUST NOT CALL');}}},
};

test('H01 read-only preflight finds required API shapes without invoking methods',()=>{
    const ctx=fixture();
    const result=inspectRuntimeCompatibility(()=>ctx,options);
    assert.equal(result.schemaVersion,PREFLIGHT_VERSION);
    assert.equal(result.needsAttention,0);
    assert.equal(result.ready,10);
    assert.ok(result.checks.every(x=>x.status==='ready'));
    assert.equal(ctx.chat[0].mes,'secret message');
});
test('H01 detects unavailable APIs without throwing or changing user objects',()=>{
    const ctx=fixture(),before=JSON.stringify({chat:ctx.chat,chatId:ctx.chatId});
    delete ctx.deleteMessage;
    delete ctx.swipe;
    delete ctx.saveChat;
    const result=inspectRuntimeCompatibility(()=>ctx,{
        documentRef:null,indexedDBRef:null,cryptoRef:null,
    });
    assert.equal(result.ready,4);
    assert.equal(result.needsAttention,6);
    assert.deepEqual(result.checks.filter(x=>x.status==='check').map(x=>x.id),[
        'chat_save','native_delete','swipe','browser_storage','sha256','chat_dom',
    ]);
    assert.equal(JSON.stringify({chat:ctx.chat,chatId:ctx.chatId}),before);
});
test('H01 context provider error becomes a safe capability report',()=>{
    const result=inspectRuntimeCompatibility(()=>{throw Error('my-secret-chat-path');},options);
    assert.equal(result.ready,3);
    assert.ok(result.checks.some(x=>x.id==='st_context'&&x.status==='check'));
    const serialized=JSON.stringify(result);
    for(const secret of ['my-secret-chat-path','a-secret-file','secret message','secret swipe'])
        assert.equal(serialized.includes(secret),false);
});
test('H01 no active chat is reported as a limitation, not a destructive test',()=>{
    const ctx=fixture();
    ctx.chatId='';
    const result=inspectRuntimeCompatibility(()=>ctx,options);
    assert.equal(result.checks.find(x=>x.id==='chat_view').status,'check');
    assert.equal(result.checks.find(x=>x.id==='chat_export').status,'ready');
    assert.equal(result.checks.find(x=>x.id==='metadata').status,'check');
});
