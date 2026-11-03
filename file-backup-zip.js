/**
 * Q-07A small standards-compliant ZIP (stored/no compression).
 * UTF-8 filenames, CRC32, one central directory; no npm dependency.
 * File contents are used as returned by the SillyTavern export API and
 * are never parsed, normalized or rewritten.
 */
const encoder=new TextEncoder();
const CRC_TABLE=new Uint32Array(256);
for(let n=0;n<256;n++){
    let c=n;
    for(let k=0;k<8;k++) c=(c>>>1) ^ (c&1?0xedb88320:0);
    CRC_TABLE[n]=c>>>0;
}
export function crc32(bytes) {
    let crc=0xffffffff;
    for(const byte of bytes) crc=CRC_TABLE[(crc^byte)&255] ^ (crc>>>8);
    return (crc ^ 0xffffffff)>>>0;
}
const write16=(view,at,n)=>view.setUint16(at,n,true);
const write32=(view,at,n)=>view.setUint32(at,n>>>0,true);
function entryName(input) {
    if(typeof input!=='string' || !input.endsWith('.jsonl') ||
       !input || input.length>215 || /[/\\\0\r\n]/.test(input) ||
       input.startsWith('.') || input==='..jsonl') {
        throw new Error('ZIP에 안전하게 저장할 수 없는 파일 이름입니다.');
    }
    return input;
}
export function packJsonlZip(files) {
    if(!Array.isArray(files) || !files.length || files.length>30)
        throw new Error('ZIP에는 1~30개 채팅만 담을 수 있습니다.');
    const fileList=[];
    const seen=new Set();
    let offset=0;
    let total=0;
    const body=[];
    for(const file of files){
        const filename=entryName(file?.name);
        if(seen.has(filename.toLocaleLowerCase()))throw new Error('중복된 채팅 이름이 포함되어 있습니다.');
        seen.add(filename.toLocaleLowerCase());
        if(typeof file.text!=='string')throw new Error('원본 JSONL 파일이 문자열이 아닙니다.');
        const nameBytes=encoder.encode(filename);
        const bytes=encoder.encode(file.text);
        total+=bytes.length;
        if(total>64*1024*1024)throw new Error('ZIP 원본 전체 크기가 64MB를 초과했습니다.');
        const checksum=crc32(bytes);
        const h=new Uint8Array(30+nameBytes.length);
        const v=new DataView(h.buffer);
        write32(v,0,0x04034b50);
        write16(v,4,20);write16(v,6,0x800);write16(v,8,0); // UTF-8, store
        write32(v,14,checksum);
        write32(v,18,bytes.length);write32(v,22,bytes.length);
        write16(v,26,nameBytes.length);
        h.set(nameBytes,30);
        body.push(h,bytes);
        fileList.push({offset,nameBytes,bytes,checksum});
        offset+=h.length+bytes.length;
    }
    const centralStart=offset;
    for(const file of fileList){
        const h=new Uint8Array(46+file.nameBytes.length);
        const v=new DataView(h.buffer);
        write32(v,0,0x02014b50);
        write16(v,4,20);write16(v,6,20);write16(v,8,0x800);
        write16(v,10,0);
        write32(v,16,file.checksum);
        write32(v,20,file.bytes.length);write32(v,24,file.bytes.length);
        write16(v,28,file.nameBytes.length);
        write32(v,42,file.offset);
        h.set(file.nameBytes,46);
        body.push(h);offset+=h.length;
    }
    const footer=new Uint8Array(22);
    const v=new DataView(footer.buffer);
    write32(v,0,0x06054b50);
    write16(v,8,fileList.length);write16(v,10,fileList.length);
    write32(v,12,offset-centralStart);
    write32(v,16,centralStart);
    body.push(footer);
    return new Blob(body,{type:'application/zip'});
}
