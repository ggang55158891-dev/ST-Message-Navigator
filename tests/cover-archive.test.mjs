import test from 'node:test';
import assert from 'node:assert/strict';
import {
    COVER_ARCHIVE_TYPE,COVER_ARCHIVE_MAX_BYTES,
    packCoverZip,parseCoverZip,libraryCoverRefs,
    createPortableCoverArchive,readPortableCoverArchive,
    previewCoverLibraryMerge,restorePortableCoverArchive,
    inspectCoverCleanup,executeCoverCleanup,
} from '../cover-archive.js';
import {coverRefFor,ChatCoverStore} from '../chat-cover-store.js';
import {
    emptyLibrary,emptyRecord,chatReference,createLibraryBackup,
} from '../library-data.js';
const png1=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0,0,0,0,1]);
const png2=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0,0,0,0,2]);
const blob=bytes=>new Blob([bytes],{type:'image/png'});
const example=async()=>{
    const a=await coverRefFor(blob(png1)),b=await coverRefFor(blob(png2));
    const library=emptyLibrary();
    const scope='character:hero.png';
    const ref=chatReference(scope,'chat-one');
    library.records[ref]={...emptyRecord(),alias:'해양',favorite:true,imageRef:a};
    const assets=new Map([[a,blob(png1)],[b,blob(png2)]]);
    const store={
        assets,
        async listRefs(){return [...assets.keys()].sort();},
        async get(id){return assets.get(id)||null;},
        async installVerified(items){
            let added=0;
            for(const item of items){
                if(!assets.has(item.ref)){assets.set(item.ref,item.blob);added++;}
            }
            return {added,existing:items.length-added};
        },
        async deleteUnreferenced(refs,keys){
            assert.deepEqual([...assets.keys()].sort(),keys);
            for(const id of refs)assets.delete(id);
            return {deleted:refs.length};
        },
    };
    return {a,b,library,assets,store,ref};
};
test('D05B single ZIP includes PNG bytes, portable Library and unreferenced images',async()=>{
    const fixture=await example();
    const stamp=new Date('2026-11-04T10:00:00.000Z');
    const packed=await createPortableCoverArchive(fixture.store,fixture.library,{
        now:stamp,version:'1.25.0',
    });
    assert.equal(packed.refs.length,2);
    assert.deepEqual(packed.used,[fixture.a]);
    assert.deepEqual(packed.unreferenced,[fixture.b]);
    assert.equal(packed.filename,'stmn-covers-2026-11-04.zip');
    assert.ok(packed.blob.size<COVER_ARCHIVE_MAX_BYTES);
    const parsed=await readPortableCoverArchive(packed.blob);
    assert.equal(parsed.library.records[fixture.ref].alias,'해양');
    assert.equal(parsed.library.records[fixture.ref].imageRef,fixture.a);
    assert.equal(parsed.assets.length,2);
    assert.deepEqual(parsed.refs,[fixture.a,fixture.b].sort());
    assert.equal(parsed.exportedAt,stamp.toISOString());
    const bytes=new Uint8Array(await packed.blob.arrayBuffer());
    const files=parseCoverZip(bytes);
    assert.ok(files.has('manifest.json'));
    assert.ok(files.has('library.json'));
    assert.equal(files.size,4);
    assert.equal(JSON.parse(new TextDecoder().decode(files.get('manifest.json'))).type,
        COVER_ARCHIVE_TYPE);
});
test('D05B rejects central tampering, bad CRC, traversal, compressed payload or duplicate file',async()=>{
    const fixture=await example();
    const exported=await createPortableCoverArchive(fixture.store,fixture.library);
    const original=new Uint8Array(await exported.blob.arrayBuffer());
    let copy=original.slice();
    const first=copy.indexOf(123); // opening manifest JSON body
    assert.ok(first>30);
    copy[first]^=1;
    assert.throws(()=>parseCoverZip(copy),/체크섬/);
    copy=original.slice();
    const end=new DataView(copy.buffer,copy.byteOffset,copy.byteLength);
    const eocd=copy.length-22,offset=end.getUint32(eocd+16,true);
    copy[offset+10]=8; // central compression method
    assert.throws(()=>parseCoverZip(copy),/압축/);
    copy=original.slice();copy[eocd+20]=1;
    assert.throws(()=>parseCoverZip(copy),/종료/);
    assert.throws(()=>packCoverZip([
        {name:'manifest.json',bytes:new Uint8Array([1])},
        {name:'../escape.png',bytes:new Uint8Array([1])},
    ]),/파일명/);
    assert.throws(()=>packCoverZip([
        {name:'library.json',bytes:new Uint8Array([1])},
        {name:'library.json',bytes:new Uint8Array([2])},
    ]),/중복/);
});
test('D05B validates exact SHA-256 refs even with a syntactically valid ZIP CRC',async()=>{
    const fixture=await example();
    const coverName='covers/'+fixture.a.slice('stmn-cover:'.length)+'.png';
    const rawLib=new TextEncoder().encode(createLibraryBackup(fixture.library));
    const manifest={
        type:COVER_ARCHIVE_TYPE,schemaVersion:1,
        exportedAt:'2026-11-04T10:00:00.000Z',libraryFile:'library.json',
        assets:[{ref:fixture.a,path:coverName,mime:'image/png',bytes:png2.length}],
    };
    const file=packCoverZip([
        {name:'manifest.json',bytes:new TextEncoder().encode(JSON.stringify(manifest))},
        {name:'library.json',bytes:rawLib},
        {name:coverName,bytes:png2},
    ]);
    await assert.rejects(readPortableCoverArchive(file),/SHA-256/);
});
test('D05B missing a referenced local cover blocks backup before downloading',async()=>{
    const fixture=await example();
    fixture.assets.delete(fixture.a);
    await assert.rejects(createPortableCoverArchive(fixture.store,fixture.library),
        /없습니다/);
});
test('D05B restore is additive; images only never alters Library',async()=>{
    const fixture=await example();
    const archive=await readPortableCoverArchive(
        (await createPortableCoverArchive(fixture.store,fixture.library)).blob);
    const clean=emptyLibrary(),destination=await example();
    destination.assets.clear();
    let calls=0;
    const result=await restorePortableCoverArchive(destination.store,archive,{
        readLibrary:()=>clean,importLibrary:()=>{calls++;throw Error('must not merge');},
    });
    assert.deepEqual(result,{added:2,existing:0,libraryChanged:false});
    assert.equal(destination.assets.size,2);
    assert.equal(calls,0);
    const repeated=await restorePortableCoverArchive(destination.store,archive,{
        readLibrary:()=>clean,
    });
    assert.equal(repeated.added,0);
    assert.equal(repeated.existing,2);
});
test('D05B optional management merge is conflict-safe and refuses before image writes',async()=>{
    const fixture=await example();
    const archive=await readPortableCoverArchive(
        (await createPortableCoverArchive(fixture.store,fixture.library)).blob);
    const old=emptyLibrary();
    old.records[fixture.ref]={...emptyRecord(),alias:'다른 설정',imageRef:null};
    assert.throws(()=>previewCoverLibraryMerge(old,archive,{includeLibrary:true}),/충돌/);
    const target=await example();target.assets.clear();
    let merges=0;
    await assert.rejects(restorePortableCoverArchive(target.store,archive,{
        readLibrary:()=>old,importLibrary:()=>{merges++;},
        includeLibrary:true,
    }),/충돌/);
    assert.equal(target.assets.size,0);
    assert.equal(merges,0);
    let next=emptyLibrary();
    const result=await restorePortableCoverArchive(target.store,archive,{
        readLibrary:()=>next,
        importLibrary:incoming=>{next=incoming;merges++;return {changed:true};},
        includeLibrary:true,
    });
    assert.equal(result.libraryChanged,true);
    assert.equal(result.added,2);
    assert.equal(next.records[fixture.ref].imageRef,fixture.a);
    assert.equal(merges,1);
});
test('D05B cleanup previews unreferenced keys and rejects a newly referenced image',async()=>{
    const fixture=await example();
    const plan=await inspectCoverCleanup(fixture.store,fixture.library);
    assert.deepEqual(plan.unused,[fixture.b]);
    assert.deepEqual(plan.missing,[]);
    const changed=structuredClone(fixture.library);
    changed.records[chatReference('group:42','chat-two')]={
        ...emptyRecord(),imageRef:fixture.b,
    };
    await assert.rejects(executeCoverCleanup(fixture.store,()=>changed,plan),/변경/);
    assert.equal(fixture.assets.size,2);
    const removed=await executeCoverCleanup(fixture.store,()=>fixture.library,plan);
    assert.equal(removed.deleted,1);
    assert.equal(fixture.assets.has(fixture.a),true);
    assert.equal(fixture.assets.has(fixture.b),false);
});
test('D05B cleanup never applies a stale inventory after another tab installs an image',async()=>{
    const fixture=await example(),plan=await inspectCoverCleanup(fixture.store,fixture.library);
    const c=new Uint8Array([...png2,3]),ref=await coverRefFor(blob(c));
    fixture.assets.set(ref,blob(c));
    await assert.rejects(executeCoverCleanup(fixture.store,()=>fixture.library,plan),/변경/);
    assert.equal(fixture.assets.has(fixture.b),true);
});
