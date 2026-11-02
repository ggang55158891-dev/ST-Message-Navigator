import { buildingScope, cleanChatId } from './building-data.js';
import { LibraryLobby } from './library-ui.js';
import { emptyLibrary } from './library-data.js';

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
}
function button(label, className, handler) {
    const node = element('button', className, label);
    node.type = 'button';
    node.addEventListener('click', handler);
    return node;
}

export class ElevatorPanel {
    constructor(view, callbacks) {
        this.view = view;
        this.callbacks = callbacks;
        this.tab = 'floors';
        this.buildings = [];
        this.scope = null;
        this.busy = false;
        this.loading = false;
        this.lastLoaded = 0;
        this.requestId = 0;

        view.panel.setAttribute('aria-label', '엘리베이터: 메시지 층과 채팅 건물');
        const header = view.panel.querySelector('.stmn-outline-header');
        const title = header?.querySelector('.stmn-heading');
        if (title) title.textContent = '엘리베이터';

        this.dashboard = element('div', 'stmn-elevator-dashboard');
        const directory = element('div', 'stmn-elevator-directory');
        directory.append(element('span', 'stmn-elevator-mini-label', 'CURRENT BUILDING'));
        this.buildingName = element('strong', 'stmn-elevator-building', '건물 없음');
        directory.append(this.buildingName);
        const level = element('div', 'stmn-elevator-level');
        level.append(element('span', 'stmn-elevator-mini-label', 'FLOOR'));
        this.floor = element('strong', 'stmn-elevator-floor', '#—');
        level.append(this.floor);
        this.dashboard.append(directory, level);

        this.tabs = element('div', 'stmn-elevator-tabs');
        this.tabs.setAttribute('role', 'tablist');
        this.floorTab = button('층 안내', 'stmn-elevator-tab', () => this.setTab('floors'));
        this.buildingTab = button('건물 로비', 'stmn-elevator-tab', () => this.setTab('buildings'));
        this.floorTab.setAttribute('role', 'tab');
        this.buildingTab.setAttribute('role', 'tab');
        this.floorTab.id = 'stmn-elevator-tab-floors';
        this.buildingTab.id = 'stmn-elevator-tab-buildings';
        this.tabs.append(this.floorTab, this.buildingTab);

        this.buildingsPane = element('div', 'stmn-buildings-pane');
        this.buildingsPane.id = 'stmn-buildings-pane';
        this.buildingsPane.setAttribute('role', 'tabpanel');
        this.buildingsPane.setAttribute('aria-labelledby', this.buildingTab.id);
        this.buildingsPane.hidden = true;
        const intro = element('div', 'stmn-building-intro');
        intro.append(element('strong', '', '다른 건물로 이동'));
        this.buildingsCount = element('span', 'stmn-building-count', '');
        intro.append(this.buildingsCount);
        const controls = element('div', 'stmn-building-controls');
        this.search = element('input', 'stmn-building-search');
        this.search.type = 'search';
        this.search.placeholder = '채팅 이름·별명·폴더·태그 검색';
        this.search.setAttribute('aria-label', '건물 검색');
        this.search.addEventListener('input', () => this.renderBuildings());
        this.sort = element('select', 'stmn-building-sort');
        this.sort.setAttribute('aria-label', '건물 정렬');
        for (const [value, label] of [['recent','최근 활동'],['created','생성일'],['folders','폴더별 · 최근순'],['name','이름순']]) {
            const option = element('option', '', label);
            option.value = value;
            this.sort.append(option);
        }
        this.sort.addEventListener('change', () => this.renderBuildings());
        controls.append(this.search, this.sort);
        const toolbar = element('div', 'stmn-building-toolbar');
        this.scopeLabel = element('span', '', '현재 캐릭터 또는 그룹');
        const refresh = button('↻ 새로고침', 'stmn-building-refresh', () => void this.refreshBuildings(true));
        toolbar.append(this.scopeLabel, refresh);
        this.buildingList = element('div', 'stmn-building-list');
        this.buildingList.setAttribute('role', 'list');
        this.hint = element('div', 'stmn-building-hint', '건물은 채팅 파일 하나를 뜻해요. 각 건물 안의 메시지가 층이 됩니다.');
        this.buildingsPane.append(intro, controls, toolbar, this.buildingList, this.hint);
        this.libraryUI = new LibraryLobby(this);

        header.after(this.dashboard, this.tabs);
        view.footer.before(this.buildingsPane);
        this.updateFloor(view.currentIndex);
        this.applyTheme(callbacks.getTheme?.(), callbacks.getSkyMode?.());
        this.setTab('floors');
    }

    applyTheme(theme, skyMode) {
        const themes = ['classic', 'restricted', 'sky'];
        const skyModes = ['auto', 'day', 'night'];
        this.view.root.dataset.elevatorTheme = themes.includes(theme) ? theme : 'classic';
        this.view.root.dataset.elevatorSky = skyModes.includes(skyMode) ? skyMode : 'auto';
    }

    updateFloor(index) {
        const context = this.callbacks.context();
        const selected = context.groupId != null && context.groupId !== ''
            ? (context.groups || []).find(group => String(group.id) === String(context.groupId))
            : context.characters?.[context.characterId];
        const name = cleanChatId(context.chatId);
        this.buildingName.textContent = this.libraryUI?.getAlias(buildingScope(context),name) || name || selected?.name || '선택된 채팅 없음';
        this.buildingName.title = name;
        this.floor.textContent = Number.isInteger(index) && index >= 0 ? '#' + index : '#—';
        this.floor.title = '현재 메시지 번호';
    }

    setTab(tab) {
        this.tab = tab === 'buildings' ? 'buildings' : 'floors';
        const buildings = this.tab === 'buildings';
        this.floorTab.setAttribute('aria-selected', String(!buildings));
        this.buildingTab.setAttribute('aria-selected', String(buildings));
        this.floorTab.classList.toggle('stmn-elevator-active-tab', !buildings);
        this.buildingTab.classList.toggle('stmn-elevator-active-tab', buildings);
        this.view.caption.hidden = buildings;
        this.view.searchbox.hidden = buildings;
        this.view.list.hidden = buildings;
        this.view.outlineJumps.hidden = buildings;
        this.view.groupTools.hidden = buildings;
        this.buildingsPane.hidden = !buildings;
        if (!buildings) {
            this.view.applyFilter({ resetScroll: false });
            this.view.renderRows(true);
        } else {
            const scope = buildingScope(this.callbacks.context());
            if (this.scope !== scope || Date.now() - this.lastLoaded > 60000) {
                void this.refreshBuildings();
            } else {
                this.renderBuildings();
            }
        }
        this.view.position(this.view.side);
    }

    async refreshBuildings(force = false) {
        if (this.loading && !force) return;
        const context = this.callbacks.context();
        const requestedScope = buildingScope(context);
        const id = ++this.requestId;
        const started = Date.now();
        this.callbacks.logDiagnostic?.('chat-switch', 'list_started', { status: 'started' });
        this.loading = true;
        this.buildingList.replaceChildren(element('p','stmn-building-empty','건물 목록을 불러오는 중…'));
        try {
            const result = await this.callbacks.listBuildings(context);
            if (id !== this.requestId || requestedScope !== buildingScope(this.callbacks.context())) return;
            const library = this.callbacks.readLibrary?.() || emptyLibrary();
            this.buildings = result.buildings || [];
            this.scope = result.scope;
            this.libraryUI.setData(library, result.scope);
            this.scopeLabel.textContent = result.title || '현재 캐릭터 또는 그룹';
            this.lastLoaded = Date.now();
            this.callbacks.logDiagnostic?.('chat-switch', 'list_completed', { status: 'ok', count: this.buildings.length, durationMs: Date.now() - started });
            this.renderBuildings();
            this.updateFloor(this.view.currentIndex);
        } catch (error) {
            if (id !== this.requestId) return;
            this.libraryUI.data = null;
            this.libraryUI.controls.hidden = true;
            this.callbacks.logDiagnostic?.('chat-switch', 'list_failed', { status: 'error', error, durationMs: Date.now() - started });
            this.buildingList.replaceChildren(element('p', 'stmn-building-empty',
                '건물 목록을 불러오지 못했어요: ' + (error?.message || '알 수 없는 오류')));
            console.warn('[STMN Elevator] building list error', error);
        } finally {
            if (id === this.requestId) this.loading = false;
        }
    }

    renderBuildings() {
        this.libraryUI.draw();
    }

    async enter(item) {
        if (this.busy) return;
        const before = this.callbacks.context();
        const startingScope = buildingScope(before);
        const target = cleanChatId(item.id);
        if (!target) return;
        if (cleanChatId(before.chatId) === target) {
            this.setTab('floors');
            return;
        }
        this.busy = true;
        const started = Date.now();
        this.callbacks.logDiagnostic?.('chat-switch', 'switch_started', { status: 'started' });
        this.renderBuildings();
        this.view.setStatus('엘리베이터 이동 중 · ' + item.name);
        try {
            await this.callbacks.enterBuilding(before, target);
            const current = this.callbacks.context();
            if (startingScope !== buildingScope(current) || cleanChatId(current.chatId) !== target) {
                throw new Error('전환을 완료하지 못했습니다. 현재 채팅 상태를 확인해 주세요.');
            }
            this.view.rebuild();
            this.updateFloor(this.view.currentIndex);
            this.setTab('floors');
            this.view.setStatus('새 건물 도착 · ' + item.name);
            this.callbacks.logDiagnostic?.('chat-switch', 'switch_completed', { status: 'ok', durationMs: Date.now() - started });
        } catch (error) {
            this.callbacks.logDiagnostic?.('chat-switch', 'switch_failed', { status: 'error', error, durationMs: Date.now() - started });
            console.warn('[STMN Elevator] chat switch error', error);
            this.view.setStatus(error?.message || '채팅 전환에 실패했어요.', true);
        } finally {
            this.busy = false;
            if (this.tab === 'buildings') this.renderBuildings();
        }
    }

    onChatChanged() {
        this.updateFloor(-1);
        this.lastLoaded = 0;
        if (this.tab === 'buildings' && this.view.panelOpen) void this.refreshBuildings(true);
    }

    onShow() {
        this.updateFloor(this.view.currentIndex);
        if (this.tab === 'buildings') void this.refreshBuildings(true);
    }

    destroy() {
        ++this.requestId;
        this.libraryUI?.destroy();
    }
}
