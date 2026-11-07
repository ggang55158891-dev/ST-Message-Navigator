import { SETTINGS_KEY, assignCustomTitle, findTarget, isMessageBookmarked, setMessageBookmark } from './model.js';
import { ensureMessageRendered, getChatElement, NavigationCursor, getRenderedMessage, scrollToMessage, isPastMessageStart, canScrollToChatBottom } from './scroll.js';
import { installSettings, NavigatorView } from './ui.js';
import { validNavPosition } from './position.js';
import { validPanelSize } from './panel-size.js';
import { listAvailableBuildings, enterBuilding } from './buildings.js';
import { buildingScope } from './building-data.js';
import { Diagnostics } from './diagnostics.js';
import { DEFAULT_SETTINGS, SETTINGS_FIELDS, ELEVATOR_THEMES, normalizeSettings, diffSettings } from './settings-backup.js';
import { inspectTitleMetadata } from './metadata-audit.js';
import { LibraryRepository } from './library-repository.js';
import { setSwipeAnnotation } from './swipe-marks.js';
import { SwipeManagerUI } from './swipe-manager-ui.js';
import { DATA_KEY, MESSAGE_KEY } from './model.js';

const PREFIX = '[ST Message Navigator]';
let app;

function context() { return SillyTavern.getContext(); }
function getSettings() {
    const ctx = context();
    if (!ctx.extensionSettings || typeof ctx.extensionSettings !== 'object') {
        throw new Error('실리태번 확장 설정을 사용할 수 없습니다.');
    }
    const root = ctx.extensionSettings;
    if (!root[SETTINGS_KEY] || typeof root[SETTINGS_KEY] !== 'object' || Array.isArray(root[SETTINGS_KEY])) {
        root[SETTINGS_KEY] = { ...DEFAULT_SETTINGS };
    }
    const settings = root[SETTINGS_KEY];
    // Validate legacy settings without deleting any unknown, future keys.
    Object.assign(settings, normalizeSettings(settings));
    return settings;
}

class NavigatorApp {
    constructor() {
        this.settings = getSettings();
        // Library is not read or created at startup; only explicit user actions.
        this.library = new LibraryRepository(context);
        this.diagnostics = new Diagnostics({ enabled: this.settings.diagnosticsEnabled });
        this.navSerial = 0;
        this.bookmarkSaving = false;
        this.swipeMarkSaving = false;
        this.busy = false;
        this.lastNavigated = -1;
        this.lastLanding = null;
        this.startLanding = null;
        this.cursor = new NavigationCursor();
        this.refreshTimer = null;
        this.listeners = [];
        this.chatElement = null;
        this.chatScrollHandler = () => {
            if (this.lastLanding && Math.abs((this.chatElement?.scrollTop ?? 0) - this.lastLanding.scrollTop) > 2) this.lastLanding = null;
            if (this.startLanding && Math.abs((this.chatElement?.scrollTop ?? 0) - this.startLanding.scrollTop) > 2) this.startLanding = null;
            if (this.busy || this.scrollRaf !== null) return;
            this.scrollRaf = requestAnimationFrame(() => {
                this.scrollRaf = null;
                this.updateCurrent();
            });
        };
        this.scrollRaf = null;
        this.view = new NavigatorView({
            context, hasChat: () => this.hasChat(),
            navigate: action => { void this.navigate(action); },
            goToIndex: index => { void this.goToIndex(index); },
            canNavigate: (kind, index) => this.canNavigate(kind, index),
            saveTitle: (index, title) => this.saveTitle(index, title),
            isBookmarked: index => isMessageBookmarked(context().chat?.[index], context().chatMetadata),
            toggleBookmark: index => this.toggleBookmark(index),
            selectSwipe: (index, swipeIndex) => this.selectQuietSwipe(index, swipeIndex),
            getPosition: () => this.settings.position,
            savePosition: position => this.changeSetting('position', position),
            getPanelSize: () => this.settings.panelSize,
            savePanelSize: size => this.changeSetting('panelSize', size),
            listBuildings: listAvailableBuildings,
            enterBuilding,
            readLibrary: () => this.library.read(),
            libraryRepository: this.library,
            currentLibraryScope: () => buildingScope(context()),
            syncFileLibrary: (scope,source,destination) => this.library.syncFileChange(scope,source,destination),
            changeLibrary: action => {
                try {
                    const result = this.library.update(action);
                    this.diagnostics.record('save', 'library_updated', { status: 'ok' });
                    return result;
                } catch (error) {
                    this.diagnostics.record('save', 'library_update_failed', { status: 'error', error });
                    throw error;
                }
            },
            getTheme: () => this.settings.elevatorTheme,
            getSkyMode: () => this.settings.elevatorSky,
            logDiagnostic: (category, code, details) => this.diagnostics.record(category, code, details),
        });
        this.swipeManager = new SwipeManagerUI({
            context,
            selectSwipe: (index, swipeIndex) => this.selectQuietSwipe(index,swipeIndex),
            saveMark: (index,swipeIndex,patch) => this.saveSwipeMark(index,swipeIndex,patch),
            status: (message,error) => this.view.setStatus(message,error),
        });
        this.view.setNavigationButtonsVisible(this.settings.showNavigationButtons);
        this.view.position(this.settings.side);
        this.syncSettingsUI = installSettings(
            context(), this.settings, (key, value) => this.changeSetting(key, value), this.diagnostics,
            {
                readSettings: () => this.settings,
                restoreSettings: next => this.restoreSettings(next),
                inspectTitles: () => {
                    const ctx = context();
                    return inspectTitleMetadata(ctx.chat, ctx.chatMetadata);
                },
            },
            {
                readLibrary: () => this.library.read(),
                importLibrary: incoming => this.library.importAdditively(incoming),
                onCoverRestored: async()=>{
                    const owner=this.view.elevator;
                    if(this.view.panelOpen && owner?.tab==='buildings'){
                        await owner.refreshBuildings(true);
                    }
                },
            },
        );
        this.bindChatScroll();
        this.bindEvents();
        this.updateCurrent();
        this.view.rebuild();
        this.diagnostics.record('lifecycle', 'initialized', { status: 'ok' });
    }

    hasChat() {
        const ctx = context();
        return Array.isArray(ctx.chat) && ctx.chat.length > 0;
    }

    canNavigate(action, index) {
        const ctx = context();
        const chat = ctx.chat || [];
        if (findTarget(chat, index, action, this.settings.mode) >= 0) return true;
        if (action === 'next' && index === findTarget(chat, index, 'last', this.settings.mode)) {
            return canScrollToChatBottom(this.chatElement);
        }
        if (action === 'previous' && index >= 0) {
            const anchor = this.startLanding;
            const atStart = anchor && anchor.chat === chat && anchor.id === ctx.chatId &&
                anchor.index === index && this.chatElement &&
                Math.abs(this.chatElement.scrollTop - anchor.scrollTop) <= 2;
            return !atStart && isPastMessageStart(this.chatElement, getRenderedMessage(this.chatElement, index));
        }
        return false;
    }

    updateCurrent() {
        if (this.busy) return;
        this.bindChatScroll();
        const chat = context().chat || [];
        const id = this.cursor.resolve(this.chatElement, chat.length);
        this.lastNavigated = id;
        this.view.setActive(id);
    }

    bindChatScroll() {
        const current = getChatElement();
        if (current === this.chatElement) return;
        this.chatElement?.removeEventListener('scroll', this.chatScrollHandler);
        this.cursor.clear();
        this.startLanding = null;
        this.lastLanding = null;
        this.chatElement = current;
        this.swipeManager?.bind(current);
        this.chatElement?.addEventListener('scroll', this.chatScrollHandler, { passive: true });
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        if (this.chatElement && typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this.view.position(this.settings.side));
            this.resizeObserver.observe(this.chatElement);
        }
        this.view.position(this.settings.side);
    }

    changeSetting(key, value) {
        if (key === 'mode' && !['visible', 'all'].includes(value)) return;
        if (key === 'side' && !['left', 'right'].includes(value)) return;
        if (key === 'position' && !validNavPosition(value)) return;
        if (key === 'panelSize' && value !== null && !validPanelSize(value)) return;
        if (key === 'showNavigationButtons' && typeof value !== 'boolean') return;
        if (key === 'elevatorTheme' && !ELEVATOR_THEMES.includes(value)) return;
        if (key === 'elevatorSky' && !['auto', 'day', 'night'].includes(value)) return;
        if (key === 'diagnosticsEnabled' && typeof value !== 'boolean') return;
        this.settings[key] = value;
        if (key === 'diagnosticsEnabled') this.diagnostics.setEnabled(value);
        if (key === 'elevatorTheme' || key === 'elevatorSky') {
            this.view.elevator?.applyTheme(this.settings.elevatorTheme, this.settings.elevatorSky);
        }
        if (key === 'showNavigationButtons') this.view.setNavigationButtonsVisible(value);
        if (key === 'panelSize') this.view.position(this.settings.side);
        if (key === 'side') {
            // Choosing left/right restores the default placement.
            this.settings.position = null;
            this.view.position(value);
        }
        context().saveSettingsDebounced?.();
        if (key !== 'position') this.updateCurrent();
    }

    /**
     * Validated settings-only restore: no chat mutation, no other settings.
     * Reverts the visible UI and settings if applying or requesting save fails.
     */
    restoreSettings(next) {
        const changes = diffSettings(this.settings, next);
        const previous = normalizeSettings(this.settings);
        const ctx = context();
        if (typeof ctx.saveSettingsDebounced !== 'function') {
            throw new Error('현재 SillyTavern에서 설정 저장 함수를 사용할 수 없습니다.');
        }
        const apply = source => {
            for (const key of SETTINGS_FIELDS) this.settings[key] = source[key];
            this.diagnostics.setEnabled(this.settings.diagnosticsEnabled);
            this.view.elevator?.applyTheme(this.settings.elevatorTheme, this.settings.elevatorSky);
            this.view.setNavigationButtonsVisible(this.settings.showNavigationButtons);
            this.view.position(this.settings.side);
            this.syncSettingsUI?.();
            this.updateCurrent();
        };
        try {
            apply(next);
            if (changes.length) ctx.saveSettingsDebounced();
            this.diagnostics.record('save', 'settings_restored', { status: 'ok', count: changes.length });
        } catch (error) {
            try { apply(previous); } catch { /* preserve original error */ }
            this.diagnostics.record('save', 'settings_restore_failed', { status: 'error', error });
            throw error;
        }
    }

    bindEvents() {
        const ctx = context();
        const events = ctx.eventTypes || ctx.event_types || {};
        const register = (key, cb) => {
            if (!events[key] || !ctx.eventSource?.on) return;
            ctx.eventSource.on(events[key], cb);
            this.listeners.push([events[key], cb]);
        };
        register('CHAT_CHANGED', () => {
            this.swipeManager.close();
            this.diagnostics.record('lifecycle', 'chat_changed', { status: 'ok' });
            this.navSerial++;
            this.busy = false;
            this.cursor.clear();
            this.lastLanding = null;
            this.startLanding = null;
            this.view.editing = -1;
            this.view.messageBatch?.reset();
            this.view.reorderUI?.reset();
            this.view.singleActions?.close();
            this.view.exclusiveMenus?.closeExcept(null);
            this.view.query = '';
            this.view.search.value = '';
            this.view.groupCollapsed.clear();
            this.view.elevator?.onChatChanged();
            this.view.setStatus('');
            this.scheduleRefresh(true);
        });
        for (const key of [
            'CHAT_CREATED', 'MESSAGE_SENT', 'MESSAGE_RECEIVED',
            'USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED',
            'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED',
            'MESSAGE_SWIPED', 'MORE_MESSAGES_LOADED',
        ]) register(key, () => {
            if (['CHAT_CREATED','MESSAGE_SENT','MESSAGE_RECEIVED','MESSAGE_EDITED',
                'MESSAGE_UPDATED','MESSAGE_DELETED','MESSAGE_SWIPED'].includes(key)) {
                if(this.view.reorderUI?.active)this.view.reorderUI.reset();
            }
            if(['CHAT_CREATED','MESSAGE_SENT','MESSAGE_RECEIVED','MESSAGE_EDITED',
                'MESSAGE_UPDATED','MESSAGE_DELETED','MESSAGE_SWIPED'].includes(key))
                this.view.elevator?.libraryUI?.searchUI?.onMessageMutation();
            if (['MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_DELETED','MESSAGE_SWIPED'].includes(key)) {
                if (this.view.messageBatch?.selectionMode)this.view.messageBatch.reset();
            }
            this.scheduleRefresh(false);
        });
        // Scope this observer to the chat only. It never changes ST's nodes.
        if (this.chatElement && typeof MutationObserver !== 'undefined') {
            this.observer = new MutationObserver(records => {
                if (records.some(r => (r.type === 'childList' && r.target === this.chatElement) || r.attributeName === 'is_system')) {
                    this.scheduleRefresh(false);
                }
            });
            this.observer.observe(this.chatElement, {
                childList: true, subtree: true, attributes: true,
                attributeFilter: ['is_system'],
            });
        }
    }

    scheduleRefresh(reset) {
        if (reset) this.pendingReset = true;
        if (this.refreshTimer !== null) return;
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = null;
            this.bindChatScroll();
            const chatChanged = Boolean(this.pendingReset);
            if (chatChanged) {
                this.pendingReset = false;
                this.lastNavigated = -1;
                this.view.rebuild();
            } else this.view.rebuild({ keepScroll: true });
            this.updateCurrent();
            // The toolbar observer handles newly added messages in real time.
            // Scan pre-existing toolbars only on full chat changes, never on
            // per-token streaming/message updates.
            if (chatChanged) this.swipeManager?.scan();
        }, 90);
    }

    /**
     * Q-05: Previous from the middle first returns to THIS message's start.
     * Once on its start, the next press moves to the preceding message.
     * The final "next" press can move down to the true bottom, sharing the
     * same endpoint behavior as the second "last" press.
     */
    async navigate(action) {
        if (this.busy) return;
        if (action !== 'last') this.lastLanding = null;
        const ctx = context();
        this.bindChatScroll();
        const chat = ctx.chat || [];
        const base = this.cursor.resolve(this.chatElement, chat.length);

        if (action === 'previous' && base >= 0) {
            const anchor = this.startLanding;
            const atStart = anchor && anchor.chat === chat && anchor.id === ctx.chatId &&
                anchor.index === base && this.chatElement &&
                Math.abs(this.chatElement.scrollTop - anchor.scrollTop) <= 2;
            const node = getRenderedMessage(this.chatElement, base);
            if (!atStart && isPastMessageStart(this.chatElement, node) &&
                scrollToMessage(this.chatElement, node)) {
                this.cursor.set(this.chatElement, base);
                this.startLanding = {
                    chat, id: ctx.chatId, index: base,
                    scrollTop: this.chatElement.scrollTop,
                };
                this.lastNavigated = base;
                this.view.setActive(base);
                this.view.setStatus(`메시지 #${base}의 처음으로 이동했습니다.`);
                this.diagnostics.record('navigation', 'previous_current_start',
                    { status: 'ok', targetIndex: base });
                return;
            }
        }

        const target = findTarget(chat, base, action, this.settings.mode);
        this.diagnostics.record('navigation', 'target_resolved',
            { status: target >= 0 ? 'ok' : 'skipped', targetIndex: target >= 0 ? target : undefined });

        if (action === 'next' && target < 0 &&
            base === findTarget(chat, base, 'last', this.settings.mode) &&
            canScrollToChatBottom(this.chatElement)) {
            this.scrollToBottom(base, 'next_bottom');
            return;
        }
        if (target < 0) return;

        if (action === 'last') {
            const landing = this.lastLanding;
            if (landing && landing.chat === chat && landing.id === ctx.chatId &&
                landing.index === target && this.chatElement &&
                Math.abs(this.chatElement.scrollTop - landing.scrollTop) <= 2) {
                this.lastLanding = null;
                this.scrollToBottom(target, 'last_bottom');
                return;
            }
        }
        const reached = await this.goToIndex(target);
        if (action === 'last' && reached && this.chatElement) {
            this.lastLanding = {
                chat, id: ctx.chatId, index: target,
                scrollTop: this.chatElement.scrollTop,
            };
        }
    }

    scrollToBottom(index, eventCode) {
        if (!this.chatElement) return;
        this.startLanding = null;
        this.chatElement.scrollTo({
            top: Math.max(0, this.chatElement.scrollHeight - this.chatElement.clientHeight),
            behavior: 'instant',
        });
        this.cursor.set(this.chatElement, index);
        this.lastNavigated = index;
        this.view.setActive(index);
        this.view.setStatus('채팅 화면 맨 아래로 이동했습니다.');
        this.diagnostics.record('navigation', eventCode, { status: 'ok', targetIndex: index });
    }

    async goToIndex(index) {
        this.lastLanding = null;
        this.startLanding = null;
        if (this.busy) return false;
        const initial = context();
        const chatRef = initial.chat;
        const chatId = initial.chatId;
        if (!Array.isArray(chatRef) || !chatRef[index] || !Number.isInteger(index)) return;
        const token = ++this.navSerial;
        const started = Date.now();
        this.diagnostics.record('navigation', 'jump_started', { status: 'started', targetIndex: index });
        this.busy = true;
        this.view.setActive(this.lastNavigated, true);
        this.view.setStatus('메시지 위치를 찾는 중…');
        const cancelled = () => token !== this.navSerial || context().chat !== chatRef || context().chatId !== chatId;
        try {
            const chatElement = await ensureMessageRendered(initial, index, cancelled, text => this.view.setStatus(text));
            if (cancelled() || !chatElement) {
                this.diagnostics.record('navigation', 'jump_cancelled', { status: 'cancelled', targetIndex: index, durationMs: Date.now() - started });
                return;
            }
            const node = getRenderedMessage(chatElement, index);
            if (!scrollToMessage(chatElement, node)) throw new Error('대상 메시지가 화면에서 숨겨져 있어 스크롤할 수 없습니다.');
            this.cursor.set(chatElement, index);
            this.startLanding = {
                chat: chatRef, id: chatId, index,
                scrollTop: chatElement.scrollTop,
            };
            this.lastNavigated = index;
            this.view.setActive(index, true);
            this.view.setStatus(`메시지 #${index}로 이동했습니다.`);
            this.diagnostics.record('navigation', 'jump_completed', { status: 'ok', targetIndex: index, durationMs: Date.now() - started });
            return true;
        } catch (error) {
            if (!cancelled()) {
                this.diagnostics.record('navigation', 'jump_failed', { status: 'error', targetIndex: index, error, durationMs: Date.now() - started });
                console.warn(PREFIX, error);
                this.view.setStatus(error.message || '이동에 실패했습니다.', true);
            } else {
                this.diagnostics.record('navigation', 'jump_cancelled', { status: 'cancelled', targetIndex: index, durationMs: Date.now() - started });
            }
        } finally {
            if (token === this.navSerial) {
                this.busy = false;
                // UI scroll events can run after programmatic scrolling.
                this.view.setActive(this.lastNavigated);
            }
        }
    }

    /** Select an existing swipe through SillyTavern's own swipe engine.
     * Do not edit swipe_id/mes directly: native swipe processing also updates
     * media, UI counters and downstream message state. */
    async selectQuietSwipe(index, swipeIndex) {
        const ctx=context();
        const chat=ctx.chat;
        const chatId=ctx.chatId;
        const message=chat?.[index];
        if (!Number.isSafeInteger(index) || index<0 ||
            !Number.isSafeInteger(swipeIndex) || swipeIndex<0 ||
            !Array.isArray(message?.swipes) || swipeIndex>=message.swipes.length) {
            throw new Error('유효한 스와이프를 선택해 주세요.');
        }
        if (message.swipe_id === swipeIndex) return true;
        if (typeof ctx.swipe?.to !== 'function') {
            throw new Error('이 SillyTavern 버전에서는 스와이프 선택 API를 사용할 수 없습니다.');
        }
        // Earlier chat messages can be virtualized and not yet in the
        // SillyTavern DOM; navigate before requesting core swipe transition.
        const reached=await this.goToIndex(index);
        if (!reached || context().chat!==chat || context().chatId!==chatId) {
            throw new Error('메시지 위치로 이동하지 못했습니다. 스와이프는 변경하지 않았습니다.');
        }
        const node=Array.from(document.querySelectorAll('#chat > .mes[mesid]'))
            .find(el=>Number(el.getAttribute('mesid'))===index);
        if (!node?.querySelector('.mes_block .mes_text')) {
            throw new Error('SillyTavern 메시지 본문이 화면에 없어 스와이프를 변경할 수 없습니다.');
        }
        await ctx.swipe.to(null,'right',{
            source:'swipe_picker',
            message,
            forceMesId:index,
            forceSwipeId:swipeIndex,
            forceDuration:0,
        });
        if (context().chat!==chat || context().chatId!==chatId ||
            chat[index]!==message || message.swipe_id!==swipeIndex) {
            throw new Error('스와이프 전환 결과를 확인할 수 없습니다. 채팅 내용을 확인해 주세요.');
        }
        this.diagnostics.record('navigation','quiet_swipe_selected',
            {status:'ok',targetIndex:index});
        return true;
    }

    /**
     * Save only extension-owned metadata using a copy-on-write snapshot.
     * No swipe text, order, active swipe, or third-party fields are modified.
     */
    async saveSwipeMark(index,swipeIndex,patch) {
        if(this.swipeMarkSaving) throw new Error('이전 스와이프 저장이 끝난 뒤 다시 시도해 주세요.');
        const ctx=context();
        const chat=ctx.chat, chatId=ctx.chatId, metadata=ctx.chatMetadata;
        if(!ctx.chatId || !chat?.[index] || !metadata || typeof ctx.saveMetadata!=='function') {
            throw new Error('현재 채팅의 메타데이터를 저장할 수 없습니다.');
        }
        const msg=chat[index];
        const previousId=msg[MESSAGE_KEY];
        const previousStore=metadata[DATA_KEY];
        // The original store is not mutated before save succeeds.
        if(previousStore) metadata[DATA_KEY]=structuredClone(previousStore);
        this.swipeMarkSaving=true;
        let changed=false;
        try {
            changed=setSwipeAnnotation(chat,metadata,index,swipeIndex,patch);
            if(!changed) {
                if(previousStore===undefined)delete metadata[DATA_KEY];
                else metadata[DATA_KEY]=previousStore;
                return false;
            }
            await ctx.saveMetadata();
            if(context().chat!==chat || context().chatId!==chatId) {
                throw new Error('저장 중 채팅이 전환되었습니다. 저장 결과를 확인해 주세요.');
            }
            this.diagnostics.record('save','swipe_mark_saved',
                {status:'ok',targetIndex:index});
            return true;
        } catch(error) {
            if(context().chat===chat && context().chatId===chatId) {
                if(previousStore===undefined) delete metadata[DATA_KEY];
                else metadata[DATA_KEY]=previousStore;
                if(previousId===undefined) delete msg[MESSAGE_KEY];
                else msg[MESSAGE_KEY]=previousId;
            }
            this.diagnostics.record('save','swipe_mark_failed',
                {status:'error',targetIndex:index,error});
            throw error;
        } finally {
            this.swipeMarkSaving=false;
        }
    }

    async toggleBookmark(index) {
        if (this.bookmarkSaving) return;
        const ctx = context();
        const chatRef = ctx.chat;
        const chatId = ctx.chatId;
        if (!ctx.chatId || !Array.isArray(chatRef) || !chatRef[index] || !ctx.chatMetadata ||
            typeof ctx.saveMetadata !== 'function') {
            this.view.setStatus('먼저 저장 가능한 채팅을 선택해 주세요.', true);
            return;
        }
        this.bookmarkSaving = true;
        try {
            const previous = isMessageBookmarked(chatRef[index], ctx.chatMetadata);
            if (!setMessageBookmark(chatRef, ctx.chatMetadata, index, !previous)) return;
            await ctx.saveMetadata();
            if (context().chat !== chatRef || context().chatId !== chatId) {
                throw new Error('저장 도중 채팅이 바뀌었습니다. 북마크를 확인해 주세요.');
            }
            this.diagnostics.record('save', 'message_bookmark_saved', { status: 'ok', targetIndex: index });
            this.view.renderRows(true);
            this.view.setStatus(!previous ? '메시지를 북마크했습니다.' : '메시지 북마크를 해제했습니다.');
        } catch(error) {
            this.diagnostics.record('save', 'message_bookmark_failed', { status: 'error', targetIndex: index, error });
            this.view.setStatus(error?.message || '북마크를 저장하지 못했습니다.', true);
        } finally {
            this.bookmarkSaving = false;
        }
    }

    async saveTitle(index, title) {
        const ctx = context();
        if (!ctx.chatId || !ctx.chatMetadata || !Array.isArray(ctx.chat) || !ctx.chat[index]) {
            throw new Error('먼저 저장된 채팅을 선택해 주세요.');
        }
        const chatRef = ctx.chat;
        const chatId = ctx.chatId;
        // Don't edit text, swipes, prompt order, or another extension's keys.
        const started = Date.now();
        try {
        assignCustomTitle(chatRef, ctx.chatMetadata, index, title);
        // saveMetadata() ultimately saves the whole chat (message ID + metadata).
        // Start the save immediately to minimize switch-chat races.
        if (typeof ctx.saveMetadata !== 'function') throw new Error('이 버전에서는 메타데이터 저장을 사용할 수 없습니다.');
        await ctx.saveMetadata();
        if (context().chat !== chatRef || context().chatId !== chatId) {
            throw new Error('저장 도중 채팅이 바뀌었습니다. 저장 결과를 확인해 주세요.');
        }
        this.diagnostics.record('save', 'title_saved', { status: 'ok', targetIndex: index, durationMs: Date.now() - started });
        } catch (error) {
            this.diagnostics.record('save', 'title_save_failed', { status: 'error', targetIndex: index, durationMs: Date.now() - started, error });
            throw error;
        }
    }

    destroy() {
        this.navSerial++;
        this.diagnostics.record('lifecycle', 'destroyed', { status: 'ok' });
        this.cursor.clear();
        this.lastLanding = null;
        this.startLanding = null;
        if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
        if (this.scrollRaf !== null) cancelAnimationFrame(this.scrollRaf);
        this.resizeObserver?.disconnect();
        this.observer?.disconnect();
        this.swipeManager?.destroy();
        this.chatElement?.removeEventListener('scroll', this.chatScrollHandler);
        const ctx = context();
        for (const [name, cb] of this.listeners) ctx.eventSource?.removeListener?.(name, cb);
        document.getElementById('stmn-settings')?.remove();
        this.view.destroy();
    }
}

function initialize() {
    if (app || document.getElementById('stmn-root')) return;
    try {
        app = new NavigatorApp();
        console.info(PREFIX, 'loaded (v1.27.0)');
    } catch (error) {
        console.error(PREFIX, 'initialization error:', error);
    }
}

// APP_READY self-fires for late extensions on recent SillyTavern versions.
// A DOM-ready fallback supports older releases without double initialization.
if (globalThis.SillyTavern?.getContext) {
    try {
        const ctx = context();
        const readyEvent = (ctx.eventTypes || ctx.event_types || {}).APP_READY;
        if (readyEvent) ctx.eventSource.on(readyEvent, initialize);
        if (document.readyState === 'complete') setTimeout(initialize, 0);
        else window.addEventListener('load', initialize, { once: true });
    } catch (error) {
        console.error(PREFIX, 'startup error:', error);
    }
}
