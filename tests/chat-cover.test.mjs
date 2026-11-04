import test from 'node:test';
import assert from 'node:assert/strict';
import {
    COVER_INPUT_BYTES,COVER_STORED_BYTES,COVER_MAX_ASSETS,
    COVER_REF_PREFIX,isLocalCoverRef,detectCoverMime,assertCoverInput,coverRefFor,
} from '../chat-cover-store.js';
import {emptyLibrary,chatReference,createLibraryBackup,parseLibraryBackup} from '../library-data.js';
import {changeLibrary,selectLibraryChats} from '../library-operations.js';

const png=new Uint8Array([
    0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,
    0,0,0,0,0,0,0,0,0,0,0,0,
]);
const webp=new Uint8Array([
    0x52,0x49,0x46,0x46,0x10,0,0,0,
    0x57,0x45,0x42,0x50,0,0,0,0,
]);
const jpeg=new Uint8Array([0xff,0xd8,0xff,0xe0,0,0,0,0,0,0,0,0]);
const svg=new Uint8Array([60,115,118,103,32,111,110,108,111,97,100,61]);

test('D05A cover type must match real PNG/JPEG/WebP signature, never SVG',async()=>{
    assert.equal(detectCoverMime(png),'image/png');
    assert.equal(detectCoverMime(jpeg),'image/jpeg');
    assert.equal(detectCoverMime(webp),'image/webp');
    assert.equal(detectCoverMime(svg),null);
    await assertCoverInput(new Blob([png],{type:'image/png'}));
    await assertCoverInput(new Blob([jpeg],{type:'image/jpeg'}));
    await assertCoverInput(new Blob([webp],{type:'image/webp'}));
    await assert.rejects(assertCoverInput(new Blob([svg],{type:'image/svg+xml'})),/MIME|SVG/);
    await assert.rejects(assertCoverInput(new Blob([png],{type:'image/webp'})),/MIME/);
    await assert.rejects(assertCoverInput(new Blob([new Uint8Array(COVER_INPUT_BYTES+1)],{type:'image/png'})),/3MB/);
    assert.equal(COVER_STORED_BYTES,256*1024);
    assert.equal(COVER_MAX_ASSETS,120);
});

test('D05A stable SHA-256 references and strict no-data-URL contract',async()=>{
    const blob=new Blob([png],{type:'image/png'});
    const ref=await coverRefFor(blob);
    assert.ok(ref.startsWith(COVER_REF_PREFIX));
    assert.match(ref,/^stmn-cover:[a-f0-9]{64}$/);
    assert.equal(ref,await coverRefFor(new Blob([png],{type:'image/png'})));
    assert.equal(isLocalCoverRef(ref),true);
    assert.equal(isLocalCoverRef('data:image/png;base64,...'),false);
    assert.equal(isLocalCoverRef('https://example.org/cover.png'),false);
    assert.equal(isLocalCoverRef('stmn-cover:../../evil'),false);
    assert.equal(isLocalCoverRef('stmn-cover:'+'a'.repeat(63)),false);
    assert.notEqual(ref,await coverRefFor(new Blob([new Uint8Array([...png,1])],{type:'image/png'})));
});

test('D05A cover management edits are scoped, preserve unrelated fields and never touch JSONL',async()=>{
    const scope='character:one.png';
    const src=chatReference(scope,'chat-one');
    const other=chatReference('character:two.png','chat-one');
    const ref=COVER_REF_PREFIX+'a'.repeat(64);
    const library=emptyLibrary();
    library.records[other]={
        alias:'다른 캐릭터',description:'별개',folderId:null,favorite:true,tagIds:[],
        imageRef:null,lastRead:null,customSortOrder:null,createdAt:null,createdAtSource:null,
    };
    const updated=changeLibrary(library,{kind:'chat',type:'image',reference:src,value:ref});
    assert.equal(updated.records[src].imageRef,ref);
    assert.equal(updated.records[other].imageRef,null);
    assert.equal(updated.records[other].alias,'다른 캐릭터');
    assert.equal(library.records[src],undefined);
    assert.equal(selectLibraryChats([{id:'chat-one',name:'Original'}],scope,updated)[0].imageRef,ref);
    const backup=createLibraryBackup(updated,{now:new Date('2026-11-04T00:00:00Z')});
    assert.equal(parseLibraryBackup(backup).library.records[src].imageRef,ref);
    const unlinked=changeLibrary(updated,{kind:'chat',type:'image',reference:src,value:null});
    assert.equal(unlinked.records[src].imageRef,null);
    assert.equal(updated.records[src].imageRef,ref);
    for(const value of ['data:image/png;base64,a','https://example.org/a.png',
        COVER_REF_PREFIX+'A'.repeat(64),'stmn-cover:not-a-hash',0,undefined]){
        assert.throws(()=>changeLibrary(updated,{kind:'chat',type:'image',reference:src,value}),/로컬 표지/);
    }
});

test('D05A empty covers do not add records or require network work',()=>{
    const result=selectLibraryChats([{id:'plain-chat',name:'채팅'}],
        'character:one.png',emptyLibrary());
    assert.equal(result.length,1);
    assert.equal(result[0].imageRef,null);
});
