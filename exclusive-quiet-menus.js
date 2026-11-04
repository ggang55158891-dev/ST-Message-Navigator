/**
 * Q-12: exactly one Quiet per-item <details> menu at a time.
 * Delegated listeners continue to work when the virtual message list or the
 * chat cards rerender. Nothing outside the extension root is modified.
 */
export const QUIET_ITEM_MENU_SELECTOR=
    'details.stmn-quiet-message-menu,details.stmn-quiet-item-menu';
export class ExclusiveQuietMenus{
    constructor(root){
        this.root=root;
        this.click=event=>{
            const target=event.target instanceof Element?event.target:null;
            if(!target)return;
            const menu=target.closest(QUIET_ITEM_MENU_SELECTOR);
            const summary=target.closest('summary');
            if(menu && this.root.contains(menu) && summary?.parentElement===menu){
                // Runs in the capture phase, before the native summary toggles.
                // A second menu's button stays clickable because popovers sit
                // to the LEFT of their summary column, not over it.
                this.closeExcept(menu);
            }else if(!menu || !this.root.contains(menu)){
                this.closeExcept(null);
            }
        };
        this.toggle=event=>{
            const menu=event.target;
            if(menu instanceof HTMLDetailsElement && menu.matches(QUIET_ITEM_MENU_SELECTOR) &&
               menu.open && this.root.contains(menu))
                this.closeExcept(menu);
        };
        this.keydown=event=>{
            if(event.key!=='Escape')return;
            const active=[...this.root.querySelectorAll(QUIET_ITEM_MENU_SELECTOR)].find(menu=>menu.open);
            if(!active)return;
            this.closeExcept(null);
            event.preventDefault();
            event.stopImmediatePropagation();
            active.querySelector(':scope > summary')?.focus({preventScroll:true});
        };
        document.addEventListener('click',this.click,true);
        this.root.addEventListener('toggle',this.toggle,true);
        document.addEventListener('keydown',this.keydown,true);
    }
    closeExcept(except){
        for(const menu of this.root.querySelectorAll(QUIET_ITEM_MENU_SELECTOR)){
            if(menu!==except && menu.open)menu.open=false;
        }
    }
    destroy(){
        document.removeEventListener('click',this.click,true);
        this.root.removeEventListener('toggle',this.toggle,true);
        document.removeEventListener('keydown',this.keydown,true);
    }
}
