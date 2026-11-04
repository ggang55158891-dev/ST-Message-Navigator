/**
 * D-05B portable cover archive: a strictly bounded, STORED (uncompressed)
 * ZIP with manifest.json, library.json and content-addressed image assets.
 * No network access, arbitrary filesystem extraction, decompression,
 * cross-origin URLs or writes while parsing/preflighting.
 */
import {crc32} from './file-backup-zip.js';
import {
    COVER_REF_PREFIX,COVER_MAX_ASSETS,COVER_STORED_BYTES,
    isLocalCoverRef,coverRefFor,
} from './chat-cover-store.js';
import {
    MAX_LIBRARY_BACKUP_BYTES,validateLibrary,createLibraryBackup,
    parseLibraryBackup,mergeLibrary,
} from './library-data.js';

export const COVER_ARCHIVE_TYPE='stmn-cover-archive-v1';
export const COVER_ARCHIVE_MAX_BYTES=36*1024*1024;
export const COVER_MANIFEST_MAX_BYTES=64*1024;
const MAX_ZIP_ENTRIES=COVER_MAX_ASSETS+2;
const encoder=new TextEncoder();
const decoder=new TextDecoder('utf-8',{fatal:true});
const exact=(value,fields)=>value && typeof value==='object' &&
    !Array.isArray(value) &&
    Object.keys(value).length===fields.length &&
    fields.every(field=>Object.prototype.hasOwnProperty.call(value,field));
const u16=(view,pos)=>view.getUint16(pos,true);
const u32=(view,pos)=>view.getUint32(pos,true);
const set16=(view,pos,value)=>view.setUint16(pos,value,true);
const set32=(view,pos,value)=>view.setUint32(pos,value>>>0,true);
const filenameFor=(ref,mime)=>{
    if(!isLocalCoverRef(ref) || !['image/png','image/webp'].includes(mime))
        throw new Error('잘못된 표지 내용주소입니다.');
    return 'covers/'+ref.slice(COVER_REF_PREFIX.length)+
        (mime==='image/png'?'.png':'.webp');
};
function validEntryName(name){
    return name==='manifest.json'||name==='library.json'||
        /^covers\/[a-f0-9]{64}\.(?:png|webp)$/.test(name);
}
function assertZipBytes(bytes){
    if(!(bytes instanceof Uint8Array)||!bytes.length||
       bytes.byteLength>COVER_ARCHIVE_MAX_BYTES)
        throw new Error('표지 아카이브 크기가 36MB 제한을 초과했습니다.');
}

/** Pure raw ZIP serializer, no compression; entry list must be prevalidated. */
export function packCoverZip(entries){
    if(!Array.isArray(entries)||entries.length<2||
       entries.length>MAX_ZIP_ENTRIES)
        throw new Error('ZIP 이미지 항목 개수가 올바르지 않습니다.');
    const chunks=[],central=[],seen=new Set();
    let offset=0,centralBytes=0;
    for(const entry of entries){
        if(typeof entry?.name!=='string'||!validEntryName(entry.name)||
           !(entry.bytes instanceof Uint8Array) ||
           seen.has(entry.name) || seen.has(entry.name.toLowerCase()))
            throw new Error('ZIP 파일명 또는 중복된 항목이 올바르지 않습니다.');
        seen.add(entry.name.toLowerCase());
        const path=encoder.encode(entry.name),bytes=entry.bytes;
        const limit=entry.name==='manifest.json'?COVER_MANIFEST_MAX_BYTES:
            entry.name==='library.json'?MAX_LIBRARY_BACKUP_BYTES:COVER_STORED_BYTES;
        if(bytes.length>limit || bytes.length<1)
            throw new Error('ZIP 내부 파일 크기 제한을 초과했습니다.');
        const checksum=crc32(bytes);
        const local=new Uint8Array(30+path.length);
        const h=new DataView(local.buffer);
        set32(h,0,0x04034b50);set16(h,4,20);
        set16(h,6,0x800);set16(h,8,0);
        set16(h,10,0);set16(h,12,0x21);
        set32(h,14,checksum);set32(h,18,bytes.length);set32(h,22,bytes.length);
        set16(h,26,path.length);local.set(path,30);
        chunks.push(local,bytes);
        const header=new Uint8Array(46+path.length),c=new DataView(header.buffer);
        set32(c,0,0x02014b50);
        set16(c,4,20);set16(c,6,20);set16(c,8,0x800);
        set16(c,10,0);set16(c,12,0);set16(c,14,0x21);
        set32(c,16,checksum);set32(c,20,bytes.length);set32(c,24,bytes.length);
        set16(c,28,path.length);set32(c,42,offset);header.set(path,46);
        central.push(header);centralBytes+=header.length;
        offset+=local.length+bytes.length;
        if(offset+centralBytes+22>COVER_ARCHIVE_MAX_BYTES)
            throw new Error('ZIP 전체가 36MB 제한을 초과합니다.');
    }
    const end=new Uint8Array(22),v=new DataView(end.buffer);
    set32(v,0,0x06054b50);
    set16(v,8,entries.length);set16(v,10,entries.length);
    set32(v,12,centralBytes);set32(v,16,offset);
    return new Blob([...chunks,...central,end],{type:'application/zip'});
}

/**
 * Strict ZIP reader. Both local and central headers must match; rejects
 * compressed/encrypted files, descriptors, comments, ZIP64, path traversal,
 * overlapping/padded entries, duplicate keys and invalid CRCs.
 */
export function parseCoverZip(bytes){
    assertZipBytes(bytes);
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const endAt=bytes.length-22;
    if(endAt<0 || u32(view,endAt)!==0x06054b50 ||
       u16(view,endAt+4)!==0 || u16(view,endAt+6)!==0 ||
       u16(view,endAt+20)!==0)
        throw new Error('정상적인 ZIP 종료 헤더가 아닙니다.');
    const count=u16(view,endAt+10),diskCount=u16(view,endAt+8);
    const centralLen=u32(view,endAt+12),centralAt=u32(view,endAt+16);
    if(count<2||count>MAX_ZIP_ENTRIES||count!==diskCount||
       centralAt> endAt || centralLen!==endAt-centralAt)
        throw new Error('ZIP 중앙 목록의 항목 개수 또는 위치가 올바르지 않습니다.');
    const found=new Map(),ranges=[];
    let cursor=centralAt;
    for(let i=0;i<count;i++){
        if(cursor+46>endAt || u32(view,cursor)!==0x02014b50 ||
           u16(view,cursor+6)!==20 || u16(view,cursor+8)!==0x800 ||
           u16(view,cursor+10)!==0 || u32(view,cursor+20)!==u32(view,cursor+24) ||
           u16(view,cursor+30)!==0 || u16(view,cursor+32)!==0 ||
           u16(view,cursor+34)!==0 || u16(view,cursor+36)!==0 ||
           u32(view,cursor+38)!==0)
            throw new Error('ZIP은 압축되지 않은 안전한 파일만 포함해야 합니다.');
        const len=u16(view,cursor+28),fileLen=u32(view,cursor+24);
        const next=cursor+46+len,offset=u32(view,cursor+42);
        const checksum=u32(view,cursor+16);
        if(!len||next>endAt)throw new Error('ZIP 파일명 범위가 올바르지 않습니다.');
        let name;
        try{name=decoder.decode(bytes.subarray(cursor+46,next));}
        catch{throw new Error('ZIP 파일명이 UTF-8이 아닙니다.');}
        if(!validEntryName(name)||found.has(name)||fileLen<1 ||
           fileLen>(name==='manifest.json'?COVER_MANIFEST_MAX_BYTES:
               name==='library.json'?MAX_LIBRARY_BACKUP_BYTES:COVER_STORED_BYTES))
            throw new Error('ZIP 항목명·크기·중복이 잘못됐습니다.');
        const localEnd=offset+30+len;
        if(offset>=centralAt||localEnd+fileLen>centralAt ||
           u32(view,offset)!==0x04034b50 ||
           u16(view,offset+4)!==20 || u16(view,offset+6)!==0x800 ||
           u16(view,offset+8)!==0 || u16(view,offset+26)!==len ||
           u16(view,offset+28)!==0 ||
           u32(view,offset+14)!==checksum ||
           u32(view,offset+18)!==fileLen ||
           u32(view,offset+22)!==fileLen)
            throw new Error('ZIP 로컬 파일 정보와 목록이 일치하지 않습니다.');
        if(decoder.decode(bytes.subarray(offset+30,localEnd))!==name)
            throw new Error('ZIP 로컬 파일명과 목록이 다릅니다.');
        const body=bytes.subarray(localEnd,localEnd+fileLen);
        if(crc32(body)!==checksum)throw new Error('ZIP 파일 체크섬(CRC32)이 일치하지 않습니다.');
        found.set(name,body);
        ranges.push([offset,localEnd+fileLen]);
        cursor=next;
    }
    if(cursor!==endAt)throw new Error('ZIP 목록에 불필요한 데이터가 포함되어 있습니다.');
    ranges.sort((a,b)=>a[0]-b[0]);
    let position=0;
    for(const [start,end] of ranges){
        if(start!==position)throw new Error('ZIP 파일 구간이 겹치거나 숨겨진 데이터가 있습니다.');
        position=end;
    }
    if(position!==centralAt)throw new Error('ZIP 파일 데이터가 중앙 목록과 일치하지 않습니다.');
    if(!found.has('manifest.json')||!found.has('library.json'))
        throw new Error('표지 백업의 필수 목록이 누락됐습니다.');
    return found;
}
export function libraryCoverRefs(library){
    const clean=validateLibrary(library);
    return [...new Set(Object.values(clean.records).map(record=>record.imageRef)
        .filter(isLocalCoverRef))].sort();
}
const parseJson=(bytes,label)=>{
    try{return JSON.parse(decoder.decode(bytes));}
    catch{throw new Error(label+' JSON을 읽을 수 없습니다.');}
};

export async function createPortableCoverArchive(store,library,{
    now=new Date(),version='1.25.0',
}={}){
    const clean=validateLibrary(library),keys=await store.listRefs();
    const used=libraryCoverRefs(clean);
    if(used.some(ref=>!keys.includes(ref)))
        throw new Error('관리 데이터가 참조하는 로컬 표지가 이 브라우저에 없습니다. 표지를 다시 등록한 뒤 백업하세요.');
    const assets=[],zipEntries=[];
    for(const ref of keys){
        const blob=await store.get(ref);
        if(!blob || await coverRefFor(blob)!==ref)
            throw new Error('보관함에서 표지 내용을 확인하지 못했습니다.');
        const path=filenameFor(ref,blob.type);
        assets.push({ref,path,mime:blob.type,bytes:blob.size});
        zipEntries.push({name:path,bytes:new Uint8Array(await blob.arrayBuffer())});
    }
    const exportedAt=now.toISOString();
    const manifest={
        type:COVER_ARCHIVE_TYPE,schemaVersion:1,exportedAt,
        libraryFile:'library.json',assets,
    };
    const text=JSON.stringify(manifest);
    if(encoder.encode(text).length>COVER_MANIFEST_MAX_BYTES)
        throw new Error('이미지 목록이 너무 큽니다.');
    const json=createLibraryBackup(clean,{now,version});
    const blob=packCoverZip([
        {name:'manifest.json',bytes:encoder.encode(text)},
        {name:'library.json',bytes:encoder.encode(json)},
        ...zipEntries,
    ]);
    return {blob,refs:keys,used,unreferenced:keys.filter(ref=>!used.includes(ref)),
        exportedAt,filename:'stmn-covers-'+exportedAt.slice(0,10)+'.zip'};
}

export async function readPortableCoverArchive(file){
    if(!(file instanceof Blob)||file.size<60||file.size>COVER_ARCHIVE_MAX_BYTES)
        throw new Error('표지 ZIP 파일이 없거나 36MB 제한을 초과했습니다.');
    const entries=parseCoverZip(new Uint8Array(await file.arrayBuffer()));
    const manifest=parseJson(entries.get('manifest.json'),'표지 목록');
    if(!exact(manifest,['type','schemaVersion','exportedAt','libraryFile','assets']) ||
       manifest.type!==COVER_ARCHIVE_TYPE || manifest.schemaVersion!==1 ||
       manifest.libraryFile!=='library.json' ||
       typeof manifest.exportedAt!=='string' ||
       !Number.isFinite(Date.parse(manifest.exportedAt)) ||
       !Array.isArray(manifest.assets) ||
       manifest.assets.length>COVER_MAX_ASSETS ||
       manifest.assets.length!==entries.size-2)
        throw new Error('지원하지 않거나 손상된 표지 백업 형식입니다.');
    const backup=parseLibraryBackup(decoder.decode(entries.get('library.json')));
    const keys=new Set(),assets=[];
    for(const item of manifest.assets){
        if(!exact(item,['ref','path','mime','bytes']) ||
           !isLocalCoverRef(item.ref)||keys.has(item.ref) ||
           item.path!==filenameFor(item.ref,item.mime)||
           !Number.isInteger(item.bytes)||item.bytes<12 ||
           item.bytes>COVER_STORED_BYTES)
            throw new Error('표지 백업의 내용주소·파일명이 유효하지 않습니다.');
        const bytes=entries.get(item.path);
        if(!bytes||bytes.length!==item.bytes)
            throw new Error('표지 이미지가 누락되었거나 크기가 다릅니다.');
        const blob=new Blob([bytes],{type:item.mime});
        if(await coverRefFor(blob)!==item.ref)
            throw new Error('표지의 SHA-256 내용 해시가 일치하지 않습니다.');
        keys.add(item.ref);assets.push({ref:item.ref,blob});
    }
    if([...entries.keys()].some(name=>name!=='manifest.json' &&
        name!=='library.json'&&!manifest.assets.some(asset=>asset.path===name)))
        throw new Error('표지 백업에 허용하지 않는 파일이 추가됐습니다.');
    if(libraryCoverRefs(backup.library).some(ref=>!keys.has(ref)))
        throw new Error('관리 정보가 참조하는 이미지가 백업에 없습니다.');
    return {library:backup.library,assets,exportedAt:manifest.exportedAt,
        refs:[...keys].sort()};
}

/** No writes. Conflicting Library records stop before any image installation. */
export function previewCoverLibraryMerge(current,archive,{includeLibrary=false}={}){
    const base=validateLibrary(current);
    if(!includeLibrary)return {library:base,changed:false};
    const merged=mergeLibrary(base,archive.library);
    return {library:merged,changed:JSON.stringify(merged)!==JSON.stringify(base)};
}

export async function restorePortableCoverArchive(store,archive,{
    readLibrary,importLibrary,includeLibrary=false,
}={}){
    if(!archive||!Array.isArray(archive.assets)||
       typeof readLibrary!=='function')
        throw new Error('검증된 ZIP과 현재 관리 데이터가 필요합니다.');
    // Check Library compatibility before writing cover bytes, if requested.
    const checked=previewCoverLibraryMerge(readLibrary(),archive,{includeLibrary});
    if(includeLibrary&&checked.changed&&typeof importLibrary!=='function')
        throw new Error('채팅 관리 정보 복원 함수를 사용할 수 없습니다.');
    const result=await store.installVerified(archive.assets);
    let libraryChanged=false;
    if(includeLibrary&&checked.changed){
        // Race check: a concurrent Library edit is NOT overwritten.
        previewCoverLibraryMerge(readLibrary(),archive,{includeLibrary:true});
        const saved=importLibrary(archive.library);
        libraryChanged=Boolean(saved?.changed);
    }
    return {...result,libraryChanged};
}
export async function inspectCoverCleanup(store,library){
    const keys=await store.listRefs(),used=libraryCoverRefs(library);
    return {keys,used,unused:keys.filter(ref=>!used.includes(ref)),
        missing:used.filter(ref=>!keys.includes(ref))};
}
export async function executeCoverCleanup(store,readLibrary,plan){
    if(typeof readLibrary!=='function'||!plan||
       !Array.isArray(plan.keys)||!Array.isArray(plan.used)||
       !Array.isArray(plan.unused))
        throw new Error('표지 정리 계획이 없습니다.');
    const current=await inspectCoverCleanup(store,readLibrary());
    if(JSON.stringify(current.keys)!==JSON.stringify(plan.keys) ||
       JSON.stringify(current.used)!==JSON.stringify(plan.used) ||
       JSON.stringify(current.unused)!==JSON.stringify(plan.unused) ||
       current.missing.length)
        throw new Error('표지 보관함 또는 채팅 관리 정보가 변경됐습니다. 다시 점검하세요.');
    return store.deleteUnreferenced(plan.unused,plan.keys);
}
