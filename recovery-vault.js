/**
 * Q-07C private browser recovery vault, scoped to the current ST origin.
 *
 * Two object stores: metadata for cheap listing, and raw JSONL for opt-in
 * restore/download only. IndexedDB commits AND SHA-256 readback verification
 * are mandatory before callers may delete or rename a server-side file.
 * Browser storage is NOT an external or permanent backup.
 */
export const TRASH_DB='stmn-elevator-recovery-v1';
export const TRASH_MAX_BYTES=64*1024*1024;
export const TRASH_RETENTION=[7,30,90,0];
const encoder=new TextEncoder();
const request=(req)=>new Promise((resolve,reject)=>{
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error||new Error('브라우저 보관함 접근 실패'));
});
const completed=(tx)=>new Promise((resolve,reject)=>{
    tx.oncomplete=()=>resolve();
    tx.onabort=()=>reject(tx.error||new Error('브라우저 보관함 트랜잭션 중단'));
    tx.onerror=()=>reject(tx.error||new Error('브라우저 보관함 저장 실패'));
});
export async function hashJsonl(text) {
    if(typeof text!=='string')throw new Error('원본 JSONL 문자열이 아닙니다.');
    if(!globalThis.crypto?.subtle?.digest)throw new Error('보안 연결이 아니어서 SHA-256 검증을 사용할 수 없습니다.');
    const digest=await crypto.subtle.digest('SHA-256',encoder.encode(text));
    return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export function parseChatJsonl(text) {
    if(typeof text!=='string' || !text.trim())throw new Error('비어 있는 JSONL은 안전하게 복구할 수 없습니다.');
    const lines=text.split('\n').map(x=>x.trim()).filter(Boolean);
    const chat=lines.map((line,index)=>{
        let value;
        try{value=JSON.parse(line);}catch{
            throw new Error('JSONL '+(index+1)+'번째 줄이 손상되어 복구할 수 없습니다.');
        }
        if(!value || typeof value!=='object' || Array.isArray(value))
            throw new Error('JSONL에 채팅 객체가 아닌 내용이 포함되어 있습니다.');
        return value;
    });
    if(!chat[0]?.chat_metadata || typeof chat[0].chat_metadata!=='object' ||
        Array.isArray(chat[0].chat_metadata))
        throw new Error('JSONL의 채팅 헤더가 올바르지 않습니다.');
    return chat;
}
export function sameChatJsonl(a,b){
    const left=parseChatJsonl(a),right=parseChatJsonl(b);
    return JSON.stringify(left)===JSON.stringify(right);
}
export function expiryFor(createdAt,days) {
    return days===0?null:createdAt+days*86400_000;
}
function validEntry(meta) {
    return meta && typeof meta.id==='string' && meta.id.length>=10 &&
        typeof meta.scope==='string' && /^(character|group):/.test(meta.scope) &&
        typeof meta.name==='string' && meta.name &&
        Number.isSafeInteger(meta.createdAt) && meta.createdAt>0 &&
        typeof meta.hash==='string' && /^[0-9a-f]{64}$/.test(meta.hash) &&
        Number.isInteger(meta.bytes) && meta.bytes>0 && meta.bytes<=TRASH_MAX_BYTES;
}
export class RecoveryVault {
    constructor({openDb=null,now=()=>Date.now()}={}){
        this.openDb=openDb;this.now=now;
    }
    async open(){
        if(this.openDb)return this.openDb();
        if(!globalThis.indexedDB)throw new Error('브라우저가 IndexedDB를 지원하지 않아 파일 변경을 중단했습니다.');
        const req=indexedDB.open(TRASH_DB,1);
        req.onupgradeneeded=()=>{
            const db=req.result;
            if(!db.objectStoreNames.contains('entries'))db.createObjectStore('entries',{keyPath:'id'});
            if(!db.objectStoreNames.contains('payloads'))db.createObjectStore('payloads');
            if(!db.objectStoreNames.contains('prefs'))db.createObjectStore('prefs');
        };
        return request(req);
    }
    async retention(){
        const db=await this.open();
        try {
            const tx=db.transaction(['prefs'],'readonly');
            const days=await request(tx.objectStore('prefs').get('retention'));
            return TRASH_RETENTION.includes(days)?days:30;
        }finally{db.close();}
    }
    async setRetention(days){
        if(!TRASH_RETENTION.includes(days))throw new Error('보관 기간 설정이 올바르지 않습니다.');
        const db=await this.open();
        try{
            const tx=db.transaction(['prefs','entries'],'readwrite');
            const done=completed(tx);
            tx.objectStore('prefs').put(days,'retention');
            const entries=tx.objectStore('entries');
            const all=await request(entries.getAll());
            for(const meta of all) {
                if(!validEntry(meta))continue;
                entries.put({...meta,expiresAt:expiryFor(meta.createdAt,days)});
            }
            await done;
        }finally{db.close();}
    }
    async store({scope,name,raw,isGroup,avatar,action,librarySnapshot=null,groupId=null}){
        if(!['rename','delete'].includes(action) || typeof scope!=='string' ||
           !/^(character|group):/.test(scope) || typeof name!=='string' || !name ||
           typeof raw!=='string')throw new Error('복구 보관함에 저장할 채팅 정보가 올바르지 않습니다.');
        const bytes=encoder.encode(raw).byteLength;
        if(!bytes || bytes>TRASH_MAX_BYTES)
            throw new Error('채팅 원본이 64MB를 초과하거나 비어 있어 자동 보관할 수 없습니다.');
        parseChatJsonl(raw);
        const hash=await hashJsonl(raw);
        const createdAt=this.now(),days=await this.retention();
        const meta={
            id:crypto.randomUUID(),scope,name,isGroup:Boolean(isGroup),
            avatar:isGroup?null:avatar,groupId:isGroup?String(groupId):null,
            action,createdAt,expiresAt:expiryFor(createdAt,days),
            hash,bytes,state:'prepared',resultName:null,
            librarySnapshot,
        };
        if(!validEntry(meta))throw new Error('보관함 기록을 검증할 수 없습니다.');
        // Best effort: Chrome may grant persistent storage based on user
        // engagement. Denial does not imply IndexedDB cannot work; the
        // subsequent durable transaction + readback remains mandatory.
        try {await globalThis.navigator?.storage?.persist?.();} catch {}
        const db=await this.open();
        try {
            const tx=db.transaction(['entries','payloads'],'readwrite');
            const done=completed(tx);
            tx.objectStore('entries').add(meta);
            tx.objectStore('payloads').add(raw,meta.id);
            await done;
        }finally{db.close();}
        // A successful put alone does NOT guarantee the application can read
        // the exact original back. Always re-open and SHA-256 verify.
        const verified=await this.read(meta.id);
        if(verified.raw!==raw)throw new Error('원본과 복구 사본의 내용이 달라 파일 변경을 중단했습니다.');
        return meta;
    }
    async read(id) {
        const db=await this.open();
        let meta,raw;
        try{
            const tx=db.transaction(['entries','payloads'],'readonly');
            [meta,raw]=await Promise.all([
                request(tx.objectStore('entries').get(id)),
                request(tx.objectStore('payloads').get(id)),
            ]);
        }finally{db.close();}
        if(!validEntry(meta) || typeof raw!=='string')
            throw new Error('복구용 사본이 없거나 저장 기록이 손상됐습니다.');
        if(encoder.encode(raw).byteLength!==meta.bytes ||
           await hashJsonl(raw)!==meta.hash)
            throw new Error('보관함 원본 검증에 실패했습니다. 복구나 파일 변경을 중단하세요.');
        parseChatJsonl(raw);
        return {meta,raw};
    }
    async list(){
        const db=await this.open();
        try{
            const tx=db.transaction(['entries'],'readonly');
            const rows=await request(tx.objectStore('entries').getAll());
            return rows.filter(validEntry).sort((a,b)=>b.createdAt-a.createdAt);
        }finally{db.close();}
    }
    async mark(id,state,resultName=undefined){
        if(!['committing','restoring','deleted','renamed','uncertain','restored'].includes(state))
            throw new Error('보관함 상태 변경이 올바르지 않습니다.');
        const db=await this.open();
        try{
            const tx=db.transaction(['entries'],'readwrite');
            const done=completed(tx);
            const store=tx.objectStore('entries');
            const previous=await request(store.get(id));
            if(!validEntry(previous))throw new Error('보관할 기록을 찾지 못했습니다.');
            // Record intent durably *before* an irreversible server request.
            // An interrupted "committing" record is never automatically pruned.
            if(state==='committing' && previous.state!=='prepared')
                throw new Error('이미 진행된 파일 작업을 다시 시작할 수 없습니다.');
            if(state==='committing' && previous.action==='rename' &&
                (typeof resultName!=='string' || !resultName || resultName.length>120))
                throw new Error('이름 변경 대상을 보관함에 기록할 수 없습니다.');
            if(state==='restoring' && (previous.state==='restoring' ||
                typeof resultName!=='string' || !resultName || resultName.length>120))
                throw new Error('복구 중이던 작업을 다시 시작할 수 없습니다. 서버 상태를 먼저 확인해 주세요.');
            store.put({...previous,state,
                resultName:resultName===undefined?previous.resultName:resultName});
            await done;
        }finally{db.close();}
    }
    async remove(id) {
        const db=await this.open();
        try{
            const tx=db.transaction(['entries','payloads'],'readwrite');
            const done=completed(tx);
            tx.objectStore('entries').delete(id);
            tx.objectStore('payloads').delete(id);
            await done;
        }finally{db.close();}
    }
    async pruneExpired(){
        const now=this.now();
        const expired=(await this.list()).filter(m=>
            m.expiresAt!==null && m.expiresAt<=now &&
            ['deleted','renamed','restored'].includes(m.state));
        for(const row of expired)await this.remove(row.id);
        return expired.length;
    }
}
