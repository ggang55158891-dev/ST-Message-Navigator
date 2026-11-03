/**
 * Quiet Elevator phase 1: lightweight, opt-in information architecture.
 * This module only reorganizes access to EXISTING operations. It does not
 * create preview data, edit chat records, or change SillyTavern messages.
 */
const make = (tag, className = '', text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

function action(label, symbol, onClick, className = 'stmn-quiet-action') {
    const b = make('button', className, symbol);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
}

export class QuietShell {
    constructor(elevator) {
        this.elevator = elevator;
        this.view = elevator.view;
        this.root = elevator.view.root;
        this.searchOpen = false;
        this.manageOpen = false;
        this.activeTab = 'floors';

        const header = this.view.panel.querySelector('.stmn-outline-header');
        this.headerActions = make('div', 'stmn-quiet-header-actions');
        this.searchButton = action('검색 열기', '⌕', () => this.toggleSearch());
        this.globalMenu = make('details', 'stmn-quiet-global');
        const globalSummary = make('summary', '', '···');
        globalSummary.title = '전체 메뉴';
        globalSummary.setAttribute('aria-label', '전체 메뉴');
        const globalItems = make('div', 'stmn-quiet-menu');
        globalItems.append(
            action('화면·조작 설정', '화면·조작 설정', () => this.openSettings('appearance'), 'stmn-quiet-menu-item'),
            action('백업·복원', '백업·복원', () => this.openSettings('backup'), 'stmn-quiet-menu-item'),
            action('진단·데이터 점검', '진단·데이터 점검', () => this.openSettings('diagnostics'), 'stmn-quiet-menu-item'),
        );
        this.globalMenu.append(globalSummary, globalItems);
        this.headerActions.append(this.searchButton, this.globalMenu);
        header.insertBefore(this.headerActions, header.querySelector('.stmn-close'));

        this.toolbar = make('div', 'stmn-quiet-toolbar');
        this.context = make('span', 'stmn-quiet-context', '');
        this.listMenu = make('details', 'stmn-quiet-list-menu');
        const listSummary = make('summary', '', '☷');
        listSummary.title = '목록 정렬·필터';
        listSummary.setAttribute('aria-label', '목록 메뉴');
        this.menuContent = make('div', 'stmn-quiet-menu stmn-quiet-list-content');
        this.listMenu.append(listSummary, this.menuContent);
        this.toolbar.append(this.context, this.listMenu);
        elevator.tabs.after(this.toolbar);

        this.onOutsidePointerDown = event => {
            if (!this.globalMenu.contains(event.target)) this.globalMenu.open = false;
            if (!this.listMenu.contains(event.target)) this.listMenu.open = false;
        };
        this.onKeyDown = event => {
            if (event.key === 'Escape') {
                if (this.globalMenu.open || this.listMenu.open) {
                    this.globalMenu.open = false;
                    this.listMenu.open = false;
                    event.stopPropagation();
                } else if (this.searchOpen && !this.view.editing) {
                    this.toggleSearch(false);
                    event.stopPropagation();
                }
            }
        };
        document.addEventListener('pointerdown', this.onOutsidePointerDown);
        document.addEventListener('keydown', this.onKeyDown, true);
        this.setTab('floors');
        this.refresh();
    }

    get isQuiet() {
        return this.root.dataset.elevatorTheme === 'quiet';
    }

    toggleSearch(force) {
        if (!this.isQuiet) return;
        this.searchOpen = typeof force === 'boolean' ? force : !this.searchOpen;
        if (!this.searchOpen) {
            // A hidden nonempty query is confusing. Closing search resets it.
            const input = this.activeTab === 'buildings' ? this.elevator.search : this.view.search;
            if (input.value) {
                input.value = '';
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
        this.refresh();
        if (this.searchOpen) {
            const input = this.activeTab === 'buildings' ? this.elevator.search : this.view.search;
            input.focus();
        }
    }

    setTab(tab) {
        this.activeTab = tab === 'buildings' ? 'buildings' : 'floors';
        this.searchOpen = false;
        this.listMenu.open = false;
        this.globalMenu.open = false;
        this.refresh();
    }

    refresh() {
        if (!this.root.isConnected && this.elevator.tab == null) return;
        this.root.dataset.quietSearch = this.searchOpen ? 'open' : 'closed';
        this.root.dataset.quietManage = this.manageOpen ? 'open' : 'closed';
        this.context.textContent = this.activeTab === 'buildings'
            ? '채팅 라이브러리'
            : '메시지 ' + (this.view.entries?.length || 0) + '개';
        this.menuContent.replaceChildren();
        if (this.activeTab === 'floors') {
            this.menuContent.append(
                make('div', 'stmn-quiet-menu-label', '메시지 목차'),
                action('모두 펼치기', '모두 펼치기', () => {
                    this.view.expandAllButton.click();
                    this.listMenu.open = false;
                }, 'stmn-quiet-menu-item'),
                action('모두 접기', '모두 접기', () => {
                    this.view.collapseAllButton.click();
                    this.listMenu.open = false;
                }, 'stmn-quiet-menu-item'),
            );
        } else {
            this.menuContent.append(make('div', 'stmn-quiet-menu-label', '채팅 정렬'));
            const select = make('select', 'stmn-quiet-sort');
            select.setAttribute('aria-label', 'Quiet 채팅 정렬');
            for (const option of this.elevator.sort.options) {
                const copy = make('option', '', option.textContent);
                copy.value = option.value;
                select.append(copy);
            }
            select.value = this.elevator.sort.value;
            select.addEventListener('change', () => {
                this.elevator.sort.value = select.value;
                this.elevator.sort.dispatchEvent(new Event('change', { bubbles: true }));
                this.listMenu.open = false;
            });
            this.menuContent.append(select, make('div', 'stmn-quiet-menu-label', '채팅 보기'));
            for (const [value, name] of [
                ['all', '전체 채팅'],
                ['folders', '폴더별 보기'],
                ['favorites', '즐겨찾기'],
            ]) {
                this.menuContent.append(action(name, name, () => {
                    const ui = this.elevator.libraryUI;
                    ui.viewSelect.value = value;
                    ui.viewSelect.dispatchEvent(new Event('change', { bubbles: true }));
                    this.listMenu.open = false;
                    if (value === 'folders') this.toggleManage(true);
                }, 'stmn-quiet-menu-item'));
            }
            this.menuContent.append(make('div', 'stmn-quiet-menu-separator'));
            this.menuContent.append(action('폴더·태그 관리', '폴더·태그 관리', () => {
                this.toggleManage();
                this.listMenu.open = false;
            }, 'stmn-quiet-menu-item'));
            this.menuContent.append(action('목록 새로고침', '목록 새로고침', () => {
                void this.elevator.refreshBuildings(true);
                this.listMenu.open = false;
            }, 'stmn-quiet-menu-item'));
        }
    }

    toggleManage(force) {
        if (!this.isQuiet) return;
        this.manageOpen = typeof force === 'boolean' ? force : !this.manageOpen;
        this.root.dataset.quietManage = this.manageOpen ? 'open' : 'closed';
        if (this.manageOpen) {
            // The original D-stage editor remains the source of truth.
            const manage = this.elevator.libraryUI.controls.querySelector('.stmn-library-manage');
            if (manage) manage.open = true;
        }
    }

    openSettings(section) {
        this.globalMenu.open = false;
        const settings = document.getElementById('stmn-settings');
        if (!settings) {
            this.view.setStatus('SillyTavern의 확장 설정에서 엘리베이터를 찾아주세요.');
            return;
        }
        const parent = settings.querySelector('details');
        if (parent) parent.open = true;
        let target = settings;
        if (section === 'backup') {
            target = settings.querySelector('.stmn-backup-settings, .stmn-library-settings') || settings;
        } else if (section === 'diagnostics') {
            target = settings.querySelector('.stmn-diagnostics-settings') || settings;
        }
        if (target.tagName === 'DETAILS') target.open = true;
        target.scrollIntoView?.({ block: 'nearest' });
        this.view.setStatus('SillyTavern 확장 설정에서 해당 항목을 확인할 수 있습니다.');
    }

    destroy() {
        document.removeEventListener('pointerdown', this.onOutsidePointerDown);
        document.removeEventListener('keydown', this.onKeyDown, true);
    }
}
