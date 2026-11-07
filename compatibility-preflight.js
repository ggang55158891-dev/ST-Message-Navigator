/**
 * H-01 compact, read-only compatibility preflight.
 * Never invokes save/delete/swipe/network methods, opens IndexedDB,
 * inspects chat text, or records identifiers. This is API presence only,
 * NOT proof that file operations are safe or persistent.
 */
export const PREFLIGHT_VERSION=1;

export function inspectRuntimeCompatibility(contextProvider,{
    documentRef=typeof document==='undefined'?null:document,
    indexedDBRef=typeof indexedDB==='undefined'?null:indexedDB,
    cryptoRef=typeof crypto==='undefined'?null:crypto,
}={}){
    let ctx=null;
    try{ctx=typeof contextProvider==='function'?contextProvider():null;}
    catch{ctx=null;}
    const present=Boolean(ctx&&typeof ctx==='object');
    const hasChat=present&&Array.isArray(ctx.chat)&&
        typeof ctx.chatId==='string'&&ctx.chatId.length>0;
    const tests=[
        ['st_context','SillyTavern 연결',present,
            'SillyTavern 컨텍스트가 확인되지 않았습니다. 확장을 다시 열어 주세요.'],
        ['chat_view','현재 채팅',hasChat,
            '현재 열린 채팅이 없습니다. 대화를 열고 다시 점검하세요.'],
        ['metadata','제목·즐겨찾기 저장',hasChat&&typeof ctx.saveMetadata==='function',
            '메시지 관리용 saveMetadata API를 확인하지 못했습니다.'],
        ['chat_save','원본 백업·순서 변경',hasChat&&typeof ctx.saveChat==='function',
            '원본 저장용 saveChat API를 확인하지 못했습니다.'],
        ['chat_export','채팅 파일 조회·백업',present&&typeof ctx.getRequestHeaders==='function'&&
            typeof fetch==='function',
            '서버 조회용 인증 헤더 또는 fetch를 확인하지 못했습니다.'],
        ['native_delete','메시지 삭제',hasChat&&typeof ctx.deleteMessage==='function',
            'SillyTavern의 메시지 삭제 API를 확인하지 못했습니다.'],
        ['swipe','스와이프 선택',hasChat&&typeof ctx.swipe?.to==='function',
            '스와이프 선택 API를 확인하지 못했습니다.'],
        ['browser_storage','로컬 이미지·복구 보관함',Boolean(indexedDBRef)&&
            typeof indexedDBRef.open==='function',
            '이 브라우저에서 IndexedDB 인터페이스를 확인하지 못했습니다.'],
        ['sha256','원본 해시 검증',Boolean(cryptoRef?.subtle)&&
            typeof cryptoRef.subtle.digest==='function',
            'SHA-256 검증용 Web Crypto를 사용할 수 없습니다. 보안 연결을 확인하세요.'],
        ['chat_dom','채팅 화면',Boolean(documentRef?.querySelector?.('#chat')),
            '채팅 화면(#chat)을 확인하지 못했습니다. UI 호환성을 확인해 주세요.'],
    ];
    const checks=tests.map(([id,label,ok,help])=>({
        id,label,status:ok?'ready':'check',...(!ok?{help}:{}),
    }));
    const ready=checks.filter(check=>check.status==='ready').length;
    return {
        schemaVersion:PREFLIGHT_VERSION,
        ready,needsAttention:checks.length-ready,
        checks,
        note:'API 존재 여부만 점검했습니다. 실제 저장 성공·서버 권한·타 확장 충돌은 보장하지 않습니다.',
    };
}
