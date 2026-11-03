/**
 * Q-06. One small tool in SillyTavern's existing .mes_buttons row.
 * Expensive operations happen only while the explicit dialog is open.
 * This module never touches native swipe buttons, bodies or edit controls.
 */
import {markedSwipes} from './swipe-marks.js';

const el=(tag,cls='',text)=>{
    const node=document.createElement(tag);
    if(cls) node.className=cls;
    if(text!==undefined)node.textContent=String(text);
    return node;
};
const button=(text,cls='',callback)=>{
    const b=el('button',cls,text);b.type='button';
    if(callback)b.addEventListener('click',callback);
    return b;
};
const MAX_VISIBLE_BATCH=24;

export class SwipeManagerUI {
    constructor({context,selectSwipe,saveMark,status}) {
        this.callbacks={context,selectSwipe,saveMark,status};
        this.chatElement=null;
        this.observer=null;
        this.current=null;
        this.filter='all';
        this.tagFilter='';
        this.comparison=new Set();
        this.visibleCount=MAX_VISIBLE_BATCH;
        this.busy=false;
        this.destroyed=false;
        this.previousFocus=null;
        this.overlay=el('div','stmn-swipe-overlay');
        this.overlay.hidden=true;
        this.overlay.addEventListener('mousedown',event=>{
            if(event.target===this.overlay)this.close();
        });
        this.dialog=el('section','stmn-swipe-dialog');
        this.dialog.setAttribute('role','dialog');
        this.dialog.setAttribute('aria-modal','true');
        this.dialog.setAttribute('aria-label','스와이프 관리');
        const header=el('header','stmn-swipe-header');
        const heading=el('div','stmn-swipe-heading');
        this.title=el('strong','','스와이프 관리');
        this.subtitle=el('small','','');
        heading.append(this.title,this.subtitle);
        this.closeButton=button('×','stmn-swipe-close',()=>this.close());
        this.closeButton.setAttribute('aria-label','스와이프 관리 닫기');
        header.append(heading,this.closeButton);
        this.toolbar=el('div','stmn-swipe-toolbar');
        this.allButton=button('전체','stmn-swipe-filter',()=>{this.filter='all';this.render();});
        this.favoriteButton=button('★ 즐겨찾기','stmn-swipe-filter',()=>{this.filter='favorites';this.render();});
        this.tagSelect=el('select','stmn-swipe-filter-tags');
        this.tagSelect.setAttribute('aria-label','스와이프 태그로 필터');
        this.tagSelect.addEventListener('change',()=>{
            this.filter='tags';this.tagFilter=this.tagSelect.value;this.render();
        });
        this.toolbar.append(this.allButton,this.favoriteButton,this.tagSelect);
        this.status=el('div','stmn-swipe-feedback');
        this.status.setAttribute('role','status');
        this.list=el('div','stmn-swipe-list');
        this.list.tabIndex=0;
        this.list.setAttribute('aria-label','스와이프 목록');
        this.compare=el('div','stmn-swipe-compare');
        this.compare.setAttribute('aria-label','두 스와이프 비교');
        this.dialog.append(header,this.toolbar,this.status,this.compare,this.list);
        this.overlay.append(this.dialog);
        document.body.append(this.overlay);
        this.onKeydown=event=>{
            if(this.overlay.hidden)return;
            if(event.key==='Escape'){event.preventDefault();this.close();}
        };
        document.addEventListener('keydown',this.onKeydown,true);
    }

    bind(chatElement) {
        if(this.chatElement===chatElement)return;
        this.observer?.disconnect();
        this.chatElement=chatElement;
        this.close();
        if(!chatElement)return;
        this.scan(chatElement);
        this.observer=new MutationObserver(changes=>{
            // Ignore streaming text mutations (which can occur dozens of times
            // per second); watch native toolbars and message nodes only.
            const candidates=new Set();
            for(const change of changes){
                if(!change.addedNodes.length)continue;
                if(change.target.closest?.('.mes_text'))continue;
                for(const node of change.addedNodes) {
                    if(node.nodeType!==1)continue;
                    if(node.classList?.contains('stmn-swipe-tool'))continue;
                    if(node.matches?.('.mes'))candidates.add(node);
                    else if(node.matches?.('.mes_buttons') || node.querySelector?.('.mes_buttons')) {
                        const root=node.closest?.('.mes');
                        if(root)candidates.add(root);
                        else for(const row of node.querySelectorAll?.('.mes')||[])candidates.add(row);
                    }
                }
            }
            for(const row of candidates)this.mountButton(row);
        });
        this.observer.observe(chatElement,{childList:true,subtree:true});
    }

    scan(chat=this.chatElement) {
        if(!chat)return;
        for(const row of chat.querySelectorAll(':scope > .mes[mesid]'))this.mountButton(row);
    }

    mountButton(row) {
        if(this.destroyed || !row?.isConnected)return;
        const idx=Number(row.getAttribute('mesid'));
        const ctx=this.callbacks.context();
        if(!Number.isSafeInteger(idx) || idx<0 ||
           !Array.isArray(ctx.chat?.[idx]?.swipes) || !ctx.chat[idx].swipes.length) return;
        const toolbar=row.querySelector('.mes_buttons');
        if(!toolbar || toolbar.querySelector('.stmn-swipe-tool'))return;
        const b=button('','stmn-swipe-tool',()=>{
            const now=Number(row.getAttribute('mesid'));
            if(Number.isSafeInteger(now))this.open(now,b);
        });
        b.setAttribute('aria-label','메시지 #'+idx+' 스와이프 관리');
        b.title='스와이프 즐겨찾기 · 태그 · 비교';
        const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
        svg.setAttribute('viewBox','0 0 24 24');
        svg.setAttribute('width','17');svg.setAttribute('height','17');
        svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');
        svg.setAttribute('stroke-width','1.7');svg.setAttribute('stroke-linecap','round');
        svg.setAttribute('stroke-linejoin','round');
        for(const pathDef of ['M4 6h16','M4 12h16','M4 18h16']){
            const path=document.createElementNS('http://www.w3.org/2000/svg','path');
            path.setAttribute('d',pathDef);svg.append(path);
        }
        b.append(svg);
        toolbar.append(b);
    }

    open(index,trigger=null) {
        const ctx=this.callbacks.context();
        if(!ctx.chatId || !Array.isArray(ctx.chat?.[index]?.swipes))return;
        this.current={chat:ctx.chat,chatId:ctx.chatId,index};
        this.previousFocus=trigger||document.activeElement;
        this.filter='all';this.tagFilter='';
        this.comparison.clear();
        this.visibleCount=MAX_VISIBLE_BATCH;
        this.overlay.hidden=false;
        this.render();
        this.closeButton.focus();
    }

    isCurrent() {
        if(!this.current)return false;
        const ctx=this.callbacks.context();
        return ctx.chat===this.current.chat && ctx.chatId===this.current.chatId &&
            !!ctx.chat?.[this.current.index];
    }

    notify(message,error=false) {
        this.status.textContent=message;
        this.status.dataset.error=String(error);
        this.callbacks.status?.(message,error);
    }

    snapshot() {
        if(!this.isCurrent())return [];
        const ctx=this.callbacks.context();
        return markedSwipes(ctx.chat[this.current.index],ctx.chatMetadata);
    }

    async mutate(swipeIndex,patch) {
        if(this.busy || !this.isCurrent())return;
        this.busy=true;
        try {
            const result=await this.callbacks.saveMark(this.current.index,swipeIndex,patch);
            if(result!==false && this.isCurrent())this.notify('스와이프 관리 정보를 저장했습니다.');
        } catch(error) {
            this.notify(error?.message||'저장에 실패했습니다.',true);
        } finally {
            this.busy=false;
            if(this.isCurrent())this.render();
            else this.close();
        }
    }

    async apply(swipeIndex) {
        if(this.busy || !this.isCurrent())return;
        this.busy=true;
        try {
            const applied=await this.callbacks.selectSwipe(this.current.index,swipeIndex);
            if(!applied)throw new Error('스와이프 적용에 실패했습니다.');
            this.notify('스와이프 #'+(swipeIndex+1)+'을 현재 답변으로 선택했습니다.');
        } catch(error) {
            this.notify(error?.message||'적용에 실패했습니다.',true);
        } finally {
            this.busy=false;
            if(this.isCurrent())this.render();
            else this.close();
        }
    }

    render() {
        if(!this.isCurrent()){this.close();return;}
        const all=this.snapshot();
        const tags=[...new Set(all.flatMap(item=>item.tags))].sort((a,b)=>a.localeCompare(b));
        const previousTag=this.tagFilter;
        this.tagSelect.replaceChildren();
        const defaultOption=el('option','','태그별 보기');
        defaultOption.value='';this.tagSelect.append(defaultOption);
        for(const tag of tags){const option=el('option','',tag);option.value=tag;this.tagSelect.append(option);}
        if(tags.includes(previousTag))this.tagSelect.value=previousTag;
        else {this.tagFilter='';if(this.filter==='tags')this.filter='all';}
        this.allButton.setAttribute('aria-pressed',String(this.filter==='all'));
        this.favoriteButton.setAttribute('aria-pressed',String(this.filter==='favorites'));
        this.title.textContent='메시지 #'+this.current.index+' · 스와이프';
        this.subtitle.textContent=all.length+'개 답변 · ★ '+all.filter(x=>x.favorite).length+'개';
        let shown=all.filter(item=>this.filter==='all' ||
            (this.filter==='favorites' && item.favorite) ||
            (this.filter==='tags' && item.tags.includes(this.tagFilter)));
        const oldScroll=this.list.scrollTop;
        const fragment=document.createDocumentFragment();
        if(!shown.length)fragment.append(el('p','stmn-swipe-empty','이 조건에 맞는 스와이프가 없습니다.'));
        for(const item of shown.slice(0,this.visibleCount)){
            const card=el('article','stmn-swipe-card');
            card.dataset.swipeIndex=String(item.index);
            const top=el('div','stmn-swipe-card-head');
            const heading=el('strong','','#'+(item.index+1)+(item.current?' · 현재 답변':''));
            const actions=el('div','stmn-swipe-card-actions');
            const favorite=button(item.favorite?'★':'☆','stmn-swipe-star',()=>
                void this.mutate(item.index,{favorite:!item.favorite}));
            favorite.setAttribute('aria-label','스와이프 #'+(item.index+1)+' 즐겨찾기');
            favorite.setAttribute('aria-pressed',String(item.favorite));
            const compare=el('label','stmn-swipe-check');
            const checkbox=el('input');checkbox.type='checkbox';
            checkbox.checked=this.comparison.has(item.index);
            checkbox.setAttribute('aria-label','스와이프 #'+(item.index+1)+' 비교 선택');
            checkbox.addEventListener('change',()=>{
                if(checkbox.checked) {
                    if(this.comparison.size>=2){checkbox.checked=false;this.notify('두 개의 스와이프만 비교할 수 있습니다.',true);return;}
                    this.comparison.add(item.index);
                } else this.comparison.delete(item.index);
                this.renderComparison(all);
            });
            compare.append(checkbox,el('span','','비교'));
            actions.append(favorite,compare);
            top.append(heading,actions);
            const preview=el('div','stmn-swipe-card-text',item.text);
            preview.tabIndex=0;
            // Long texts are independently scrollable and remain complete.
            const tagsLine=el('div','stmn-swipe-tags');
            for(const tag of item.tags) tagsLine.append(el('span','stmn-swipe-tag',tag));
            const foot=el('div','stmn-swipe-card-foot');
            const edit=button('태그 편집','stmn-swipe-edit',()=>{
                const old=card.querySelector('.stmn-swipe-tag-editor');
                if(old){old.remove();return;}
                const form=el('form','stmn-swipe-tag-editor');
                const field=el('input');field.type='text';field.maxLength=200;
                field.value=item.tags.join(', ');
                field.placeholder='태그 입력 · 쉼표로 구분 (최대 6개)';
                field.setAttribute('aria-label','스와이프 #'+(item.index+1)+' 태그 수정');
                const save=button('저장','',()=>{});
                save.type='submit';
                form.append(field,save);
                form.addEventListener('submit',event=>{
                    event.preventDefault();
                    const tags=field.value.split(',').map(x=>x.trim()).filter(Boolean);
                    void this.mutate(item.index,{tags});
                });
                card.append(form);field.focus();
            });
            foot.append(edit);
            if(!item.current){
                const apply=button('이 답변 적용','stmn-swipe-apply',()=>void this.apply(item.index));
                apply.setAttribute('aria-label','스와이프 #'+(item.index+1)+' 현재 답변으로 적용');
                foot.append(apply);
            }
            card.append(top,preview,tagsLine,foot);
            fragment.append(card);
        }
        if(shown.length>this.visibleCount)fragment.append(button(
            '더 보기 · '+(shown.length-this.visibleCount)+'개 남음','stmn-swipe-more',()=>{
                this.visibleCount+=MAX_VISIBLE_BATCH;this.render();
            }));
        this.list.replaceChildren(fragment);
        this.list.scrollTop=oldScroll;
        this.renderComparison(all);
    }

    renderComparison(all) {
        this.compare.replaceChildren();
        const compared=all.filter(item=>this.comparison.has(item.index));
        if(!compared.length)return;
        this.compare.append(el('strong','stmn-swipe-compare-title',
            compared.length===2?'선택한 두 답변 비교':'비교할 답변을 하나 더 선택해 주세요'));
        if(compared.length!==2)return;
        const columns=el('div','stmn-swipe-compare-columns');
        for(const item of compared){
            const col=el('section','stmn-swipe-compare-column');
            col.append(el('strong','','스와이프 #'+(item.index+1)),
                el('div','stmn-swipe-compare-text',item.text));
            columns.append(col);
        }
        this.compare.append(columns);
    }

    close() {
        if(!this.current && this.overlay.hidden)return;
        this.overlay.hidden=true;
        this.current=null;
        this.comparison.clear();
        this.list.replaceChildren();
        this.compare.replaceChildren();
        this.status.textContent='';
        if(this.previousFocus?.isConnected)this.previousFocus.focus({preventScroll:true});
        this.previousFocus=null;
    }

    destroy() {
        this.destroyed=true;
        this.observer?.disconnect();
        this.close();
        this.chatElement?.querySelectorAll('.stmn-swipe-tool').forEach(b=>b.remove());
        document.removeEventListener('keydown',this.onKeydown,true);
        this.overlay.remove();
    }
}
