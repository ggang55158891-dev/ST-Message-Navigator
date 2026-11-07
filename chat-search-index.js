/**
 * E-03D/A: demand-built, active-chat-only search accelerator.
 *
 * No server requests, browser storage, settings or timers. Index exists only
 * inside ChatSearchUI. It uses 256-bit bigram Bloom filters per field to skip
 * impossible hits; every candidate is verified against the live ST message.
 * False positives are possible, false negatives must never be possible.
 *
 * The source snapshots are references to in-memory strings and are checked
 * before every search and immediately before results are returned. Edits,
 * swipes and title changes selectively rebuild their message's filter.
 */
import {getTitle} from './model.js';
import {
    normalizeSearchQuery,matchSearchMessage,SEARCH_MAX_RESULTS,
} from './chat-search.js';
import {projectDetailedChatMatches} from './chat-search-detail.js';

export const ACTIVE_INDEX_MAX_MESSAGES=20000;
export const ACTIVE_INDEX_MAX_SOURCE_BYTES=6*1024*1024;
export const ACTIVE_INDEX_YIELD_EVERY=256;
const BIT_WORDS=8;
const isObj=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const abort=()=>new DOMException('검색 대상 또는 메시지가 변경됐습니다. 다시 검색해 주세요.','AbortError');
const stringOf=value=>String(value??'');
function check(signal,stillValid,generation,currentGeneration){
    if(signal?.aborted || (stillValid && !stillValid()) ||
       generation!==currentGeneration())throw abort();
}
function gramBit(hi,lo){
    let hash=Math.imul(hi+1,0x9e3779b1)^Math.imul(lo+1,0x85ebca6b);
    hash^=hash>>>16;
    const h=hash>>>0;
    return [h&255,(h>>>8)&255,(h>>>16)&255];
}
function addBloom(bits,text){
    if(text.length<2)return;
    const value=text.toLocaleLowerCase();
    for(let i=0;i<value.length-1;i++){
        const positions=gramBit(value.charCodeAt(i),value.charCodeAt(i+1));
        for(const bit of positions)bits[bit>>>5]|=(1<<(bit&31));
    }
}
function makeBloom(text){
    const bits=new Uint32Array(BIT_WORDS);
    addBloom(bits,text);
    return bits;
}
function makeSwipeBloom(swipes){
    const bits=new Uint32Array(BIT_WORDS);
    for(const text of swipes)if(typeof text==='string')addBloom(bits,text);
    return bits;
}
function canContain(bits,mask){
    if(!bits)return true; // unindexed field: safe exact-match fallback
    for(let i=0;i<BIT_WORDS;i++){
        if((bits[i]&mask[i])!==mask[i])return false;
    }
    return true;
}
function sameSwipes(a,b){
    if(a.length!==b.length)return false;
    for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;
    return true;
}
function snapshot(message,metadata,prior,fields){
    if(!isObj(message))return {message,raw:'',title:'',swipes:[],bodyBits:null,titleBits:null,swipeBits:null,bytes:64,changed:!prior||prior.message!==message};
    const raw=stringOf(message.mes);
    const title=fields.titles||prior?.titleBits?getTitle(message,metadata):'';
    const swipes=fields.swipes||prior?.swipeBits
        ?(Array.isArray(message.swipes)?message.swipes:[]):[];
    const rawSame=prior?.message===message && prior.raw===raw;
    const titleSame=prior?.message===message && prior.title===title;
    const swipesSame=prior?.message===message && sameSwipes(prior.swipes,swipes);
    const bodyBits=fields.body
        ?(rawSame && prior.bodyBits?prior.bodyBits:makeBloom(raw))
        :(rawSame?prior?.bodyBits??null:null);
    const titleBits=fields.titles
        ?(titleSame && prior.titleBits?prior.titleBits:makeBloom(title))
        :(titleSame?prior?.titleBits??null:null);
    const swipeBits=fields.swipes
        ?(swipesSame && prior.swipeBits?prior.swipeBits:makeSwipeBloom(swipes))
        :(swipesSame?prior?.swipeBits??null:null);
    // Count source references and per-swipe overhead too: no hidden unbounded
    // arrays, even if the strings are zero-length.
    let bytes=128+(raw.length+title.length)*2;
    for(const text of swipes)bytes+=32+(typeof text==='string'?text.length*2:0);
    return {message,raw,title,swipes:swipes.slice(),bodyBits,titleBits,swipeBits,
        bytes,changed:!rawSame||!titleSame||!swipesSame||
            (fields.body&&!prior?.bodyBits)||
            (fields.titles&&!prior?.titleBits)||
            (fields.swipes&&!prior?.swipeBits)};
}
function verifySnapshot(chat,metadata,entries,fields){
    if(chat.length!==entries.length)return false;
    for(let i=0;i<chat.length;i++){
        const message=chat[i],entry=entries[i];
        if(entry.message!==message)return false;
        if(!isObj(message))continue;
        if(entry.raw!==stringOf(message.mes))return false;
        if((fields.titles||entry.titleBits) &&
           entry.title!==getTitle(message,metadata))return false;
        if((fields.swipes||entry.swipeBits) &&
           !sameSwipes(entry.swipes,Array.isArray(message.swipes)?message.swipes:[]))
            return false;
    }
    return true;
}
export class ActiveChatSearchIndex{
    constructor(){
        this.clear();
    }
    clear(){
        this.generation=(this.generation||0)+1;
        this.scope=null;this.chatId=null;this.chat=null;this.metadata=null;
        this.entries=[];this.bytes=0;
    }
    markDirty(){
        // Retain snapshots so a later explicit query can update just changed
        // message fields. In-flight scans are invalidated immediately.
        this.generation++;
    }
    async search(chat,metadata,{
        query,scope,chatId,titles=true,body=true,swipes=false,
        limit=SEARCH_MAX_RESULTS,signal,stillValid,
    }={}){
        const needle=normalizeSearchQuery(query).toLocaleLowerCase();
        if(!titles&&!body&&!swipes)
            throw new Error('검색할 내용을 하나 이상 선택해 주세요.');
        if(!Array.isArray(chat)||!Number.isInteger(limit)||limit<1||
           limit>SEARCH_MAX_RESULTS)throw new Error('검색 제한이 올바르지 않습니다.');
        const fields={titles,body,swipes};
        const generation=this.generation;
        const guard=()=>check(signal,stillValid,generation,()=>this.generation);
        guard();
        const canReuse=this.chat===chat && this.metadata===metadata &&
            this.scope===scope && this.chatId===chatId;
        const prior=canReuse?this.entries:[];
        // Structural edits/append/delete/reorder require an index rebuild to
        // keep actual #positions correct. Text-only edits are incremental.
        const structural=prior.length!==chat.length ||
            prior.some((x,i)=>x.message!==chat[i]);
        if(chat.length>ACTIVE_INDEX_MAX_MESSAGES){
            const output=await projectDetailedChatMatches([{chat_metadata:metadata},...chat],{
                query,titles,body,swipes,limit,signal,stillValid:()=>{guard();return true;},
            });
            return {...output,mode:'fallback',updated:0,reused:0};
        }
        let bytes=0,updated=0,reused=0;
        const entries=new Array(chat.length);
        for(let i=0;i<chat.length;i++){
            if(i>0 && i%ACTIVE_INDEX_YIELD_EVERY===0){
                await new Promise(resolve=>setTimeout(resolve,0));
                guard();
            }
            const entry=snapshot(chat[i],metadata,structural?null:prior[i],fields);
            bytes+=entry.bytes;
            if(bytes>ACTIVE_INDEX_MAX_SOURCE_BYTES){
                guard();
                const output=await projectDetailedChatMatches([{chat_metadata:metadata},...chat],{
                    query,titles,body,swipes,limit,signal,
                    stillValid:()=>{guard();return true;},
                });
                return {...output,mode:'fallback',updated:0,reused:0};
            }
            entries[i]=entry;
            if(entry.changed||structural)updated++;
            else reused++;
        }
        guard();
        if(!verifySnapshot(chat,metadata,entries,fields))throw abort();
        const mask=makeBloom(needle);
        const results=[];
        let scanned=0,truncated=false;
        for(let i=0;i<entries.length;i++){
            if(i>0 && i%ACTIVE_INDEX_YIELD_EVERY===0){
                await new Promise(resolve=>setTimeout(resolve,0));
                guard();
            }
            const entry=entries[i];
            scanned++;
            if(!((titles&&canContain(entry.titleBits,mask)) ||
                (body&&canContain(entry.bodyBits,mask)) ||
                (swipes&&canContain(entry.swipeBits,mask))))continue;
            const match=matchSearchMessage(chat[i],metadata,{
                query,needle,titles,body,swipes,
            });
            if(!match)continue;
            if(results.length>=limit){truncated=true;break;}
            results.push({...match,index:i});
        }
        guard();
        if(!verifySnapshot(chat,metadata,entries,fields))throw abort();
        // Commit only a completely validated snapshot; no partial cache after
        // cancel, a scope change, or an in-place edit during a yield.
        this.scope=scope;this.chatId=chatId;this.chat=chat;
        this.metadata=metadata;this.entries=entries;this.bytes=bytes;
        return {matches:results,scanned,total:chat.length,truncated,
            mode:'indexed',updated,reused};
    }
}
