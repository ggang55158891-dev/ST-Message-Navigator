import test from 'node:test';
import assert from 'node:assert/strict';
import {packJsonlZip,crc32} from '../file-backup-zip.js';
import {exportSelectedChats,validateBackupSelection,MAX_BACKUP_CHATS} from '../file-backup.js';

const scope='character:hero.png';
const char={
    chatId:'current',chat:[],characterId:0,groupId:null,
    characters:[{name:'Hero',avatar:'hero.png'}],
    groups:[],
    getRequestHeaders:()=>({'Content-Type':'application/json','X-CSRF-Token':'safe'}),
    saveChat:async()=>true,
};
const buildings=[{id:'current',name:'현재'},{id:'other',name:'다른 채팅'}];

test('Q07A ZIP store has correct UTF-8 filenames, raw JSONL and CRC32',async()=>{
    const raw='{"type":"header"}\n{"mes":"안녕"}\r\n';
    const zip=packJsonlZip([{name:'라쟉 이야기.jsonl',text:raw}]);
    const bytes=new Uint8Array(await zip.arrayBuffer());
    const view=new DataView(bytes.buffer);
    assert.equal(view.getUint32(0,true),0x04034b50);
    assert.equal(view.getUint16(6,true),0x800);
    const nameLength=view.getUint16(26,true);
    const name=new TextDecoder().decode(bytes.slice(30,30+nameLength));
    assert.equal(name,'라쟉 이야기.jsonl');
    const start=30+nameLength;
    const content=new TextDecoder().decode(bytes.slice(start,start+new TextEncoder().encode(raw).length));
    assert.equal(content,raw);
    assert.equal(view.getUint32(14,true),crc32(new TextEncoder().encode(raw)));
    const end=bytes.length-22;
    assert.equal(view.getUint32(end,true),0x06054b50);
    assert.equal(view.getUint16(end+10,true),1);
    assert.ok(view.getUint32(end+16,true)>30);
    assert.throws(()=>packJsonlZip([{name:'../unsafe.jsonl',text:'x'}]),/파일 이름/);
    assert.throws(()=>packJsonlZip([{name:'a.jsonl',text:'x'},{name:'A.jsonl',text:'y'}]),/중복/);
});

test('Q07A validates scope, current listing, group membership and batch cap',()=>{
    assert.deepEqual(validateBackupSelection(char,scope,buildings,['other']).ids,['other']);
    assert.throws(()=>validateBackupSelection(char,scope,buildings,['../bad']),/목록/);
    assert.throws(()=>validateBackupSelection(char,'character:other.png',buildings,['other']),/범위/);
    assert.throws(()=>validateBackupSelection(char,scope,buildings,['other','other']),/중복/);
    assert.throws(()=>validateBackupSelection(char,scope,buildings,[]),/선택/);
    const group={...char,groupId:42,groups:[{id:42,chats:['current']}]};
    assert.throws(()=>validateBackupSelection(group,'group:42',buildings,['other']),/소속되지/);
    assert.equal(validateBackupSelection(group,'group:42',buildings,['current']).isGroup,true);
    assert.equal(MAX_BACKUP_CHATS,20);
});

test('Q07A exports two files using official read-only endpoint without mutating chat',async()=>{
    const chatBefore=structuredClone(char.chat);
    const payloads=[];
    let currentSaves=0;
    const ctx={...char,saveChat:async()=>{currentSaves++;return true;}};
    const raw='{"chat_metadata":{}}\n{"mes":"본문"}\n';
    const res=await exportSelectedChats({
        context:()=>ctx,scope,buildings,ids:['current','other'],
        fetcher:async(path,opts)=>{
            assert.equal(path,'/api/chats/export');
            assert.equal(opts.method,'POST');
            payloads.push(JSON.parse(opts.body));
            return {ok:true,json:async()=>({result:raw})};
        },
    });
    assert.equal(res.count,2);
    assert.equal(currentSaves,1,'current chat must save through ST before snapshot');
    assert.deepEqual(payloads.map(x=>x.file),['current.jsonl','other.jsonl']);
    assert.ok(payloads.every(x=>x.format==='jsonl'&&x.is_group===false&&x.avatar_url==='hero.png'));
    assert.ok(res.blob.size>raw.length*2);
    assert.deepEqual(char.chat,chatBefore);
});

test('Q07A group export uses group scope, never character avatar',async()=>{
    const ctx={...char,chatId:'other',groupId:42,groups:[{id:42,chats:['other']}]};
    let called=false;
    await exportSelectedChats({
        context:()=>ctx,scope:'group:42',buildings,ids:['other'],
        fetcher:async(_path,opts)=>{
            called=true;
            assert.deepEqual(JSON.parse(opts.body),{
                is_group:true,avatar_url:null,file:'other.jsonl',
                exportfilename:'other.jsonl',format:'jsonl',
            });
            return {ok:true,json:async()=>({result:'{"mes":"hi"}\n'})};
        },
    });
    assert.equal(called,true);
});

test('Q07A partial/failed export never calls browser download, rejects scope switching',async()=>{
    let now={...char};
    const req=()=>({ok:true,json:async()=>({result:'{"mes":"abc"}\n'})});
    await assert.rejects(()=>exportSelectedChats({
        context:()=>now,scope,buildings,ids:['current','other'],
        fetcher:async()=>{now={...now,chatId:'new'};return req();},
    }),/변경/);
    await assert.rejects(()=>exportSelectedChats({
        context:()=>char,scope,buildings,ids:['other'],
        fetcher:async()=>({ok:false,status:404}),
    }),/404/);
    await assert.rejects(()=>exportSelectedChats({
        context:()=>char,scope,buildings,ids:['other'],
        fetcher:async()=>({ok:true,json:async()=>({result:''})}),
    }),/원본/);
});
