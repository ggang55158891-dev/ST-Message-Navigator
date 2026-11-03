/** E-03A Quiet opt-in search panel. Never scans on panel open. */
import {buildingScope,cleanChatId} from './building-data.js';
import {selectLibraryChats} from './library-operations.js';
import {
    SEARCH_BATCH_SIZE,SEARCH_MAX_RESULTS,metadataMatches,normalizeSearchQuery,
    projectChatMatches,readChatMatches,
} from './chat-search.js';

const make=(tag,cls='',text)=>{
    const node=document.createElement(tag);
    if(cls)node.className=cls;
    if(text!==undefined)node.textContent=String(text);
    return node;
};
const button=(label,cls,onClick)=>{
    const node=make('button',cls,label);
    node.type='button';node.addEventListener('click',onClick);
    return node;
};
const checked=(label,value)=>{
    const wrapper=make('label','stmn-search-choice');
    const box=make('input');
    box.type='checkbox';box.checked=value;
    wrapper.append(box,document.createTextNode(label));
    return {wrapper,box};
};
const aborted=error=>error?.name==='AbortError';

export class ChatSearchUI{
    constructor(library){
        this.library=library;
        this.owner=library.owner;
        this.serial=0;
        this.scope=null;
        this.controller=null;
        this.opened=false;
        this.offset=0;
        this.results=[];

        this.panel=make('section','stmn-chat-search');
        this.panel.hidden=true;
        this.panel.setAttribute('role','region');
        this.panel.setAttribute('aria-label','현재 채팅 범위 통합 검색');
        const header=make('div','stmn-chat-search-header');
        header.append(make('strong','','통합 검색 · 현재 캐릭터/그룹'));
        this.closeButton=button('×','stmn-chat-search-close',()=>this.close());
        this.closeButton.setAttribute('aria-label','통합 검색 닫기');
        header.append(this.closeButton);

        this.form=make('form','stmn-chat-search-form');
        this.input=make('input','stmn-chat-search-input');
        this.input.type='search';
        this.input.maxLength=100;
        this.input.placeholder='파일명 · 설명 · 메시지 제목 · 대사';
        this.input.setAttribute('aria-label','통합 검색어');
        this.input.autocomplete='off';
        const scopes=make('div','stmn-chat-search-scopes');
        const meta=checked('파일명·설명·폴더·태그',true);
        const title=checked('메시지 제목',true);
        const body=checked('메시지 본문',true);
        this.meta=meta.box;this.titles=title.box;this.body=body.box;
        scopes.append(meta.wrapper,title.wrapper,body.wrapper);
        this.searchButton=button('검색','stmn-chat-search-start',()=>{});
        this.searchButton.type='submit';
        this.cancelButton=button('중단','stmn-chat-search-cancel',()=>this.cancel());
        this.cancelButton.hidden=true;
        this.form.append(this.input,scopes,this.searchButton,this.cancelButton);
        this.form.addEventListener('submit',event=>{
            event.preventDefault();void this.search(false);
        });
        for(const input of [this.input,this.meta,this.titles,this.body]){
            input.addEventListener('input',()=>this.resetResults());
        }
        this.status=make('p','stmn-chat-search-status','');
        this.status.setAttribute('role','status');
        this.list=make('div','stmn-chat-search-results');
        this.list.setAttribute('role','list');
        this.nextButton=button('다음 12개 채팅 검색','stmn-chat-search-next',()=>void this.search(true));
        this.nextButton.hidden=true;
        this.panel.append(header,this.form,this.status,this.list,this.nextButton);
        this.owner.contentArea.prepend(this.panel);
    }

    isValid(scope){
        return this.opened && this.panel.isConnected && !this.panel.hidden &&
            this.owner.tab==='buildings' &&
            this.owner.view.root.dataset.elevatorTheme==='quiet' &&
            this.owner.scope===scope &&
            buildingScope(this.owner.callbacks.context())===scope;
    }

    open(){
        const scope=this.owner.scope;
        if(this.owner.busy || !scope || !this.library.data ||
           this.owner.tab!=='buildings' ||
           this.owner.view.root.dataset.elevatorTheme!=='quiet' ||
           buildingScope(this.owner.callbacks.context())!==scope)return false;
        this.close();
        this.opened=true;
        this.scope=scope;
        this.panel.hidden=false;
        this.status.textContent='검색어를 입력하고 검색을 누르세요. 본문은 버튼을 누를 때만 12개씩 조회합니다.';
        this.input.focus();
        this.panel.scrollIntoView?.({block:'nearest'});
        return true;
    }

    cancel(){
        ++this.serial;
        this.controller?.abort();
        this.controller=null;
        this.searchButton.disabled=false;
        this.cancelButton.hidden=true;
        this.nextButton.hidden=true;
        this.status.textContent='검색을 중단했습니다. 새로 검색할 수 있습니다.';
    }

    resetResults(){
        if(!this.opened)return;
        ++this.serial;
        this.controller?.abort();
        this.controller=null;
        this.offset=0;
        this.results=[];
        this.list.replaceChildren();
        this.searchButton.disabled=false;
        this.cancelButton.hidden=true;
        this.nextButton.hidden=true;
        this.status.textContent='검색 조건이 변경되었습니다. 검색을 눌러 적용하세요.';
    }

    close(){
        ++this.serial;
        this.controller?.abort();
        this.controller=null;
        this.opened=false;
        this.scope=null;
        this.offset=0;
        this.results=[];
        this.panel.hidden=true;
        this.list.replaceChildren();
        this.nextButton.hidden=true;
        this.searchButton.disabled=false;
        this.cancelButton.hidden=true;
    }

    invalidate(){this.close();}

    renderResults(){
        const fragment=document.createDocumentFragment();
        for(const result of this.results){
            const name=result.item.name || result.item.id;
            const row=button('','stmn-chat-search-result',()=>void this.goToResult(result));
            row.setAttribute('role','listitem');
            row.setAttribute('aria-label',
                name+(result.index===null?' · 채팅 열기':' · #'+result.index+' 메시지로 이동'));
            const title=make('strong','',name+
                (result.index===null?' · 채팅':' · #'+result.index+' '+result.title));
            const note=make('small','',result.index===null
                ?'파일명·설명·폴더·태그 일치':result.field==='title'?'제목 일치':'본문 일치');
            row.append(title,note);
            if(result.excerpt)row.append(make('span','',result.excerpt));
            fragment.append(row);
        }
        if(!this.results.length)fragment.append(make('p','','이 구간에는 일치하는 결과가 없습니다.'));
        this.list.replaceChildren(fragment);
    }

    async goToResult(result){
        if(this.controller || this.owner.busy || !this.isValid(this.scope))return;
        const scope=this.scope,item=result.item,index=result.index;
        if(!this.owner.buildings.some(x=>cleanChatId(x.id)===cleanChatId(item.id)))return;
        this.close();
        await this.owner.enter(item);
        const ctx=this.owner.callbacks.context();
        if(index!==null && buildingScope(ctx)===scope &&
           cleanChatId(ctx.chatId)===cleanChatId(item.id)){
            await this.owner.view.callbacks.goToIndex?.(index);
        }
    }

    async search(next=false){
        if(!this.opened || this.controller || this.owner.busy)return false;
        const scope=this.scope;
        if(!this.isValid(scope))return false;
        let query;
        try{query=normalizeSearchQuery(this.input.value);}
        catch(error){this.status.textContent=error.message;return false;}
        const config={meta:this.meta.checked,titles:this.titles.checked,body:this.body.checked};
        if(!Object.values(config).some(Boolean)){
            this.status.textContent='최소 하나의 검색 범위를 선택하세요.';
            return false;
        }
        const owner=this.owner,ctx=owner.callbacks.context();
        // Freeze a current-scope snapshot for this explicit search invocation.
        const items=selectLibraryChats(owner.buildings,scope,this.library.data,{
            view:'all',query:'',sort:owner.sort.value,
        });
        const scanMessages=config.titles || config.body;
        const from=next?this.offset:0;
        const candidates=scanMessages?items.slice(from,from+SEARCH_BATCH_SIZE):items;
        if(next && (!scanMessages || from>=items.length))return false;
        const controller=new AbortController();
        const serial=++this.serial;
        this.controller=controller;
        this.searchButton.disabled=true;
        this.cancelButton.hidden=false;
        this.nextButton.hidden=true;
        this.results=[];
        this.list.replaceChildren();
        let failures=0;
        let truncated=0;
        let processed=0;
        try{
            for(const item of candidates){
                if(controller.signal.aborted || serial!==this.serial || !this.isValid(scope))
                    throw new DOMException('검색 취소','AbortError');
                const entries=[];
                if(config.meta && metadataMatches(item,query))
                    entries.push({item,index:null,field:'metadata',title:'',excerpt:''});
                if(scanMessages){
                    try{
                        const current=cleanChatId(ctx.chatId)===cleanChatId(item.id);
                        let matches;
                        if(current){
                            // In-memory current chat is authoritative for unsaved edits.
                            const messages=[{chat_metadata:ctx.chatMetadata||{}},...(ctx.chat||[])];
                            matches=projectChatMatches(messages,{
                                query,titles:config.titles,body:config.body,
                            });
                        }else{
                            const found=await readChatMatches(ctx,scope,owner.buildings,item,{
                                query,titles:config.titles,body:config.body,
                                signal:controller.signal,
                            });
                            matches=found.matches;
                        }
                        for(const match of matches)entries.push({...match,item});
                    }catch(error){
                        if(aborted(error) || controller.signal.aborted)throw error;
                        failures++;
                    }
                }
                for(const entry of entries){
                    if(this.results.length<SEARCH_MAX_RESULTS)this.results.push(entry);
                    else truncated++;
                }
                processed++;
                this.status.textContent=(from+processed)+' / '+items.length+
                    '개 채팅 확인 · 결과 '+this.results.length+'개';
                // Yield to the browser even when metadata-only scans are cheap.
                if(processed%3===0)await new Promise(resolve=>setTimeout(resolve,0));
            }
            if(serial!==this.serial || !this.isValid(scope))return false;
            this.offset=scanMessages?from+candidates.length:items.length;
            this.renderResults();
            const remaining=scanMessages && this.offset<items.length;
            this.status.textContent=(scanMessages?'이번 구간 ':'')+
                this.results.length+'개 결과 · '+this.offset+' / '+items.length+
                '개 채팅 확인'+(failures?' · '+failures+'개 채팅 조회 실패/용량 초과':'')+
                (truncated?' · '+truncated+'개 결과 표시 제한':'')+
                (remaining?' · 다음 구간을 검색할 수 있습니다.':' · 검색 종료');
            this.nextButton.hidden=!remaining;
            return true;
        }catch(error){
            if(serial===this.serial && this.isValid(scope)){
                this.status.textContent=aborted(error)?'검색이 취소되었습니다.':
                    '검색 도중 오류가 발생했습니다: '+(error?.message||'알 수 없음');
                this.list.replaceChildren();
                this.results=[];
            }
            return false;
        }finally{
            if(this.controller===controller){
                this.controller=null;
                this.searchButton.disabled=false;
                this.cancelButton.hidden=true;
            }
        }
    }

    destroy(){this.close();this.panel.remove();}
}
