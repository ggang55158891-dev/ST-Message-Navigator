/**
 * D-05A optional local chat cover storage.
 *
 * Cover bytes live in a small, origin-local IndexedDB, never in chat JSONL,
 * extensionSettings, or a remote URL. Library records store only a SHA-256
 * content address. No silent network requests, migrations or auto-cleanups.
 *
 * The Library JSON backup contains REFERENCES, not IndexedDB image bytes.
 * Use each cover's explicit image export before clearing browser storage.
 */
export const COVER_DB='stmn-chat-cover-v1';
export const COVER_REF_PREFIX='stmn-cover:';
export const COVER_INPUT_BYTES=3*1024*1024;
export const COVER_STORED_BYTES=256*1024;
export const COVER_MAX_ASSETS=120;
export const COVER_MAX_DIMENSION=320;
export const COVER_MAX_CACHE_URLS=32;

const request=(r)=>new Promise((resolve,reject)=>{
    r.onsuccess=()=>resolve(r.result);
    r.onerror=()=>reject(r.error||new Error('표지 이미지 보관함 접근에 실패했습니다.'));
});
const complete=(tx)=>new Promise((resolve,reject)=>{
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error||new Error('표지 이미지 저장에 실패했습니다.'));
    tx.onabort=()=>reject(tx.error||new Error('표지 이미지 저장이 취소됐습니다.'));
});
export const isLocalCoverRef=ref=>typeof ref==='string' &&
    /^stmn-cover:[a-f0-9]{64}$/.test(ref);

export function detectCoverMime(bytes){
    if(!(bytes instanceof Uint8Array) || bytes.length<12)return null;
    if(bytes[0]===0x89 && bytes[1]===0x50 && bytes[2]===0x4e &&
       bytes[3]===0x47 && bytes[4]===0x0d && bytes[5]===0x0a &&
       bytes[6]===0x1a && bytes[7]===0x0a)return 'image/png';
    if(bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff)
        return 'image/jpeg';
    if(String.fromCharCode(...bytes.slice(0,4))==='RIFF' &&
       String.fromCharCode(...bytes.slice(8,12))==='WEBP')
        return 'image/webp';
    return null;
}
export async function assertCoverInput(file){
    if(!(file instanceof Blob) || file.size<12 || file.size>COVER_INPUT_BYTES)
        throw new Error('표지는 3MB 이하의 PNG·JPEG·WebP 파일만 사용할 수 있습니다.');
    const head=new Uint8Array(await file.slice(0,24).arrayBuffer());
    const detected=detectCoverMime(head);
    if(!detected || detected!==file.type)
        throw new Error('이미지의 실제 형식과 MIME이 일치하지 않습니다. SVG·GIF는 지원하지 않습니다.');
    return detected;
}
async function digestOf(blob){
    if(!globalThis.crypto?.subtle?.digest)
        throw new Error('SHA-256을 지원하는 보안 연결에서만 표지를 저장할 수 있습니다.');
    const bytes=await blob.arrayBuffer();
    const result=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
    return Array.from(result,b=>b.toString(16).padStart(2,'0')).join('');
}
export async function normalizeCover(file){
    await assertCoverInput(file);
    if(typeof createImageBitmap!=='function')
        throw new Error('이 브라우저는 이미지 변환을 지원하지 않습니다.');
    let bitmap;
    try {bitmap=await createImageBitmap(file);}
    catch {throw new Error('이미지를 디코딩하지 못했습니다. 파일을 확인하세요.');}
    try{
        const {width,height}=bitmap;
        if(!width || !height || width>8192 || height>8192 ||
           width*height>24_000_000)
            throw new Error('이미지 해상도가 너무 큽니다. 8192px·2400만 화소 이하만 지원합니다.');
        // Exact pre-exported cover files should be reusable without another
        // lossy encoding so copied Library references can be restored by
        // uploading the same .webp/.png cover export.
        if(file.size<=COVER_STORED_BYTES &&
           width<=COVER_MAX_DIMENSION && height<=COVER_MAX_DIMENSION &&
           (file.type==='image/webp' || file.type==='image/png'))
            return new Blob([file],{type:file.type});
        const scale=Math.min(1,COVER_MAX_DIMENSION/Math.max(width,height));
        const canvas=document.createElement('canvas');
        canvas.width=Math.max(1,Math.round(width*scale));
        canvas.height=Math.max(1,Math.round(height*scale));
        const ctx=canvas.getContext('2d');
        if(!ctx)throw new Error('이미지 편집 캔버스를 사용할 수 없습니다.');
        ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',0.78));
        // Some browsers don't encode WebP; refuse instead of storing a large
        // implicit PNG or unexpected mime.
        if(!(blob instanceof Blob) || blob.type!=='image/webp' ||
           blob.size<12 || blob.size>COVER_STORED_BYTES)
            throw new Error('256KB 이하 WebP 표지로 변환하지 못했습니다.');
        return blob;
    }finally{bitmap.close();}
}
export async function coverRefFor(blob){
    if(!(blob instanceof Blob) || blob.size<12 || blob.size>COVER_STORED_BYTES ||
       !['image/png','image/webp'].includes(blob.type))
        throw new Error('저장할 표지 이미지가 유효하지 않습니다.');
    await assertCoverInput(blob);
    return COVER_REF_PREFIX+await digestOf(blob);
}
export class ChatCoverStore{
    constructor({openDb=null}={}){
        this.openDb=openDb;
        this.urls=new Map();
    }
    async open(){
        if(this.openDb)return this.openDb();
        if(!globalThis.indexedDB)
            throw new Error('이 브라우저는 IndexedDB를 지원하지 않아 표지를 저장할 수 없습니다.');
        const req=indexedDB.open(COVER_DB,1);
        req.onupgradeneeded=()=>{
            const db=req.result;
            if(!db.objectStoreNames.contains('covers'))db.createObjectStore('covers');
        };
        return request(req);
    }
    async get(ref){
        if(!isLocalCoverRef(ref))return null;
        const db=await this.open();
        let record;
        try{
            const tx=db.transaction('covers','readonly');
            record=await request(tx.objectStore('covers').get(ref));
        }finally{db.close();}
        if(!record)return null;
        if(!(record.blob instanceof Blob) || record.blob.size!==record.bytes ||
           record.blob.size>COVER_STORED_BYTES || record.blob.type!==record.mime ||
           COVER_REF_PREFIX+await digestOf(record.blob)!==ref)
            throw new Error('표지 이미지 보관함의 데이터가 손상됐습니다.');
        return record.blob;
    }
    async put(file){
        const blob=await normalizeCover(file);
        const ref=await coverRefFor(blob);
        if(await this.get(ref))return ref;
        const db=await this.open();
        try{
            const tx=db.transaction('covers','readwrite'),finished=complete(tx);
            const store=tx.objectStore('covers');
            const size=await request(store.count());
            if(size>=COVER_MAX_ASSETS){
                tx.abort();await finished.catch(()=>{});
                throw new Error('표지 보관함의 120개 이미지 제한에 도달했습니다. 이미지를 먼저 백업해 주세요.');
            }
            // add, not put: never replace a previously stored content digest.
            store.add({blob,bytes:blob.size,mime:blob.type,createdAt:Date.now()},ref);
            await finished;
        }finally{db.close();}
        const verified=await this.get(ref);
        if(!verified)throw new Error('표지 저장 후 재조회 검증에 실패했습니다.');
        return ref;
    }
    async preview(img,ref){
        if(!isLocalCoverRef(ref))return false;
        let cached=this.urls.get(ref);
        if(!cached){
            const blob=await this.get(ref);
            if(!blob)return false;
            cached=URL.createObjectURL(blob);
            this.urls.set(ref,cached);
            while(this.urls.size>COVER_MAX_CACHE_URLS){
                const oldest=this.urls.keys().next().value;
                URL.revokeObjectURL(this.urls.get(oldest));
                this.urls.delete(oldest);
            }
        }
        if(!img.isConnected || img.dataset.coverRef!==ref)return false;
        img.src=cached;
        img.hidden=false;
        return true;
    }
    mountPreview(img,ref){
        if(!isLocalCoverRef(ref))return;
        img.dataset.coverRef=ref;
        img.hidden=true;
        // The card is assembled in a detached DocumentFragment. Defer the
        // first preview until after the parent appends that fragment.
        queueMicrotask(()=>void this.preview(img,ref).catch(()=>{
            if(img.isConnected && img.dataset.coverRef===ref){
                img.hidden=true;
                img.title='이 브라우저에 표지 이미지가 없습니다. 이미지를 다시 등록해 주세요.';
            }
        }));
    }
    async export(ref){
        const blob=await this.get(ref);
        if(!blob)throw new Error('표지 이미지 파일이 이 브라우저에 없습니다.');
        return {blob,filename:'stmn-cover-'+ref.slice(COVER_REF_PREFIX.length,28)+
            (blob.type==='image/png'?'.png':'.webp')};
    }
    /** List only, never deletes or loads image bodies. */
    async listRefs(){
        const db=await this.open();
        try{
            const keys=await request(db.transaction('covers','readonly')
                .objectStore('covers').getAllKeys());
            if(keys.length>COVER_MAX_ASSETS ||
               keys.some(key=>!isLocalCoverRef(key)) ||
               new Set(keys).size!==keys.length)
                throw new Error('로컬 표지 보관함에 알 수 없는 키가 있습니다. 백업 후 확인해 주세요.');
            return keys.sort();
        }finally{db.close();}
    }
    /**
     * All-or-none IndexedDB installation for an already validated archive.
     * Never overwrites an existing digest; a digest clash is checked against
     * the existing original before attempting the add-only transaction.
     */
    async installVerified(assets){
        if(!Array.isArray(assets) || assets.length>COVER_MAX_ASSETS)
            throw new Error('표지 아카이브 이미지 수가 허용 범위를 초과했습니다.');
        const prepared=new Map();
        for(const asset of assets){
            if(!isLocalCoverRef(asset?.ref) || !(asset.blob instanceof Blob) ||
               prepared.has(asset.ref) || await coverRefFor(asset.blob)!==asset.ref)
                throw new Error('표지 내용·해시·중복 식별자가 유효하지 않습니다.');
            prepared.set(asset.ref,asset.blob);
        }
        // A read validates preexisting bytes. Failed/corrupt records are not
        // replaced, even if the incoming digest looks correct.
        for(const key of prepared.keys())await this.get(key);
        const db=await this.open();
        let added=0;
        try{
            const tx=db.transaction('covers','readwrite'),done=complete(tx);
            try{
                const store=tx.objectStore('covers');
                const keys=await request(store.getAllKeys());
                if(keys.some(k=>!isLocalCoverRef(k)) ||
                   keys.length>COVER_MAX_ASSETS)throw new Error('표지 보관함 상태가 올바르지 않습니다.');
                const existing=new Set(keys);
                const remaining=[...prepared].filter(([key])=>!existing.has(key));
                if(existing.size+remaining.length>COVER_MAX_ASSETS)
                    throw new Error('표지를 복원하면 이미지 120개 제한을 초과합니다. 먼저 백업을 점검하세요.');
                for(const [ref,blob] of remaining){
                    store.add({blob,bytes:blob.size,mime:blob.type,createdAt:Date.now()},ref);
                }
                added=remaining.length;
                await done;
            }catch(error){
                try{tx.abort();}catch{}
                await done.catch(()=>{});
                throw error;
            }
        }finally{db.close();}
        for(const ref of prepared.keys())
            if(!await this.get(ref))
                throw new Error('표지 복원 후 검증에 실패했습니다. 파일을 다시 확인하세요.');
        return {added,existing:prepared.size-added};
    }
    /** Precondition: caller has rechecked current Library references. */
    async deleteUnreferenced(refs,expectedAllRefs){
        if(!Array.isArray(refs) || !Array.isArray(expectedAllRefs) ||
           new Set(refs).size!==refs.length ||
           refs.some(x=>!isLocalCoverRef(x)) ||
           expectedAllRefs.some(x=>!isLocalCoverRef(x)))
            throw new Error('삭제 목록이 올바르지 않습니다.');
        const db=await this.open();
        let deleted=0;
        try{
            const tx=db.transaction('covers','readwrite'),done=complete(tx);
            try{
                const store=tx.objectStore('covers');
                const actual=(await request(store.getAllKeys())).sort();
                if(JSON.stringify(actual)!==JSON.stringify([...expectedAllRefs].sort()))
                    throw new Error('백업 이후 표지 보관함 목록이 변경됐습니다. 다시 점검하세요.');
                const live=new Set(actual);
                for(const ref of refs){
                    if(!live.has(ref))throw new Error('삭제 대상 표지가 사라졌습니다.');
                    store.delete(ref);
                }
                deleted=refs.length;
                await done;
            }catch(error){
                try{tx.abort();}catch{}
                await done.catch(()=>{});
                throw error;
            }
        }finally{db.close();}
        for(const ref of refs){
            const url=this.urls.get(ref);
            if(url){URL.revokeObjectURL(url);this.urls.delete(ref);}
        }
        return {deleted};
    }
    destroy(){
        for(const url of this.urls.values())URL.revokeObjectURL(url);
        this.urls.clear();
    }
}
