/**
 * Q-04 Quiet chat eye interaction.
 * Tooltip is restricted to eye hover/focus. Clicking the eye opens a
 * separately scrollable FULL title directory with virtual rows.
 */
import {cleanChatId} from './building-data.js';
import {readChatPreview, ChatPreviewCache, CHAT_PREVIEW_ROW_HEIGHT} from './chat-preview.js';

const make=(tag,cls='',text)=>{
    const node=document.createElement(tag);
    if(cls) node.className=cls;
    if(text!==undefined) node.textContent=String(text);
    return node;
};
const button=(text,cls,handler)=>{
    const node=make('button',cls,text);node.type='button';
    node.addEventListener('click',handler);
    return node;
};
const aborted=error=>error?.name==='AbortError';

export class QuietChatPreviewUI {
    constructor(owner) {
        this.owner=owner;
        this.cache=new ChatPreviewCache();
        this.pending=null;
        this.hoverTimer=null;
        this.hoverSerial=0;
        this.detailSerial=0;
        this.detailKey=null;
        this.scope=null;
        this.destroyed=false;

        this.tooltip=make('aside','stmn-quiet-chat-tooltip');
        this.tooltip.setAttribute('role','tooltip');
        this.tooltip.hidden=true;
        document.body.append(this.tooltip);

        this.detail=make('section','stmn-quiet-chat-detail');
        this.detail.hidden=true;
        this.detail.setAttribute('role','region');
        this.detail.setAttribute('aria-label','채팅 전체 메시지 목차');
        const heading=make('div','stmn-quiet-chat-detail-header');
        const titleArea=make('div','stmn-quiet-chat-detail-headings');
        this.detailTitle=make('strong','','메시지 목차');
        this.detailCount=make('small','','');
        titleArea.append(this.detailTitle,this.detailCount);
        this.closeButton=button('×','stmn-quiet-chat-detail-close',()=>this.closeDetail());
        this.closeButton.setAttribute('aria-label','채팅 미리보기 닫기');
        heading.append(titleArea,this.closeButton);
        this.detailStatus=make('div','stmn-quiet-chat-detail-status','');
        this.detailList=make('div','stmn-quiet-chat-detail-list');
        this.detailList.tabIndex=0;
        this.detailList.setAttribute('aria-label','전체 메시지 목차 스크롤');
        this.detailSpacer=make('div','stmn-quiet-chat-detail-spacer');
        this.detailList.append(this.detailSpacer);
        this.detailList.addEventListener('scroll',()=>this.renderRange(),{passive:true});
        this.detail.append(heading,this.detailStatus,this.detailList);
        owner.contentArea.append(this.detail);

        this.onLobbyScroll=()=>this.hideTooltip();
        owner.buildingList.addEventListener('scroll',this.onLobbyScroll,{passive:true});
        this.onWindowResize=()=>this.hideTooltip();
        window.addEventListener('resize',this.onWindowResize,{passive:true});
        this.onEscape=event=>{
            if(event.key==='Escape' && !this.detail.hidden) {
                this.closeDetail();
                event.stopPropagation();
            }
        };
        this.detail.addEventListener('keydown',this.onEscape);
    }

    key(item) {
        return JSON.stringify([this.owner.scope,cleanChatId(item.id)]);
    }

    invalidate(scope=this.owner.scope) {
        this.hideTooltip();
        this.closeDetail();
        this.pending?.controller.abort();
        this.pending=null;
        this.cache.clear();
        this.scope=scope;
    }

    isCurrent(item,scope) {
        return !this.destroyed && this.owner.tab==='buildings' &&
            this.owner.view.root.dataset.elevatorTheme==='quiet' &&
            this.owner.scope===scope &&
            this.owner.buildings.some(x=>cleanChatId(x.id)===cleanChatId(item.id));
    }

    attachEye(eye,item) {
        eye.addEventListener('mouseenter',()=>{
            this.hideTooltip();
            const serial=++this.hoverSerial;
            this.hoverTimer=setTimeout(()=>{
                if(serial===this.hoverSerial) void this.showTooltip(eye,item,serial);
            },260);
        });
        eye.addEventListener('mouseleave',()=>this.hideTooltip());
        eye.addEventListener('focus',()=>{
            this.hideTooltip();
            const serial=++this.hoverSerial;
            void this.showTooltip(eye,item,serial);
        });
        eye.addEventListener('blur',()=>this.hideTooltip());
        eye.addEventListener('click',()=>void this.openDetail(item));
    }

    hideTooltip() {
        ++this.hoverSerial;
        if(this.hoverTimer!==null) clearTimeout(this.hoverTimer);
        this.hoverTimer=null;
        this.tooltip.hidden=true;
        // The detail panel may depend on this same in-flight request.
        if(this.pending && this.pending.key!==this.detailKey) this.pending.controller.abort();
    }

    async getPreview(item) {
        const key=this.key(item);
        const cached=this.cache.get(key);
        if(cached) return cached;
        if(this.pending?.key===key) return this.pending.promise;
        this.pending?.controller.abort();
        const scope=this.owner.scope;
        const controller=new AbortController();
        const ctx=this.owner.callbacks.context();
        const buildings=this.owner.buildings;
        const promise=readChatPreview(ctx,scope,buildings,item,{signal:controller.signal})
            .then(preview=>{
                if(this.isCurrent(item,scope) && !controller.signal.aborted) this.cache.set(key,preview);
                return preview;
            }).finally(()=>{
                if(this.pending?.controller===controller) this.pending=null;
            });
        this.pending={key,controller,promise};
        return promise;
    }

    anchorTooltip(eye) {
        const rect=eye.getBoundingClientRect();
        const width=this.tooltip.offsetWidth;
        this.tooltip.style.left=Math.max(8,Math.min(rect.left,window.innerWidth-width-8))+'px';
        this.tooltip.style.top=Math.max(8,rect.bottom+8)+'px';
        this.tooltip.style.maxHeight=Math.max(72,window.innerHeight-rect.bottom-18)+'px';
    }

    async showTooltip(eye,item,serial) {
        const scope=this.owner.scope;
        if(!eye.isConnected || !this.isCurrent(item,scope)) return;
        this.tooltip.replaceChildren(make('strong','','채팅 미리보기'),make('p','','불러오는 중…'));
        this.tooltip.hidden=false;
        this.anchorTooltip(eye);
        try {
            const preview=await this.getPreview(item);
            if(serial!==this.hoverSerial || !eye.isConnected || !this.isCurrent(item,scope)) return;
            this.tooltip.replaceChildren();
            this.tooltip.append(make('strong','','메시지 목록'));
            const list=make('div','stmn-quiet-chat-tooltip-titles');
            if(!preview.lastFive.length) list.append(make('span','','메시지가 없습니다.'));
            for(const entry of preview.lastFive) {
                const row=make('div','stmn-quiet-chat-tooltip-title');
                row.append(make('span','', '#'+entry.index),
                    make('span','',entry.title));
                list.append(row);
            }
            this.tooltip.append(list,make('div','stmn-quiet-chat-tooltip-divider'),
                make('strong','','마지막 메시지'),
                make('div','stmn-quiet-chat-tooltip-body',preview.excerpt || '(내용 없는 메시지)'));
            this.anchorTooltip(eye);
        } catch(error) {
            if(aborted(error) || serial!==this.hoverSerial || !eye.isConnected) return;
            this.tooltip.replaceChildren(make('strong','','채팅을 읽을 수 없습니다.'),
                make('p','',error?.message || '미리보기 오류'));
            this.anchorTooltip(eye);
        }
    }

    async openDetail(item) {
        const scope=this.owner.scope;
        if(!this.isCurrent(item,scope)) return;
        // Mark this target as a detail consumer BEFORE hiding the focus
        // tooltip. Otherwise a direct click can abort its shared in-flight
        // fetch and leave a blank detail view.
        const key=this.key(item);
        this.detailKey=key;
        this.hideTooltip();
        const serial=++this.detailSerial;
        this.detail.hidden=false;
        this.detailTitle.textContent=item.name;
        this.detailCount.textContent='';
        this.detailStatus.textContent='전체 메시지 목차를 불러오는 중…';
        this.detailList.hidden=true;
        this.detailSpacer.replaceChildren();
        try {
            const preview=await this.getPreview(item);
            if(serial!==this.detailSerial || !this.isCurrent(item,scope) || this.detailKey!==key) return;
            this.entries=preview.entries;
            this.activeItem=item;
            this.detailCount.textContent=preview.messageCount.toLocaleString()+'개 메시지';
            this.detailStatus.textContent='';
            this.detailList.hidden=false;
            this.detailSpacer.style.height=(this.entries.length*CHAT_PREVIEW_ROW_HEIGHT)+'px';
            this.detailList.scrollTop=0;
            this.renderRange();
            this.closeButton.focus();
        } catch(error) {
            if(serial!==this.detailSerial || aborted(error)) return;
            this.detailStatus.textContent=error?.message || '전체 목차를 불러오지 못했습니다.';
            this.detailList.hidden=true;
        }
    }

    renderRange() {
        if(this.detail.hidden || !this.entries?.length) {
            this.detailSpacer.replaceChildren();
            return;
        }
        const height=CHAT_PREVIEW_ROW_HEIGHT;
        const start=Math.max(0,Math.floor(this.detailList.scrollTop/height)-6);
        const end=Math.min(this.entries.length,
            Math.ceil((this.detailList.scrollTop+Math.max(1,this.detailList.clientHeight))/height)+7);
        const rows=document.createDocumentFragment();
        for(let i=start;i<end;i++) {
            const entry=this.entries[i];
            const row=button('','stmn-quiet-chat-detail-row',()=>{
                void this.goToEntry(entry.index);
            });
            row.style.top=(i*height)+'px';
            row.style.height=height+'px';
            row.title='#'+entry.index+' · '+entry.title;
            row.setAttribute('aria-label','#'+entry.index+' '+entry.title+' 채팅으로 이동');
            row.append(make('span','stmn-quiet-chat-detail-index','#'+entry.index),
                make('span','stmn-quiet-chat-detail-name',entry.title));
            rows.append(row);
        }
        this.detailSpacer.replaceChildren(rows);
    }

    async goToEntry(index) {
        const item=this.activeItem;
        if(!item || !Number.isInteger(index)) return;
        const scope=this.owner.scope;
        this.closeDetail();
        await this.owner.enter(item);
        const ctx=this.owner.callbacks.context();
        if (scope===this.owner.scope &&
            cleanChatId(ctx.chatId)===cleanChatId(item.id)) {
            await this.owner.view.callbacks.goToIndex?.(index);
        }
    }

    closeDetail() {
        ++this.detailSerial;
        this.detailKey=null;
        this.detail.hidden=true;
        this.entries=null;
        this.activeItem=null;
        this.detailSpacer.replaceChildren();
        if(this.pending) this.pending.controller.abort();
    }

    destroy() {
        this.destroyed=true;
        this.hideTooltip();
        this.closeDetail();
        this.cache.clear();
        this.owner.buildingList.removeEventListener('scroll',this.onLobbyScroll);
        window.removeEventListener('resize',this.onWindowResize);
        this.detail.removeEventListener('keydown',this.onEscape);
        this.tooltip.remove();
        this.detail.remove();
    }
}
