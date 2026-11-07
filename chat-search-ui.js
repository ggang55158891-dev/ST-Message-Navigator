/** E-03A Quiet opt-in search panel. Never scans on panel open. */
import {buildingScope,cleanChatId} from './building-data.js';
import {selectLibraryChats} from './library-operations.js';
import {readDetailedChatMatches,projectDetailedChatMatches} from './chat-search-detail.js';
import {getTitle} from './model.js';
import {ActiveChatSearchIndex} from './chat-search-index.js';
import {
    SEARCH_BATCH_SIZE,SEARCH_MAX_RESULTS,metadataMatches,normalizeSearchQuery,
    projectChatMatches,readChatMatches,searchServerBodyCandidates,
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
        this.detailTargets=new Map();
        this.activeIndex=new ActiveChatSearchIndex();
        this.range='all';
        this.openSequence=0;
        this.opening=false;

        this.panel=make('section','stmn-chat-search');
        this.panel.hidden=true;
        this.panel.setAttribute('role','region');
        this.panel.setAttribute('aria-label','현재 채팅 범위 통합 검색');
        const header=make('div','stmn-chat-search-header');
        header.append(make('strong','','검색'));
        this.closeButton=button('×','stmn-chat-search-close',()=>this.close());
        this.closeButton.setAttribute('aria-label','통합 검색 닫기');
        header.append(this.closeButton);

        this.form=make('form','stmn-chat-search-form');
        this.input=make('input','stmn-chat-search-input');
        this.input.type='search';
        this.input.maxLength=100;
        this.input.placeholder='찾을 대사나 채팅 이름 입력';
        this.input.setAttribute('aria-label','통합 검색어');
        this.input.autocomplete='off';
        this.rangeRow=make('div','stmn-unified-search-range');
        this.currentButton=button('현재 채팅','stmn-unified-search-range-button',()=>this.setRange('current'));
        this.allButton=button('전체 채팅','stmn-unified-search-range-button',()=>this.setRange('all'));
        this.currentButton.title='지금 열어 둔 대화의 모든 메시지를 검색합니다.';
        this.allButton.title='현재 캐릭터 또는 그룹에 연결된 채팅들을 검색합니다.';
        this.rangeRow.append(this.currentButton,this.allButton);
        this.rangeHint=make('p','stmn-unified-search-hint','');
        this.options=make('details','stmn-unified-search-options');
        this.options.append(make('summary','','검색 옵션'));
        const scopes=make('div','stmn-chat-search-scopes');
        const meta=checked('파일명·설명·폴더·태그',true);
        this.metaWrapper=meta.wrapper;
        const title=checked('메시지 제목',true);
        const body=checked('메시지 본문',true);
        this.meta=meta.box;this.titles=title.box;this.body=body.box;
        const swipeMain=checked('다른 스와이프의 답변',false);
        this.swipeMain=swipeMain.box;
        scopes.append(meta.wrapper,title.wrapper,body.wrapper,swipeMain.wrapper);
        this.options.append(scopes);
        this.searchButton=button('검색','stmn-chat-search-start',()=>{});
        this.searchButton.type='submit';
        this.serverButton=button('대용량 본문 후보 찾기 · 서버 검색',
            'stmn-chat-search-server',()=>void this.searchServer());
        this.serverButton.title='서버가 채팅 파일을 직접 검색하고 일치할 가능성이 있는 채팅 이름만 돌려줍니다. 정확한 메시지 번호는 제공하지 않습니다.';
        this.detailRow=make('div','stmn-chat-search-detail-controls');
        const targetLabel=make('label','stmn-chat-search-target-label','채팅 하나만 정밀 검색');
        this.targetSelect=make('select','stmn-chat-search-target');
        this.targetSelect.setAttribute('aria-label','정밀 검색 대상 채팅');
        targetLabel.append(this.targetSelect);
        const includeSwipes=checked('다른 스와이프도 검사',true);
        this.detailSwipes=includeSwipes.box;
        this.detailButton=button('선택한 채팅의 정확한 #번호 찾기 · 최대 32MB',
            'stmn-chat-search-detail',()=>void this.searchDetailed());
        this.detailButton.title='한 채팅만 검사하고 사용자 제목, 현재 대사, 대체 스와이프를 정확한 #번호로 찾습니다. 원문은 보관하지 않습니다.';
        this.detailRow.append(targetLabel,includeSwipes.wrapper,this.detailButton);
        this.moreSearch=make('details','stmn-unified-search-more');
        this.moreSearch.append(make('summary','','더 찾아보기 · 대용량/정밀 검색'));
        this.moreHelp=make('p','stmn-unified-search-help',
            '일반 검색은 채팅을 12개씩 확인합니다. 대용량 후보 찾기는 메시지 번호 없이 채팅만 찾고, 정밀 검색은 선택한 채팅 1개의 정확한 #번호를 찾습니다.');
        this.moreSearch.append(this.moreHelp,this.serverButton,this.detailRow);
        this.cancelButton=button('중단','stmn-chat-search-cancel',()=>this.cancel());
        this.cancelButton.hidden=true;
        this.form.append(this.input,this.rangeRow,this.rangeHint,
            this.searchButton,this.options,this.moreSearch,this.cancelButton);
        this.form.addEventListener('submit',event=>{
            event.preventDefault();void this.search(false);
        });
        for(const input of [this.input,this.meta,this.titles,this.body,this.swipeMain,this.detailSwipes,this.targetSelect]){
            input.addEventListener('input',()=>{
                this.resetResults();
                this.serverButton.disabled=!this.body.checked;
                this.detailButton.disabled=!this.detailTargets.size;
            });
        }
        this.suggestion=button('다른 채팅에서도 찾아보기',
            'stmn-unified-search-suggestion',()=>this.suggestMore());
        this.suggestion.hidden=true;
        this.status=make('p','stmn-chat-search-status','');
        this.status.setAttribute('role','status');
        this.list=make('div','stmn-chat-search-results');
        this.list.setAttribute('role','list');
        this.nextButton=button('다음 12개 채팅 검색','stmn-chat-search-next',()=>void this.search(true));
        this.nextButton.hidden=true;
        this.panel.append(header,this.form,this.status,this.list,this.nextButton,this.suggestion);
        // A single third-level view, independent of the floor/lobby DOM.
        // Existing lists keep their native scroll positions while it is open.
        this.owner.view.footer.before(this.panel);
        this.setRange('all');
    }

    isValid(scope){
        return this.opened && this.panel.isConnected && !this.panel.hidden &&
            this.owner.view.root.dataset.elevatorTheme==='quiet' &&
            this.owner.scope===scope &&
            buildingScope(this.owner.callbacks.context())===scope;
    }

    setRange(value){
        if(value!=='current' && value!=='all')return;
        if(this.opened && this.controller)this.resetResults();
        const changed=this.range!==value;
        this.range=value;
        this.currentButton.setAttribute('aria-pressed',String(value==='current'));
        this.allButton.setAttribute('aria-pressed',String(value==='all'));
        this.metaWrapper.hidden=value==='current';
        this.moreSearch.hidden=value==='current';
        if(value==='current')this.moreSearch.open=false;
        this.rangeHint.textContent=value==='current'
            ?'지금 열려 있는 대화에서 메시지 위치를 찾습니다.'
            :'현재 캐릭터·그룹에 있는 채팅 이름과 대사를 찾습니다.';
        if(changed && this.opened){
            this.resetResults();
            this.status.textContent=value==='current'
                ?'현재 채팅에서 검색할 내용을 입력하세요.'
                :'전체 채팅 검색은 12개씩 확인합니다. 큰 채팅은 추가 검색을 이용하세요.';
        }
    }

    suggestMore(){
        if(this.range==='current'){
            this.setRange('all');
            this.input.focus({preventScroll:true});
        }else{
            this.moreSearch.open=true;
            this.moreSearch.querySelector('summary')?.focus({preventScroll:true});
        }
    }

    async open(preferred='all'){
        const ctx=this.owner.callbacks.context(),scope=buildingScope(ctx);
        if(this.opening || this.opened || this.owner.busy || !scope ||
            this.owner.view.root.dataset.elevatorTheme!=='quiet')return false;
        const serial=++this.openSequence;
        this.opening=true;
        try{
            // Starting from Floors must work even before the lobby was visited.
            // Refresh only metadata; do not fetch message bodies until Search.
            if(this.owner.scope!==scope || !this.library.data ||
               !this.owner.buildings.length){
                this.owner.view.setStatus('검색 대상 채팅 목록을 준비하고 있습니다…');
                await this.owner.refreshBuildings(true);
            }
            if(serial!==this.openSequence ||
               buildingScope(this.owner.callbacks.context())!==scope ||
               this.owner.view.root.dataset.elevatorTheme!=='quiet' ||
               !this.library.data || this.owner.scope!==scope)
                return false;
            const changedScope=this.lastScope!==undefined && this.lastScope!==scope;
            this.close();
            if(changedScope)this.input.value='';
            this.lastScope=scope;
            this.opened=true;
            this.scope=scope;
            const targets=selectLibraryChats(this.owner.buildings,scope,this.library.data,{
                view:'all',query:'',sort:'name',
            }).slice(0,3000);
            this.detailTargets=new Map(targets.map(item=>[cleanChatId(item.id),item]));
            this.targetSelect.replaceChildren();
            for(const item of targets){
                const opt=make('option','',item.alias||item.name||item.id);
                opt.value=cleanChatId(item.id);
                this.targetSelect.append(opt);
            }
            const current=cleanChatId(this.owner.callbacks.context().chatId);
            if(this.detailTargets.has(current))this.targetSelect.value=current;
            this.detailButton.disabled=!this.detailTargets.size;
            this.panel.hidden=false;
            this.owner.view.root.dataset.stmnUnifiedSearch='open';
            this.options.open=false;this.moreSearch.open=false;
            this.setRange(preferred==='current'?'current':'all');
            this.suggestion.hidden=true;
            this.status.textContent='검색어를 입력하고 Enter 또는 검색 버튼을 누르세요.';
            this.input.focus({preventScroll:true});
            this.owner.quiet?.refresh();
            return true;
        }finally{
            this.opening=false;
        }
    }

    cancel(){
        ++this.serial;
        this.controller?.abort();
        this.controller=null;
        this.searchButton.disabled=false;
        this.cancelButton.hidden=true;
        this.serverButton.disabled=!this.body.checked;
        this.detailButton.disabled=!this.detailTargets.size;
        this.nextButton.hidden=true;
        this.suggestion.hidden=true;
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
        this.suggestion.hidden=true;
        this.searchButton.disabled=false;
        this.cancelButton.hidden=true;
        this.serverButton.disabled=!this.body.checked;
        this.detailButton.disabled=!this.detailTargets.size;
        this.nextButton.hidden=true;
        this.status.textContent='검색 조건이 변경되었습니다. 검색을 눌러 적용하세요.';
    }

    close(){
        ++this.serial;
        ++this.openSequence;
        this.controller?.abort();
        this.controller=null;
        const wasOpen=this.opened;
        this.activeIndex.clear();
        this.opened=false;
        this.scope=null;
        this.detailTargets.clear();
        this.targetSelect.replaceChildren();
        this.offset=0;
        this.results=[];
        this.panel.hidden=true;
        this.owner.view.root.dataset.stmnUnifiedSearch='closed';
        this.list.replaceChildren();
        this.suggestion.hidden=true;
        this.nextButton.hidden=true;
        this.searchButton.disabled=false;
        this.cancelButton.hidden=true;
        this.serverButton.disabled=!this.body.checked;
        this.detailButton.disabled=true;
        if(wasOpen)this.owner.quiet?.refresh();
    }

    invalidate(){this.close();}
    onMessageMutation(){
        this.activeIndex.markDirty();
        if(!this.opened)return;
        this.resetResults();
        this.status.textContent='메시지가 변경됐습니다. 정확한 위치를 확인하려면 다시 검색해 주세요.';
    }

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
            const note=make('small','',result.field==='server-body'
                ?'서버 본문 후보 · 메시지 번호는 채팅을 열어 확인 · 정밀 검색으로 정확한 #번호 찾기'
                :result.index===null?'파일명·설명·폴더·태그 일치'
                :result.field==='number'?'메시지 번호로 이동'
                :result.field==='title'?'제목 일치'
                :result.field==='swipe'
                    ?'다른 스와이프 '+(result.swipeIndex+1)+'번 일치 · 메시지로 이동(답변은 유지)'
                    :'본문 일치');
            row.append(title,note);
            if(result.excerpt)row.append(make('span','',result.excerpt));
            if(result.field==='server-body' && this.detailTargets.has(cleanChatId(result.item.id))){
                const group=make('div','stmn-chat-search-candidate-row');
                const exact=button('정확한 #번호 찾기','stmn-chat-search-candidate-exact',()=>{
                    this.targetSelect.value=cleanChatId(result.item.id);
                    void this.searchDetailed();
                });
                group.append(row,exact);fragment.append(group);
            }else fragment.append(row);
        }
        if(!this.results.length)fragment.append(make('p','',
            '일치하는 결과가 없습니다. 다른 채팅이나 추가 검색을 이용해 보세요.'));
        this.list.replaceChildren(fragment);
    }

    async goToResult(result){
        if(this.controller || this.owner.busy || !this.isValid(this.scope))return;
        const scope=this.scope,item=result.item,index=result.index;
        if(!this.owner.buildings.some(x=>cleanChatId(x.id)===cleanChatId(item.id)) &&
           cleanChatId(this.owner.callbacks.context().chatId)!==cleanChatId(item.id))return;
        this.close();
        await this.owner.enter(item);
        const ctx=this.owner.callbacks.context();
        if(index!==null && buildingScope(ctx)===scope &&
           cleanChatId(ctx.chatId)===cleanChatId(item.id)){
            await this.owner.view.callbacks.goToIndex?.(index);
        }
    }

    /**
     * One explicit server-side candidate lookup. Does not download all chat
     * bodies or claim exact message numbers; the server searches current
     * message text with its own token matching rules.
     */
    async searchServer(){
        if(!this.opened || this.controller || this.owner.busy ||
           !this.body.checked || !this.isValid(this.scope))return false;
        let query;
        try{query=normalizeSearchQuery(this.input.value);}
        catch(error){this.status.textContent=error.message;return false;}
        const scope=this.scope,owner=this.owner;
        const candidates=selectLibraryChats(owner.buildings,scope,this.library.data,{
            view:'all',query:'',sort:owner.sort.value,
        });
        const indexed=new Map(candidates.map(item=>[cleanChatId(item.id),item]));
        const controller=new AbortController(),serial=++this.serial;
        this.controller=controller;
        this.searchButton.disabled=true;
        this.serverButton.disabled=true;
        this.detailButton.disabled=true;
        this.cancelButton.hidden=false;
        this.suggestion.hidden=true;
        this.nextButton.hidden=true;
        this.results=[];
        this.list.replaceChildren();
        this.status.textContent='SillyTavern 서버에서 본문 후보를 찾는 중… 서버에서 전체 채팅을 검사할 수 있습니다.';
        try{
            const found=await searchServerBodyCandidates({
                context:owner.callbacks.context,scope,buildings:owner.buildings,
                query,signal:controller.signal,
            });
            if(controller.signal.aborted || serial!==this.serial || !this.isValid(scope))
                return false;
            // Current chat's unsaved content may not exist on the server.
            const ctx=owner.callbacks.context();
            const active=cleanChatId(ctx.chatId);
            const local=projectChatMatches([
                {chat_metadata:ctx.chatMetadata||{}},...(ctx.chat||[]),
            ],{query,titles:false,body:true,limit:1});
            const ids=new Set(found);
            if(local.length && indexed.has(active))ids.add(active);
            const all=[...ids].filter(id=>indexed.has(id));
            this.results=all.slice(0,SEARCH_MAX_RESULTS).map(id=>({
                item:indexed.get(id),index:null,field:'server-body',
                title:'',excerpt:'채팅을 열어 위치를 확인하세요.',
            }));
            this.offset=0;
            this.renderResults();
            this.status.textContent='서버 본문 후보 '+all.length+
                '개 채팅 · '+this.results.length+'개 표시'+
                (all.length>SEARCH_MAX_RESULTS?' · 나머지 결과는 더 구체적인 검색어로 확인하세요.':'')+
                ' · 메시지 번호·사용자 제목·다른 스와이프 답변까지 검색한 결과는 아닙니다.';
            return true;
        }catch(error){
            if(serial===this.serial && this.isValid(scope)){
                this.status.textContent=aborted(error)?'서버 검색이 취소되었습니다.':
                    '서버 검색을 완료하지 못했습니다: '+(error?.message||'알 수 없음');
            }
            return false;
        }finally{
            if(this.controller===controller){
                this.controller=null;
                this.searchButton.disabled=false;
                this.serverButton.disabled=!this.body.checked;
                this.detailButton.disabled=!this.detailTargets.size;
                this.cancelButton.hidden=true;
            }
        }
    }

    /** Explicit scoped single-chat exact search. No persistent raw index. */
    async searchDetailed(){
        if(!this.opened || this.controller || this.owner.busy ||
           !this.isValid(this.scope))return false;
        let query;
        try{query=normalizeSearchQuery(this.input.value);}
        catch(error){this.status.textContent=error.message;return false;}
        const item=this.detailTargets.get(this.targetSelect.value);
        if(!item){
            this.status.textContent='현재 범위의 정밀 검색 대상 채팅을 선택해 주세요.';
            return false;
        }
        const config={titles:this.titles.checked,body:this.body.checked,
            swipes:this.detailSwipes.checked};
        if(!Object.values(config).some(Boolean)){
            this.status.textContent='제목·본문·다른 스와이프 중 하나 이상 선택해 주세요.';
            return false;
        }
        const scope=this.scope,controller=new AbortController(),serial=++this.serial;
        this.controller=controller;
        this.searchButton.disabled=this.serverButton.disabled=this.detailButton.disabled=true;
        this.cancelButton.hidden=false;this.nextButton.hidden=true;
        this.suggestion.hidden=true;
        this.results=[];this.list.replaceChildren();
        this.status.textContent='선택 채팅 정밀 검색 중… 최대 32MB에서 정확한 메시지 #번호를 확인합니다.';
        try{
            const found=await readDetailedChatMatches({
                context:this.owner.callbacks.context,scope,
                buildings:this.owner.buildings,item,query,
                titles:config.titles,body:config.body,swipes:config.swipes,
                signal:controller.signal,
                currentProjector:(chat,metadata,options)=>
                    this.activeIndex.search(chat,metadata,{
                        ...options,scope,chatId:cleanChatId(item.id),
                    }),
            });
            if(controller.signal.aborted || serial!==this.serial || !this.isValid(scope))
                return false;
            this.results=found.matches.map(match=>({...match,item}));
            this.offset=0;this.renderResults();
            this.suggestion.textContent='다른 채팅도 검색하기';
            this.suggestion.hidden=false;
            this.status.textContent='정밀 검색 '+item.name+' · '+
                found.scanned.toLocaleString()+'/'+found.total.toLocaleString()+
                '개 메시지 검사 · '+this.results.length+'개 위치'+
                (found.truncated?' · 첫 72개만 표시, 검색어를 구체화하세요.':' · 검사 완료')+
                (found.source==='current-memory'?' · 현재 채팅의 미저장 내용 반영':'')+
                ' · 스와이프 일치는 메시지 위치만 이동하며 현재 답변은 변경하지 않습니다.';
            return true;
        }catch(error){
            if(serial===this.serial && this.isValid(scope)){
                this.status.textContent=aborted(error)?'정밀 검색이 취소되었습니다.':
                    '정밀 검색 실패: '+(error?.message||'알 수 없음')+
                    ' · 원본 채팅은 수정하지 않았습니다.';
            }
            return false;
        }finally{
            if(this.controller===controller){
                this.controller=null;this.searchButton.disabled=false;
                this.serverButton.disabled=!this.body.checked;
                this.detailButton.disabled=!this.detailTargets.size;
                this.cancelButton.hidden=true;
            }
        }
    }

    async searchCurrent(query){
        const scope=this.scope,ctx=this.owner.callbacks.context();
        if(!this.isValid(scope) || this.controller)return false;
        const id=cleanChatId(ctx.chatId);
        const item=this.detailTargets.get(id) || {id,name:id||'현재 채팅'};
        if(!id || !Array.isArray(ctx.chat)){
            this.status.textContent='열려 있는 채팅이 없습니다.';
            return false;
        }
        const controller=new AbortController(),serial=++this.serial;
        this.controller=controller;
        this.searchButton.disabled=this.serverButton.disabled=this.detailButton.disabled=true;
        this.cancelButton.hidden=false;
        this.suggestion.hidden=true;
        this.nextButton.hidden=true;
        this.list.replaceChildren();
        this.results=[];
        this.status.textContent='현재 채팅에서 메시지를 확인하는 중…';
        try{
            const direct=/^#(\d+)$/.exec(query.trim());
            if(direct){
                const index=Number(direct[1]);
                if(Number.isSafeInteger(index) && index>=0 && index<ctx.chat.length){
                    this.results=[{item,index,type:'message',field:'number',
                        title:getTitle(ctx.chat[index],ctx.chatMetadata||{}),
                        excerpt:'메시지 번호 #'+index+'로 바로 이동'}];
                }
            }else{
                const found=await this.activeIndex.search(ctx.chat,ctx.chatMetadata||{},{
                    query,scope,chatId:id,
                    titles:this.titles.checked,body:this.body.checked,
                    swipes:this.swipeMain.checked,signal:controller.signal,
                    stillValid:()=>this.isValid(scope) &&
                        this.owner.callbacks.context().chat===ctx.chat &&
                        cleanChatId(this.owner.callbacks.context().chatId)===id,
                });
                if(serial!==this.serial || controller.signal.aborted || !this.isValid(scope))
                    return false;
                this.results=found.matches.map(match=>({...match,item}));
                this.status.textContent='현재 채팅 메시지 '+found.scanned+'/'+found.total+
                    '개 확인 · 정확한 위치 '+this.results.length+'개'+
                    (found.truncated?' · 첫 72개만 표시':'');
            }
            if(serial!==this.serial || controller.signal.aborted || !this.isValid(scope))
                return false;
            if(direct)this.status.textContent=this.results.length
                ?'메시지 #'+this.results[0].index+' 위치를 찾았습니다.'
                :'그 번호의 메시지가 없습니다.';
            this.offset=0;
            this.renderResults();
            this.suggestion.textContent='다른 채팅에서도 찾아보기';
            this.suggestion.hidden=false;
            return true;
        }catch(error){
            if(serial===this.serial && this.isValid(scope))
                this.status.textContent=aborted(error)?'검색이 취소되었습니다.':
                    '현재 채팅 검색 오류: '+(error?.message||'확인 불가');
            return false;
        }finally{
            if(this.controller===controller){
                this.controller=null;
                this.searchButton.disabled=false;
                this.serverButton.disabled=!this.body.checked;
                this.detailButton.disabled=!this.detailTargets.size;
                this.cancelButton.hidden=true;
            }
        }
    }

    async search(next=false){
        if(!this.opened || this.controller || this.owner.busy)return false;
        const scope=this.scope;
        if(!this.isValid(scope))return false;
        let query;
        try{query=normalizeSearchQuery(this.input.value);}
        catch(error){this.status.textContent=error.message;return false;}
        if(this.range==='current')return this.searchCurrent(query);
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
        this.serverButton.disabled=true;
        this.detailButton.disabled=true;
        this.cancelButton.hidden=false;
        this.suggestion.hidden=true;
        this.nextButton.hidden=true;
        if(!next)this.results=[];
        this.list.replaceChildren();
        this.suggestion.hidden=true;
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
                            const found=await this.activeIndex.search(ctx.chat,ctx.chatMetadata||{},{
                                query,scope,chatId:cleanChatId(item.id),
                                titles:config.titles,body:config.body,swipes:false,
                                limit:4,signal:controller.signal,
                                stillValid:()=>this.isValid(scope) &&
                                    this.owner.callbacks.context().chat===ctx.chat &&
                                    cleanChatId(this.owner.callbacks.context().chatId)===cleanChatId(item.id),
                            });
                            matches=found.matches;
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
                if(controller.signal.aborted || serial!==this.serial || !this.isValid(scope))
                    throw new DOMException('검색 취소','AbortError');
                // Throttle status writes and yield between small groups to keep
                // large metadata-only searches responsive to UI interactions.
                if(processed%3===0 || processed===candidates.length){
                    this.status.textContent=(from+processed)+' / '+items.length+
                        '개 채팅 확인 · 결과 '+this.results.length+'개';
                    await new Promise(resolve=>setTimeout(resolve,0));
                }
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
            this.suggestion.textContent='대용량 채팅도 찾아보기';
            this.suggestion.hidden=false;
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
                this.serverButton.disabled=!this.body.checked;
                this.detailButton.disabled=!this.detailTargets.size;
                this.cancelButton.hidden=true;
            }
        }
    }

    destroy(){this.close();this.activeIndex.clear();this.panel.remove();}
}
