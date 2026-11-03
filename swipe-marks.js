/**
 * Q-06 swipe curation (no changes to swipe text, order or active selection).
 *
 * Store user annotations under the existing per-chat outline metadata key,
 * keyed by stable message ID and complete-text fingerprints rather than
 * temporary swipe indices. A duplicate same-text swipe gets an ordinal suffix.
 * Editing a swipe's actual text intentionally invalidates its old fingerprint
 * so a mark is NEVER silently applied to a different answer.
 */
import { DATA_KEY, MESSAGE_KEY, makeId } from './model.js';

export const MAX_SWIPE_TAGS = 6;
export const MAX_SWIPE_TAG_LENGTH = 24;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

/** Two independent 32-bit FNV-style hashes over every UTF-16 code unit. */
export function swipeFingerprint(text) {
    const value = String(text ?? '');
    let a=2166136261, b=2166136261 ^ 0x9e3779b9;
    for(let i=0;i<value.length;i++) {
        const char=value.charCodeAt(i);
        a=Math.imul(a ^ char, 16777619);
        b=Math.imul(b ^ (char ^ (i & 255)), 16777619);
    }
    return value.length.toString(36)+':'+(a>>>0).toString(36)+':'+(b>>>0).toString(36);
}

export function swipeKeys(message) {
    const texts=Array.isArray(message?.swipes) && message.swipes.length
        ? message.swipes : [message?.mes ?? ''];
    const occurrences=new Map();
    return texts.map(text=>{
        const fp=swipeFingerprint(text);
        const next=occurrences.get(fp)||0;
        occurrences.set(fp,next+1);
        return fp+':'+next;
    });
}

export function normalizedSwipeTags(input) {
    if(!Array.isArray(input) || input.length>MAX_SWIPE_TAGS) {
        throw new Error('스와이프 태그는 최대 6개까지 지정할 수 있습니다.');
    }
    const seen=new Set();
    return input.map(tag=>{
        if(typeof tag!=='string') throw new Error('태그에는 문자열만 입력할 수 있습니다.');
        const clean=tag.trim();
        if(!clean || clean.length>MAX_SWIPE_TAG_LENGTH ||
            /[\u0000-\u001f\u007f,]/.test(clean)) {
            throw new Error('태그는 쉼표와 줄바꿈 없이 1~24자로 입력해 주세요.');
        }
        return clean;
    }).filter(tag=>{
        const key=tag.toLocaleLowerCase();
        if(seen.has(key))return false;
        seen.add(key);
        return true;
    });
}

export function swipeAnnotation(message, metadata, swipeIndex, keys=swipeKeys(message)) {
    if(!Number.isInteger(swipeIndex) || swipeIndex<0 || swipeIndex>=keys.length) {
        return {favorite:false,tags:[]};
    }
    const id=message?.[MESSAGE_KEY];
    const stored=typeof id==='string'
        ? metadata?.[DATA_KEY]?.swipeAnnotations?.[id]?.[keys[swipeIndex]]
        : null;
    return {
        favorite:stored?.favorite===true,
        tags:Array.isArray(stored?.tags) ? [...stored.tags] : [],
    };
}

function uniqueId(chat, index, id, idFactory) {
    if(typeof id==='string' && id.length>0 && id.length<=200 &&
        !FORBIDDEN.has(id) &&
        !chat.some((m,i)=>i!==index && m?.[MESSAGE_KEY]===id)) return {id,clone:false};
    for(let n=0;n<12;n++) {
        const candidate=idFactory();
        if(typeof candidate==='string' && candidate.length>0 &&
            candidate.length<=200 && !FORBIDDEN.has(candidate) &&
            !chat.some(m=>m?.[MESSAGE_KEY]===candidate)) return {id:candidate,clone:true};
    }
    throw new Error('중복되지 않는 메시지 식별자를 만들 수 없습니다.');
}

/** Returns {changed, previousId}; caller persists with ST's saveMetadata().
 * On a rejected persistence attempt, caller can restore captured snapshots.
 */
export function setSwipeAnnotation(chat, metadata, index, swipeIndex, patch, idFactory=makeId) {
    if(!Array.isArray(chat) || !chat[index] || !metadata || typeof metadata!=='object' ||
        Array.isArray(metadata)) throw new Error('저장 가능한 채팅이 아닙니다.');
    const message=chat[index];
    const keys=swipeKeys(message);
    if(!Number.isInteger(swipeIndex) || swipeIndex<0 || swipeIndex>=keys.length ||
        !Array.isArray(message.swipes) || !message.swipes.length) {
        throw new Error('유효한 스와이프 번호를 선택해 주세요.');
    }
    if(!patch || typeof patch!=='object' || Array.isArray(patch) ||
       !['favorite','tags'].every(k=>!Object.hasOwn(patch,k) ||
           (k==='favorite'?typeof patch.favorite==='boolean':Array.isArray(patch.tags)))) {
        throw new Error('스와이프 즐겨찾기 또는 태그 입력이 올바르지 않습니다.');
    }
    const hasFavorite=Object.hasOwn(patch,'favorite');
    const hasTags=Object.hasOwn(patch,'tags');
    if(!hasFavorite && !hasTags) return false;
    const old=swipeAnnotation(message,metadata,swipeIndex,keys);
    const next={
        favorite:hasFavorite?patch.favorite:old.favorite,
        tags:hasTags?normalizedSwipeTags(patch.tags):old.tags,
    };
    if(old.favorite===next.favorite && JSON.stringify(old.tags)===JSON.stringify(next.tags)) return false;

    const previousId=message[MESSAGE_KEY];
    const identity=uniqueId(chat,index,previousId,idFactory);
    let store=metadata[DATA_KEY];
    if(!store || typeof store!=='object' || Array.isArray(store)) {
        store=metadata[DATA_KEY]={schema:1,titles:Object.create(null)};
    }
    if(!store.swipeAnnotations || typeof store.swipeAnnotations!=='object' ||
       Array.isArray(store.swipeAnnotations)) store.swipeAnnotations=Object.create(null);
    let previous=store.swipeAnnotations[previousId];
    // A pasted message with a duplicate ID gets its own independent copy
    // of titles/bookmarks and swipe marks on its first explicit edit.
    if(identity.clone && typeof previousId==='string' && previousId &&
       !FORBIDDEN.has(previousId)) {
        if(Object.hasOwn(store.titles||{},previousId)) {
            (store.titles??=Object.create(null))[identity.id]=store.titles[previousId];
        }
        if(store.bookmarks?.[previousId]===true) {
            (store.bookmarks??=Object.create(null))[identity.id]=true;
        }
    }
    let annotations=identity.clone && previous && typeof previous==='object'
        ? {...previous} : store.swipeAnnotations[identity.id];
    if(!annotations || typeof annotations!=='object' || Array.isArray(annotations)) annotations=Object.create(null);
    const key=keys[swipeIndex];
    if(!next.favorite && !next.tags.length) delete annotations[key];
    else annotations[key]={favorite:next.favorite,tags:next.tags};
    if(Object.keys(annotations).length) store.swipeAnnotations[identity.id]=annotations;
    else delete store.swipeAnnotations[identity.id];
    message[MESSAGE_KEY]=identity.id;
    return true;
}

/** Read-only curation projection: fingerprint each swipe once per panel open. */
export function markedSwipes(message,metadata) {
    const keys=swipeKeys(message);
    const texts=Array.isArray(message?.swipes) && message.swipes.length
        ? message.swipes : [message?.mes ?? ''];
    return keys.map((key,index)=>({
        index,key,text:String(texts[index]??''),
        ...swipeAnnotation(message,metadata,index,keys),
        current:index===(Number.isInteger(message?.swipe_id)?message.swipe_id:0),
    }));
}
