/**
 * Lightweight real-Chromium browser smoke tests for the extension UI.
 *
 * No Playwright package or browser binaries are distributed with SillyTavern.
 * Run only in CI / manually:
 *   npm install --no-save --no-package-lock playwright-core@1.56.0
 *   node tests/browser/smoke.mjs
 *
 * This tests the actual navigator DOM and CSS against a simulated SillyTavern
 * context. It is NOT a full live-SillyTavern or cross-extension E2E test.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dirname, '../..');
const pageHTML = String.raw`<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/style.css">
<style>
body {margin:0;background:#10151e;color:#fafafa;font:14px system-ui;}
#chat { margin:35px auto 0; width:60%; height:72vh; overflow:auto; border:1px solid #777; }
#chat .mes { min-height:65px; border-bottom:1px solid #666; }
</style></head>
<body><div id="chat"></div><div id="extensions_settings2"></div></body></html>`;

async function startServer() {
    const server = createServer(async (request, response) => {
        const requested = new URL(request.url, 'http://127.0.0.1').pathname;
        if (requested === '/') {
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            response.end(pageHTML);
            return;
        }
        // Do not expose hidden files, tests, repository internals or outside paths.
        if (!/^\/[a-z][a-z0-9-]*\.js$|^\/style\.css$/.test(requested)) {
            response.writeHead(404); response.end(); return;
        }
        const candidate = resolve(root, '.' + requested);
        if (!candidate.startsWith(root + sep)) { response.writeHead(403); response.end(); return; }
        try {
            const content = await readFile(candidate);
            response.writeHead(200, {
                'content-type': extname(candidate) === '.css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
                'cache-control': 'no-store',
            });
            response.end(content);
        } catch {
            response.writeHead(404); response.end();
        }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { server, baseURL: 'http://127.0.0.1:' + server.address().port };
}

async function setupPage(browser, baseURL, messageCount = 23, size = { width: 1280, height: 800 }, integrated = false) {
    const page = await browser.newPage({ viewport: size });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseURL);
    if (integrated) {
        await bootSettingsApp(page);
        return { page, errors };
    }
    await page.evaluate(async count => {
        const { NavigatorView } = await import('/ui.js');
        const makeMessage = i => ({
            name: i % 2 ? 'Character' : 'User',
            is_user: i % 2 === 0,
            mes: '메시지 ' + i + ' · 흥미로운 이야기 ' + (i === 14 ? '비밀 #4는 여기에 있어요.' : '이야기의 다음 장면입니다.'),
        });
        const context = {
            chatId: 'chat-a',
            characterId: 0,
            characters: [{ name: 'Character', avatar: 'none' }],
            groups: [],
            groupId: null,
            chat: Array.from({ length: count }, (_, i) => makeMessage(i)),
            chatMetadata: {},
        };
        window.__stmnContext = context;
        window.__stmnActions = [];
        window.__stmnPosition = null;
        window.__stmnPanelSize = null;
        const callbacks = {
            context: () => context,
            hasChat: () => true,
            navigate: action => window.__stmnActions.push(action),
            goToIndex: index => window.__stmnActions.push(index),
            canNavigate: () => true,
            saveTitle: async () => undefined,
            getPosition: () => window.__stmnPosition,
            savePosition: position => { window.__stmnPosition = position; },
            getPanelSize: () => window.__stmnPanelSize,
            savePanelSize: size => { window.__stmnPanelSize = size; },
            listBuildings: async () => ({
                scope: 'character:none', title: 'Character',
                buildings: [
                    { id: 'chat-a', name: '건물 A', preview: '', lastActivity: 300, count: 3 },
                    { id: 'chat-b', name: '건물 B', preview: '', lastActivity: 100, count: 2 },
                ],
            }),
            enterBuilding: async (_context, id) => {
                context.chatId = id;
                context.chat = [makeMessage(0), makeMessage(1)];
                return true;
            },
            getTheme: () => 'classic',
            getSkyMode: () => 'auto',
            libraryRepository: {
                read:()=>({schemaVersion:2,records:{},folders:[],tags:[]}),
                importAdditively:()=>({changed:false}),
            },
            currentLibraryScope: () => {
                const ctx=window.__stmnContext;
                return ctx.groupId != null && ctx.groupId !== ''
                    ? 'group:'+ctx.groupId
                    : 'character:'+String(ctx.characters?.[ctx.characterId]?.avatar || ctx.characterId);
            },
        };
        window.__stmnView = new NavigatorView(callbacks);
        window.__stmnView.setActive(0);
    }, messageCount);
    return { page, errors };
}

/**
 * Boot the actual extension entrypoint with a small simulated ST context.
 * Unlike view-only smoke tests, this covers index.js changeSetting validation
 * and the real "엘리베이터 외형" select event through persistence.
 */
async function bootSettingsApp(page) {
    await page.evaluate(async () => {
        const { SETTINGS_KEY } = await import('/model.js');
        const saved = JSON.parse(sessionStorage.getItem('stmn-test-theme') || '{}');
        const context = {
            extensionSettings: {
                [SETTINGS_KEY]: saved,
                unrelated_extension: { keep: true },
            },
            chatId: 'chat-settings-test',
            characterId: 0,
            characters: [{ name: 'Character', avatar: 'none' }],
            groupId: null,
            groups: [],
            chatMetadata: {},
            chat: [
                { name: 'User', is_user: true, mes: 'Theme test one' },
                { name: 'Character', is_user: false, mes: 'Theme test two' },
            ],
            eventTypes: {},
            eventSource: {
                on() {},
                removeListener() {},
            },
            saveSettingsDebounced() {
                window.__themeSaveCount = (window.__themeSaveCount || 0) + 1;
                sessionStorage.setItem('stmn-test-theme', JSON.stringify(this.extensionSettings[SETTINGS_KEY]));
            },
        };
        window.SillyTavern = { getContext: () => context };
        window.__themeAppContext = context;
        window.__themeSaveCount = 0;
        await import('/index.js');
    });
    await page.locator('#stmn-elevator-theme').waitFor({ state: 'attached' });
}

async function run() {
    const { server, baseURL } = await startServer();
    let browser;
    let failures = 0;
    let count = 0;
    const check = async (name, fn) => {
        count++;
        let page;
        let errors = [];
        try {
            const result = await fn(async (messageCount, size, integrated = false) => {
                const setup = await setupPage(browser, baseURL, messageCount, size, integrated);
                page = setup.page;
                errors = setup.errors;
                return page;
            });
            assert.deepEqual(errors, [], 'Browser JS errors');
            process.stdout.write('✓ ' + name + '\n');
            return result;
        } catch (error) {
            failures++;
            process.stderr.write('✗ ' + name + '\n' + (error?.stack || String(error)) + '\n');
        } finally {
            await page?.close().catch(() => {});
        }
    };
    try {
        browser = await chromium.launch({
            ...(process.env.STMN_CHROME_PATH ? { executablePath: process.env.STMN_CHROME_PATH } : { channel: 'chrome' }),
            headless: true,
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
        });

        await check('outline groups and exact #4 search', async setup => {
            const page = await setup(23);
            await page.locator('[data-action="outline"]').click();
            assert.match(await page.locator('.stmn-count').innerText(), /23/);
            await page.getByRole('button', { name: /목차 맨 위/ }).click();
            assert.match(await page.locator('.stmn-group-toggle').first().innerText(), /#0.*#9/);
            await page.locator('.stmn-search-input').fill('#4');
            assert.equal(await page.locator('.stmn-row').count(), 1);
            assert.equal(await page.locator('.stmn-row').getAttribute('data-index'), '4');
            await page.locator('.stmn-title').click();
            assert.deepEqual(await page.evaluate(() => window.__stmnActions), [4]);
        });

        await check('collapse all, expand all, and filter bypass', async setup => {
            const page = await setup(23);
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('button', { name: '모두 접기' }).click();
            assert.equal(await page.locator('.stmn-row').count(), 0);
            assert.equal(await page.locator('.stmn-group').count(), 3);
            await page.locator('.stmn-search-input').fill('#14');
            assert.equal(await page.locator('.stmn-row').count(), 1);
            await page.locator('.stmn-search-input').fill('');
            await page.getByRole('button', { name: '모두 펼치기' }).click();
            assert.ok((await page.locator('.stmn-row').count()) > 0);
        });

        await check('building tabs and click-to-chat switch', async setup => {
            const page = await setup(23);
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('tab', { name: '건물 로비' }).click();
            await page.locator('.stmn-building-card').last().waitFor();
            assert.equal(await page.locator('.stmn-building-card').count(), 2);
            await page.locator('.stmn-building-card').filter({ hasText: '건물 B' }).click();
            await page.waitForFunction(() => window.__stmnContext.chatId === 'chat-b');
            assert.equal(await page.getByRole('tab', { name: '층 안내' }).getAttribute('aria-selected'), 'true');
            assert.match(await page.locator('.stmn-elevator-building').innerText(), /chat-b/);
        });

        await check('actual extension settings select applies Quiet, persists, and survives reload', async setup => {
            const page = await setup(2, undefined, true);
            const themeSelect = page.locator('#stmn-elevator-theme');
            await page.locator('#stmn-settings > details > summary').click();
            assert.equal(await themeSelect.inputValue(), 'classic');
            await themeSelect.selectOption('quiet');
            const selected = await page.evaluate(() => {
                const root = document.getElementById('stmn-root');
                const ctx = window.__themeAppContext;
                return {
                    theme: root.dataset.elevatorTheme,
                    stored: ctx.extensionSettings.st_message_navigator_v1?.elevatorTheme,
                    saveCount: window.__themeSaveCount,
                    other: ctx.extensionSettings.unrelated_extension.keep,
                    panelBg: getComputedStyle(document.querySelector('.stmn-outline')).backgroundColor,
                };
            });
            assert.equal(selected.theme, 'quiet', 'Live setting handler must accept quiet');
            assert.equal(selected.stored, 'quiet', 'Live setting handler must update managed settings');
            assert.ok(selected.saveCount >= 1, 'Theme switch must request persistence');
            assert.equal(selected.other, true, 'Other extension data must remain untouched');
            assert.equal(selected.panelBg, 'rgb(253, 253, 252)', 'Quiet style should be visible');

            await page.locator('[data-action="outline"]').click();
            assert.equal(await page.locator('.stmn-quiet-toolbar').isVisible(), true);
            await page.reload();
            await bootSettingsApp(page);
            await page.locator('#stmn-settings > details > summary').click();
            assert.equal(await page.locator('#stmn-elevator-theme').inputValue(), 'quiet',
                'Saved Quiet preference should be restored on startup');
            assert.equal(await page.locator('#stmn-root').getAttribute('data-elevator-theme'), 'quiet');
            await page.locator('#stmn-elevator-theme').selectOption('classic');
            assert.equal(await page.locator('#stmn-root').getAttribute('data-elevator-theme'), 'classic');
            assert.equal(await page.locator('.stmn-quiet-toolbar').isVisible(), false);
        });

        await check('Quiet opt-in shell keeps search, grouping and chat switching functional', async setup => {
            const page = await setup(23);
            await page.locator('[data-action="outline"]').click();
            assert.equal(await page.locator('.stmn-quiet-toolbar').isVisible(), false,
                'Existing themes must preserve existing layout');
            await page.evaluate(() => window.__stmnView.elevator.applyTheme('quiet','auto'));
            await page.locator('.stmn-quiet-toolbar').waitFor({state:'visible'});
            assert.equal(await page.locator('.stmn-search-input').isVisible(), false);
            await page.getByRole('button',{name:'검색 열기'}).click();
            await page.locator('.stmn-search-input').fill('#4');
            assert.equal(await page.locator('.stmn-row').count(),1);
            await page.getByRole('button',{name:'검색 열기'}).click();
            assert.equal(await page.locator('.stmn-search-input').isVisible(),false);
            assert.equal(await page.locator('.stmn-search-input').inputValue(),'');
            await page.getByLabel('목록 메뉴').click();
            await page.locator('.stmn-quiet-list-menu').getByRole('button',{name:'모두 접기'}).click();
            assert.equal(await page.locator('.stmn-row').count(),0);
            await page.getByLabel('목록 메뉴').click();
            await page.locator('.stmn-quiet-list-menu').getByRole('button',{name:'모두 펼치기'}).click();
            assert.ok(await page.locator('.stmn-row').count()>0);
            await page.getByRole('tab',{name:'건물 로비'}).click();
            await page.locator('.stmn-building-card').first().waitFor();
            assert.equal(await page.locator('.stmn-building-controls').isVisible(),false);
            await page.getByLabel('목록 메뉴').click();
            await page.locator('.stmn-quiet-sort').selectOption('name');
            assert.equal(await page.locator('.stmn-building-sort').inputValue(),'name');
            await page.getByLabel('목록 메뉴').click();
            await page.locator('.stmn-quiet-list-menu').getByRole('button',{name:'폴더·태그 관리'}).click();
            await page.locator('.stmn-library-controls').waitFor({state:'visible'});
            await page.getByRole('button',{name:'검색 열기'}).click();
            await page.locator('.stmn-building-search').fill('건물 B');
            assert.equal(await page.locator('.stmn-building-card').count(),1);
            await page.locator('.stmn-building-card').first().click();
            await page.waitForFunction(()=>window.__stmnContext.chatId==='chat-b');
            assert.equal(await page.getByRole('tab',{name:'층 안내'}).getAttribute('aria-selected'),'true');
            await page.evaluate(()=>window.__stmnView.elevator.applyTheme('classic','auto'));
            assert.equal(await page.locator('.stmn-quiet-toolbar').isVisible(),false);
            assert.equal(await page.locator('.stmn-search').isVisible(),true);
        });

        await check('dragging moves nav without activating its button', async setup => {
            const page = await setup(23);
            const outline = page.locator('[data-action="outline"]');
            const rect = await outline.boundingBox();
            assert.ok(rect);
            await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
            await page.mouse.down();
            await page.mouse.move(rect.x + rect.width / 2 - 80, rect.y + rect.height / 2 + 90, { steps: 6 });
            await page.mouse.up();
            const state = await page.evaluate(() => ({
                position: window.__stmnPosition, isOpen: window.__stmnView.panelOpen,
            }));
            assert.ok(state.position?.x >= 0 && state.position.x <= 1);
            assert.ok(state.position?.y >= 0 && state.position.y <= 1);
            assert.equal(state.isOpen, false, 'Drag must not open the panel');
        });

        await check('cached titles refresh after text and metadata edits', async setup => {
            const page = await setup(1000);
            await page.locator('[data-action="outline"]').click();
            const cacheReuse = await page.evaluate(() => {
                const view = window.__stmnView;
                const context = window.__stmnContext;
                const message = context.chat[4];
                const before = view.outlineEntryCache.get(message);
                view.rebuild({ keepScroll: true });
                const again = view.outlineEntryCache.get(message);
                message.mes = '수정된 메시지 내용입니다.';
                view.rebuild({ keepScroll: true });
                const afterText = view.outlineEntryCache.get(message);
                message.stmn_message_id_v1 = 'manual-title-4';
                context.chatMetadata.stmn_message_outline_v1 = { titles: { 'manual-title-4': '새로운 개인 제목' } };
                view.rebuild({ keepScroll: true });
                const afterMetadata = view.outlineEntryCache.get(message);
                return {
                    reused: before === again,
                    invalidatedText: again !== afterText,
                    invalidatedTitle: afterText !== afterMetadata,
                    title: afterMetadata.title,
                };
            });
            assert.equal(cacheReuse.reused, true);
            assert.equal(cacheReuse.invalidatedText, true);
            assert.equal(cacheReuse.invalidatedTitle, true);
            assert.equal(cacheReuse.title, '새로운 개인 제목');
            await page.locator('.stmn-search-input').fill('새로운 개인 제목');
            assert.equal(await page.locator('.stmn-row').count(), 1);
            assert.equal(await page.locator('.stmn-row').getAttribute('data-index'), '4');
        });

        await check('settings backup import previews, rejects bad files and applies only after consent', async setup => {
            const page = await setup(23);
            await page.evaluate(async () => {
                const { installSettingsBackupUI } = await import('/settings-backup-ui.js');
                const { createSettingsBackup, DEFAULT_SETTINGS } = await import('/settings-backup.js');
                window.__currentSettings = { ...DEFAULT_SETTINGS };
                window.__restoreCalls = 0;
                window.__settingsBackupJSON = createSettingsBackup({
                    ...DEFAULT_SETTINGS, mode: 'all', elevatorTheme: 'sky',
                }, { version: '1.3.3' });
                installSettingsBackupUI(document.getElementById('extensions_settings2'), {
                    readSettings: () => window.__currentSettings,
                    restoreSettings: settings => {
                        window.__restoreCalls++;
                        Object.assign(window.__currentSettings, settings);
                    },
                    inspectTitles: () => ({ messages: 23, customTitles: 0,
                        orphanTitles: 0, duplicateMessageIds: 0, invalidTitles: 0, malformedStore: false }),
                });
            });
            await page.locator('.stmn-backup-settings > summary').click();
            const file = page.locator('#stmn-backup-file');
            await file.setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
            assert.equal(await page.getByRole('button', { name: '선택한 설정 복원' }).isDisabled(), true);
            assert.equal(await page.evaluate(() => window.__restoreCalls), 0);
            const good = await page.evaluate(() => window.__settingsBackupJSON);
            await file.setInputFiles({ name: 'good.json', mimeType: 'application/json', buffer: Buffer.from(good) });
            await page.locator('.stmn-backup-confirm input').waitFor({ state: 'visible' });
            assert.equal(await page.getByRole('button', { name: '선택한 설정 복원' }).isDisabled(), true);
            assert.match(await page.locator('.stmn-backup-preview').innerText(), /elevatorTheme/);
            await page.locator('.stmn-backup-confirm input').check();
            await page.getByRole('button', { name: '선택한 설정 복원' }).click();
            assert.deepEqual(await page.evaluate(() => ({
                count: window.__restoreCalls,
                theme: window.__currentSettings.elevatorTheme,
                mode: window.__currentSettings.mode,
            })), { count: 1, theme: 'sky', mode: 'all' });
        });

        await check('opening outline starts at newest message and expands last group', async setup => {
            const page = await setup(42);
            await page.evaluate(() => window.__stmnView.groupCollapsed.add(40));
            await page.locator('[data-action="outline"]').click();
            const view = await page.evaluate(() => ({
                expanded: !window.__stmnView.groupCollapsed.has(40),
                lastVisible: !!document.querySelector('.stmn-row[data-index="41"]'),
                nearEnd: Math.abs(window.__stmnView.list.scrollTop -
                    (window.__stmnView.list.scrollHeight - window.__stmnView.list.clientHeight)) <= 2,
            }));
            assert.equal(view.expanded, true);
            assert.equal(view.lastVisible, true);
            assert.equal(view.nearEnd, true);
        });

        await check('outline top/bottom controls scroll list, not SillyTavern chat', async setup => {
            const page = await setup(130);
            await page.locator('[data-action="outline"]').click();
            await page.evaluate(() => document.querySelector('#chat').scrollTop = 123);
            await page.getByRole('button', { name: /목차 맨 위/ }).click();
            assert.equal(await page.evaluate(() => window.__stmnView.list.scrollTop), 0);
            await page.getByRole('button', { name: /목차 맨 아래/ }).click();
            const end = await page.evaluate(() => ({
                listAtEnd: Math.abs(window.__stmnView.list.scrollTop -
                    (window.__stmnView.list.scrollHeight - window.__stmnView.list.clientHeight)) <= 2,
                chatScroll: document.querySelector('#chat').scrollTop,
            }));
            assert.equal(end.listAtEnd, true);
            assert.equal(end.chatScroll, 0);
            await page.getByRole('tab', { name: '건물 로비' }).click();
            assert.equal(await page.locator('.stmn-outline-jumps').isVisible(), false);
        });

        await check('Q07C rename uses one name field, verified IndexedDB archive, and can recover a separate new chat', async setup=>{
            const page=await setup(3);
            const raw='{"chat_metadata":{}}\n{"mes":"원본 본문","swipes":["첫번째","둘째"]}\n';
            const files=new Map([['chat-b',raw]]);
            const calls=[];
            await page.route('**/api/chats/export',async route=>{
                const data=route.request().postDataJSON();
                const id=data.file.replace(/\.jsonl$/,'');
                calls.push({action:'read',id});
                if(!files.has(id)){
                    await route.fulfill({status:404,contentType:'application/json',body:'{}'});
                    return;
                }
                await route.fulfill({status:200,contentType:'application/json',
                    body:JSON.stringify({result:files.get(id)})});
            });
            await page.route('**/api/chats/rename',async route=>{
                const data=route.request().postDataJSON();
                const from=data.original_file.replace(/\.jsonl$/,'');
                const to=data.renamed_file.replace(/\.jsonl$/,'');
                calls.push({action:'rename',from,to});
                if(!files.has(from) || files.has(to)){
                    await route.fulfill({status:400,contentType:'application/json',body:'{}'});return;
                }
                files.set(to,files.get(from));files.delete(from);
                await route.fulfill({status:200,contentType:'application/json',
                    body:JSON.stringify({ok:true,sanitizedFileName:to})});
            });
            await page.route('**/api/chats/save',async route=>{
                const data=route.request().postDataJSON();
                calls.push({action:'restore',id:data.file_name});
                files.set(data.file_name,data.chat.map(x=>JSON.stringify(x)).join('\n'));
                await route.fulfill({status:200,contentType:'application/json',
                    body:JSON.stringify({ok:true})});
            });
            await page.evaluate(()=>{
                const ctx=window.__stmnContext;
                ctx.getRequestHeaders=()=>({'Content-Type':'application/json'});
                ctx.eventSource={emit:async()=>{}};
                ctx.eventTypes={CHAT_RENAMED:'renamed'};
                window.__stmnView.elevator.applyTheme('quiet','auto');
            });
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('tab',{name:'건물 로비'}).click();
            const first=page.locator('.stmn-library-card').first();
            await first.locator('.stmn-quiet-item-menu summary').click();
            assert.equal(await first.getByRole('button',{name:'파일 이름 변경'}).isDisabled(),true);
            await first.locator('.stmn-quiet-item-menu summary').click();
            const inactive=page.locator('.stmn-library-card').nth(1);
            await inactive.locator('.stmn-quiet-item-menu summary').click();
            await inactive.getByRole('button',{name:'파일 이름 변경'}).click();
            const panel=page.locator('.stmn-file-action');
            await panel.waitFor({state:'visible'});
            assert.equal(await panel.getByRole('checkbox').count(),0);
            assert.equal(await panel.getByRole('textbox',{name:'기존 채팅 파일명 확인'}).count(),0);
            const rename=panel.getByRole('button',{name:'이름 변경'});
            assert.equal(await rename.isEnabled(),false);
            assert.equal(calls.length,0,'No server reads or file writes before confirmation');
            await panel.getByRole('textbox',{name:'새 채팅 파일 이름'}).fill('새로운 이름');
            await rename.click();
            await page.waitForFunction(()=>document.querySelector('.stmn-file-action')?.hidden===true);
            assert.deepEqual(calls.filter(x=>x.action==='rename'),
                [{action:'rename',from:'chat-b',to:'새로운 이름'}]);
            assert.equal(files.has('chat-b'),false);
            assert.equal(files.get('새로운 이름'),raw);
            assert.equal(await page.evaluate(()=>window.__stmnContext.chatId),'chat-a');
            // Every modification archives first and verifies the server result.
            assert.deepEqual(calls.slice(0,3).map(x=>x.action),['read','read','rename']);
            await page.locator('.stmn-quiet-global summary').click();
            await page.getByRole('button',{name:'복구 보관함'}).click();
            await page.locator('.stmn-recovery-bin').waitFor({state:'visible'});
            await page.locator('.stmn-bin-entry').first().waitFor({state:'visible'});
            assert.equal(await page.locator('.stmn-bin-entry').count(),1);
            const vaultMeta=await page.evaluate(async()=>{
                const mod=await import('/recovery-vault.js');
                const vault=new mod.RecoveryVault();
                const all=await vault.list();
                const archived=await vault.read(all[0].id);
                return {state:all[0].state,raw:archived.raw,hash:archived.meta.hash};
            });
            assert.equal(vaultMeta.state,'renamed');
            assert.equal(vaultMeta.raw,raw);
            assert.equal(vaultMeta.hash.length,64);
            await page.locator('.stmn-bin-entry').getByRole('button',{name:'복구본 만들기'}).click();
            await page.waitForFunction(()=>document.querySelector('.stmn-bin-status')?.textContent.includes('새 채팅'));
            const restoredName=[...files.keys()].find(x=>x.includes('restored'));
            assert.ok(restoredName,'Restoration should create a unique new chat instead of replacing renamed one');
            assert.equal(files.get('새로운 이름'),raw);
            assert.deepEqual(JSON.parse(files.get(restoredName).split('\n')[1]).swipes,['첫번째','둘째']);
        });


        await check('Q12 Quiet message menus are exclusive, dismissible, and remain opaque on hidden rows',async setup=>{
            const page=await setup(7);
            await page.evaluate(()=>{
                const ctx=window.__stmnContext;
                ctx.chat[4].is_system=true;
                window.__stmnSaveMetadata=0;
                ctx.saveMetadata=async()=>{window.__stmnSaveMetadata++;};
                window.__stmnView.elevator.applyTheme('quiet','auto');
            });
            await page.locator('[data-action="outline"]').click();
            const first=page.locator('.stmn-row[data-index="3"] .stmn-quiet-message-menu');
            const second=page.locator('.stmn-row[data-index="4"] .stmn-quiet-message-menu');
            await first.locator('summary').click();
            assert.equal(await first.evaluate(node=>node.open),true);
            await second.locator('summary').click();
            assert.equal(await first.evaluate(node=>node.open),false);
            assert.equal(await second.evaluate(node=>node.open),true);
            assert.equal(await page.locator('.stmn-quiet-message-menu[open]').count(),1);
            const render=await second.evaluate(menu=>{
                const row=menu.closest('.stmn-row');
                const content=row.querySelector('.stmn-row-body');
                const body=menu.querySelector('.stmn-quiet-message-menu-body');
                const action=body.querySelector('button');
                const r=action.getBoundingClientRect();
                const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
                return {row:getComputedStyle(row).opacity,
                    content:getComputedStyle(content).opacity,
                    menu:getComputedStyle(menu).opacity,
                    body:getComputedStyle(body).opacity,
                    clickable:action===hit || action.contains(hit)};
            });
            assert.equal(render.row,'1');
            assert.equal(render.content,'0.57');
            assert.equal(render.menu,'1');
            assert.equal(render.body,'1');
            assert.equal(render.clickable,true,'underlying sibling rows must not intercept menu clicks');
            await second.getByRole('button',{name:'메시지 숨김 해제'}).click();
            await page.waitForFunction(()=>window.__stmnContext.chat[4].is_system===false);
            assert.equal(await page.evaluate(()=>window.__stmnSaveMetadata),1);
            assert.equal(await page.locator('.stmn-row[data-index="4"].stmn-hidden-message').count(),0);
            await page.locator('.stmn-row[data-index="3"] .stmn-quiet-message-menu summary').click();
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('.stmn-quiet-message-menu[open]').count(),0);
            assert.equal(await page.locator('.stmn-outline').isVisible(),true,
                'Escape closes the menu, not the whole outline');
            await page.locator('.stmn-row[data-index="3"] .stmn-quiet-message-menu summary').click();
            await page.getByRole('button',{name:'메시지 다중 선택',exact:true}).click();
            assert.equal(await page.locator('.stmn-quiet-message-menu[open]').count(),0);
        });

        await check('Q12 Quiet chat management menus never overlap when choosing another chat',async setup=>{
            const page=await setup(3);
            await page.evaluate(()=>window.__stmnView.elevator.applyTheme('quiet','auto'));
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('tab',{name:'건물 로비'}).click();
            const cards=page.locator('.stmn-library-card');
            await cards.first().waitFor();
            const menuA=cards.nth(0).locator('.stmn-quiet-item-menu');
            const menuB=cards.nth(1).locator('.stmn-quiet-item-menu');
            await menuA.locator('summary').click();
            assert.equal(await menuA.evaluate(x=>x.open),true);
            await menuB.locator('summary').click();
            assert.equal(await menuA.evaluate(x=>x.open),false);
            assert.equal(await menuB.evaluate(x=>x.open),true);
            assert.equal(await page.locator('.stmn-quiet-item-menu[open]').count(),1);
            await menuB.locator('summary').click();
            assert.equal(await page.locator('.stmn-quiet-item-menu[open]').count(),0);
            // User-facing clicks have synchronous exclusivity. Programmatic
            // same-tick toggles are deliberately not treated as user intent.
            await menuA.locator('summary').click();
            assert.equal(await menuB.evaluate(x=>x.open),false);
            assert.equal(await page.locator('.stmn-quiet-item-menu[open]').count(),1);
        });

        await check('Q12 single hidden-message menu offers hide and hide-release without changing neighbors',async setup=>{
            const page=await setup(5);
            await page.evaluate(()=>{
                const ctx=window.__stmnContext;
                ctx.chat[2].is_system=true;
                ctx.saveMetadata=async()=>{};
                window.__stmnView.elevator.applyTheme('quiet','auto');
            });
            await page.locator('[data-action="outline"]').click();
            const menu=page.locator('.stmn-row[data-index="2"] .stmn-quiet-message-menu');
            await menu.locator('summary').click();
            await menu.getByRole('button',{name:'메시지 숨김 해제'}).click();
            await page.waitForFunction(()=>window.__stmnContext.chat[2].is_system===false);
            await page.locator('.stmn-row[data-index="2"] .stmn-quiet-message-menu summary').click();
            await page.locator('.stmn-row[data-index="2"] .stmn-quiet-message-menu')
                .getByRole('button',{name:'메시지 숨기기',exact:true}).click();
            await page.waitForFunction(()=>window.__stmnContext.chat[2].is_system===true);
            assert.deepEqual(await page.evaluate(()=>window.__stmnContext.chat.map(x=>x.is_system===true)),
                [false,false,true,false,false]);
        });

        await check('Q12 single message deletion requires server-verified ZIP and explicit confirmation',async setup=>{
            const page=await setup(6);
            const reads=[];
            await page.route('**/api/chats/export',async route=>{
                reads.push(route.request().postDataJSON().file);
                const raw=await page.evaluate(()=>{
                    const ctx=window.__stmnContext;
                    return [JSON.stringify({chat_metadata:ctx.chatMetadata}),
                        ...ctx.chat.map(m=>JSON.stringify(m))].join('\n')+'\n';
                });
                await route.fulfill({status:200,contentType:'application/json',
                    body:JSON.stringify({result:raw})});
            });
            await page.evaluate(()=>{
                const ctx=window.__stmnContext;
                window.__stmnDeleteCalls=[];
                window.__stmnNativeSaves=0;
                ctx.getRequestHeaders=()=>({'Content-Type':'application/json'});
                ctx.saveChat=async()=>{window.__stmnNativeSaves++;};
                ctx.deleteMessage=async(index,swipe,confirm,withTools)=>{
                    window.__stmnDeleteCalls.push([index,swipe,confirm,withTools]);
                    ctx.chat.splice(index,1);
                    document.querySelector('#chat > .mes[mesid="'+index+'"]')?.remove();
                    for(const row of document.querySelectorAll('#chat > .mes[mesid]')){
                        const i=Number(row.getAttribute('mesid'));
                        if(i>index)row.setAttribute('mesid',String(i-1));
                    }
                };
                const host=document.getElementById('chat');
                host.replaceChildren();
                for(let i=0;i<ctx.chat.length;i++){
                    const el=document.createElement('div');
                    el.className='mes';el.setAttribute('mesid',String(i));
                    host.append(el);
                }
                window.__stmnView.elevator.applyTheme('quiet','auto');
            });
            const original=await page.evaluate(()=>window.__stmnContext.chat.map(m=>m.mes));
            await page.locator('[data-action="outline"]').click();
            const menu=page.locator('.stmn-row[data-index="3"] .stmn-quiet-message-menu');
            await menu.locator('summary').click();
            await menu.getByRole('button',{name:'메시지 삭제'}).click();
            const dialog=page.locator('.stmn-single-message-dialog');
            await dialog.waitFor({state:'visible'});
            assert.equal(await dialog.getByRole('button',{name:'③ 메시지 영구 삭제'}).isDisabled(),true);
            assert.deepEqual(reads,[]);
            assert.deepEqual(await page.evaluate(()=>window.__stmnDeleteCalls),[]);
            const downloadPromise=page.waitForEvent('download');
            await dialog.getByRole('button',{name:'① 원본 채팅 ZIP 다운로드'}).click();
            const download=await downloadPromise;
            assert.match(download.suggestedFilename(),/before-single-message-3-delete\.zip$/);
            await page.waitForFunction(()=>document.querySelector('.stmn-single-message-confirm input')?.disabled===false);
            assert.equal(await dialog.getByRole('button',{name:'③ 메시지 영구 삭제'}).isDisabled(),true);
            await dialog.getByRole('checkbox',{name:/원본 ZIP 파일을 저장했고/}).check();
            await dialog.getByRole('button',{name:'③ 메시지 영구 삭제'}).click();
            await page.waitForFunction(()=>window.__stmnDeleteCalls.length===1);
            await page.waitForFunction(()=>document.querySelector('.stmn-single-message-overlay')?.hidden===true);
            assert.deepEqual(await page.evaluate(()=>window.__stmnDeleteCalls.map(([id,_swipe,confirm,tools])=>[id,confirm,tools])),[[3,false,false]]);
            assert.deepEqual(await page.evaluate(()=>window.__stmnContext.chat.map(m=>m.mes)),
                original.filter((_,i)=>i!==3));
            assert.equal(await page.evaluate(()=>window.__stmnNativeSaves),2);
            assert.deepEqual(reads,['chat-a.jsonl','chat-a.jsonl','chat-a.jsonl']);
        });

        await check('Q12 single message deletion rejects an invalid backup without native mutations',async setup=>{
            const page=await setup(5);
            await page.route('**/api/chats/export',async route=>{
                await route.fulfill({status:200,contentType:'application/json',
                    body:JSON.stringify({result:'{"chat_metadata":{}}\n{"mes":"not-the-real-chat"}\n'})});
            });
            await page.evaluate(()=>{
                const ctx=window.__stmnContext;
                window.__stmnDeleted=0;
                ctx.getRequestHeaders=()=>({'Content-Type':'application/json'});
                ctx.saveChat=async()=>{};
                ctx.deleteMessage=async()=>{window.__stmnDeleted++;};
                window.__stmnView.elevator.applyTheme('quiet','auto');
            });
            await page.locator('[data-action="outline"]').click();
            const menu=page.locator('.stmn-row[data-index="2"] .stmn-quiet-message-menu');
            await menu.locator('summary').click();
            await menu.getByRole('button',{name:'메시지 삭제'}).click();
            await page.getByRole('button',{name:'① 원본 채팅 ZIP 다운로드'}).click();
            await page.waitForFunction(()=>document.querySelector('.stmn-single-message-status')?.textContent.includes('백업 실패'));
            assert.equal(await page.getByRole('button',{name:'③ 메시지 영구 삭제'}).isDisabled(),true);
            assert.equal(await page.evaluate(()=>window.__stmnDeleted),0);
        });

        await check('D05A Quiet per-chat cover saves locally, displays, exports and unlinks without JSONL writes',async setup=>{
            const page=await setup(4);
            const writes=[];
            page.on('request',request=>{
                if(['/api/chats/save','/api/chats/delete','/api/chats/rename','/api/chats/group/save']
                    .some(path=>request.url().includes(path)))writes.push(request.url());
            });
            await page.evaluate(async()=>{
                const {changeLibrary}=await import('/library-operations.js');
                const owner=window.__stmnView.elevator;
                owner.callbacks.changeLibrary=action=>changeLibrary(owner.libraryUI.data,action);
                owner.applyTheme('quiet','auto');
            });
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('tab',{name:'건물 로비'}).click();
            await page.locator('.stmn-library-card').first().waitFor();
            const bytes=await page.evaluate(async()=>{
                const canvas=document.createElement('canvas');
                canvas.width=32;canvas.height=24;
                const ctx=canvas.getContext('2d');
                ctx.fillStyle='#66aa88';ctx.fillRect(0,0,32,24);
                const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
                return Array.from(new Uint8Array(await blob.arrayBuffer()));
            });
            const file={name:'cover.png',mimeType:'image/png',buffer:Buffer.from(bytes)};
            const second=()=>page.locator('.stmn-library-card').nth(1);
            await second().locator('.stmn-quiet-item-menu summary').click();
            const [chooser]=await Promise.all([
                page.waitForEvent('filechooser'),
                second().getByRole('button',{name:'표지 이미지 추가'}).click(),
            ]);
            await chooser.setFiles(file);
            await page.waitForFunction(()=>{
                const owner=window.__stmnView.elevator;
                return owner.libraryUI.data.records['["character:none","chat-b"]']?.imageRef?.startsWith('stmn-cover:');
            });
            const ref=await page.evaluate(()=>window.__stmnView.elevator.libraryUI.data
                .records['["character:none","chat-b"]'].imageRef);
            await second().locator('.stmn-chat-cover-thumb').waitFor({state:'visible'});
            const thumb=await second().locator('.stmn-chat-cover-thumb').evaluate(img=>({
                loaded:img.complete&&img.naturalWidth>0,
                src:img.src,
            }));
            assert.equal(thumb.loaded,true);
            assert.match(thumb.src,/^blob:/);
            const details=await page.evaluate(async()=>{
                const {ChatCoverStore}=await import('/chat-cover-store.js');
                const store=new ChatCoverStore();
                const ref=window.__stmnView.elevator.libraryUI.data
                    .records['["character:none","chat-b"]'].imageRef;
                const blob=await store.get(ref);
                const exportFile=await store.export(ref);
                store.destroy();
                return {bytes:blob.size,mime:blob.type,filename:exportFile.filename};
            });
            assert.equal(details.mime,'image/png');
            assert.equal(details.bytes,bytes.length);
            assert.match(details.filename,/\.png$/);
            await second().locator('.stmn-quiet-item-menu summary').click();
            const downloadPromise=page.waitForEvent('download');
            await second().getByRole('button',{name:'표지 이미지 별도 백업'}).click();
            const download=await downloadPromise;
            assert.equal(download.suggestedFilename(),details.filename);
            await second().locator('.stmn-quiet-item-menu summary').click();
            page.once('dialog',dialog=>dialog.accept());
            await second().getByRole('button',{name:'표지 연결 해제'}).click();
            await page.waitForFunction(()=>window.__stmnView.elevator.libraryUI.data
                .records['["character:none","chat-b"]']?.imageRef===null);
            assert.equal(await second().locator('.stmn-chat-cover-thumb').count(),0);
            // Unlink does not destroy the content-addressed file because another
            // chat or library backup may still reference it.
            assert.equal(await page.evaluate(async ref=>{
                const {ChatCoverStore}=await import('/chat-cover-store.js');
                const store=new ChatCoverStore();
                return Boolean(await store.get(ref));
            },ref),true);
            await second().locator('.stmn-quiet-item-menu summary').click();
            const [again]=await Promise.all([
                page.waitForEvent('filechooser'),
                second().getByRole('button',{name:'표지 이미지 추가'}).click(),
            ]);
            await again.setFiles(file);
            await page.waitForFunction(()=>window.__stmnView.elevator.libraryUI.data
                .records['["character:none","chat-b"]']?.imageRef?.startsWith('stmn-cover:'));
            assert.equal(await page.evaluate(()=>window.__stmnView.elevator.libraryUI.data
                .records['["character:none","chat-b"]'].imageRef),ref,
                're-importing an exported cover recovers the same content address');
            assert.deepEqual(writes,[]);
        });

        await check('D05A rejects SVG spoofed file and leaves library cover reference unchanged',async setup=>{
            const page=await setup(3);
            await page.evaluate(async()=>{
                const {changeLibrary}=await import('/library-operations.js');
                const owner=window.__stmnView.elevator;
                owner.callbacks.changeLibrary=action=>changeLibrary(owner.libraryUI.data,action);
                owner.applyTheme('quiet','auto');
            });
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('tab',{name:'건물 로비'}).click();
            await page.locator('.stmn-library-card').first().waitFor();
            const second=page.locator('.stmn-library-card').nth(1);
            await second.locator('.stmn-quiet-item-menu summary').click();
            const [chooser]=await Promise.all([
                page.waitForEvent('filechooser'),
                second.getByRole('button',{name:'표지 이미지 추가'}).click(),
            ]);
            await chooser.setFiles({
                name:'bad.svg',mimeType:'image/svg+xml',
                buffer:Buffer.from('<svg onload="alert(1)"></svg>'),
            });
            await page.waitForFunction(()=>document.querySelector('.stmn-library-error')?.textContent.includes('표지 등록 실패'));
            assert.equal(await page.evaluate(()=>window.__stmnView.elevator.libraryUI.data
                .records['["character:none","chat-b"]']?.imageRef??null),null);
            assert.equal(await page.locator('.stmn-chat-cover-thumb').count(),0);
        });

        await check('Q11 drag preview changes no live chat until ZIP consent and explicit apply',async setup=>{
            const page=await setup(8);
            const reads=[];
            await page.evaluate(()=>{
                const ctx=window.__stmnContext;
                window.__stmnSaves=0;
                window.__stmnReloads=0;
                window.__serializeChat=()=>[JSON.stringify({chat_metadata:ctx.chatMetadata}),
                    ...ctx.chat.map(message=>JSON.stringify(message))].join('\n')+'\n';
                window.__diskChat=window.__serializeChat();
                ctx.getRequestHeaders=()=>({'Content-Type':'application/json'});
                ctx.saveChat=async()=>{
                    window.__stmnSaves++;
                    window.__diskChat=window.__serializeChat();
                };
                ctx.reloadCurrentChat=async()=>{window.__stmnReloads++;};
                window.__stmnView.elevator.applyTheme('quiet','auto');
            });
            await page.route('**/api/chats/export',async route=>{
                reads.push(route.request().postDataJSON().file);
                const current=await page.evaluate(()=>window.__diskChat);
                await route.fulfill({status:200,contentType:'application/json',
                    body:JSON.stringify({result:current})});
            });
            const original=await page.evaluate(()=>window.__stmnContext.chat.map(x=>x.mes));
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('button',{name:'메시지 순서 변경 모드'}).click();
            assert.equal(await page.locator('.stmn-reorder-panel').isVisible(),true);
            const source=page.getByRole('button',{name:'원래 #0 메시지 드래그 손잡이'});
            const target=page.locator('.stmn-reorder-row[data-position="2"]');
            const a=await source.boundingBox(),b=await target.boundingBox();
            assert.ok(a&&b,'first and third rows are rendered');
            await page.mouse.move(a.x+a.width/2,a.y+a.height/2);
            await page.mouse.down();
            await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:8});
            await page.mouse.up();
            await page.waitForFunction(()=>document.querySelector('.stmn-reorder-summary')?.textContent.includes('3개 위치 변경'));
            assert.deepEqual(await page.evaluate(()=>window.__stmnContext.chat.map(x=>x.mes)),original);
            assert.equal(await page.evaluate(()=>window.__stmnSaves),0);
            assert.equal(await page.getByRole('button',{name:'③ 수정 사항 적용'}).isDisabled(),true);
            await page.getByRole('button',{name:'① 원본 ZIP 다운로드'}).click();
            await page.waitForFunction(()=>document.querySelector('.stmn-reorder-confirm input')?.disabled===false);
            assert.deepEqual(await page.evaluate(()=>window.__stmnContext.chat.map(x=>x.mes)),original);
            assert.equal(await page.evaluate(()=>window.__stmnSaves),1,'backup flush only');
            await page.getByRole('checkbox',{name:/원본 ZIP을 보관했습니다/}).check();
            await page.getByRole('button',{name:'③ 수정 사항 적용'}).click();
            await page.waitForFunction(()=>window.__stmnReloads===1);
            assert.deepEqual(await page.evaluate(()=>window.__stmnContext.chat.map(x=>x.mes)),
                [original[1],original[2],original[0],...original.slice(3)]);
            assert.equal(await page.evaluate(()=>window.__stmnSaves),2);
            assert.deepEqual(reads,['chat-a.jsonl','chat-a.jsonl','chat-a.jsonl']);
            assert.equal(await page.locator('.stmn-reorder-panel').isVisible(),false);
        });

        await check('Q11 cancel discards drag preview with zero chat or server writes',async setup=>{
            const page=await setup(7);
            await page.evaluate(()=>window.__stmnView.elevator.applyTheme('quiet','auto'));
            const original=await page.evaluate(()=>window.__stmnContext.chat.map(x=>x.mes));
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('button',{name:'메시지 순서 변경 모드'}).click();
            await page.getByRole('button',{name:'새 #1 메시지 한 칸 위로'}).click();
            assert.match(await page.locator('.stmn-reorder-summary').textContent(),/2개 위치 변경/);
            await page.getByRole('button',{name:'취소 · 변경 폐기'}).click();
            assert.deepEqual(await page.evaluate(()=>window.__stmnContext.chat.map(x=>x.mes)),original);
            assert.equal(await page.locator('.stmn-reorder-panel').isVisible(),false);
            assert.equal(await page.locator('.stmn-list').isVisible(),true);
        });

        await check('Q11 12000 message preview stays virtualized and reaches late messages',async setup=>{
            const page=await setup(12000);
            await page.evaluate(()=>window.__stmnView.elevator.applyTheme('quiet','auto'));
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('button',{name:'메시지 순서 변경 모드'}).click();
            assert.ok(await page.locator('.stmn-reorder-row').count()<55);
            await page.locator('.stmn-reorder-viewport').evaluate(node=>{
                node.scrollTop=node.scrollHeight-node.clientHeight;
                node.dispatchEvent(new Event('scroll'));
            });
            await page.waitForFunction(()=>Array.from(document.querySelectorAll('.stmn-reorder-row'))
                .some(node=>node.dataset.position==='11999'));
            assert.ok(await page.locator('.stmn-reorder-row').count()<55);
            await page.getByRole('button',{name:'취소 · 변경 폐기'}).click();
        });

        await check('Q11 Quiet chat description wraps fully at narrow width, including folder drawer',async setup=>{
            const page=await setup(4,{width:470,height:760});
            await page.evaluate(()=>window.__stmnView.elevator.applyTheme('quiet','auto'));
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('tab',{name:'건물 로비'}).click();
            await page.locator('.stmn-library-card').first().waitFor();
            const value='오래된 모험을 기록한 설명입니다. '.repeat(13)+'마지막 문장까지 보여야 합니다.';
            await page.evaluate(async value=>{
                const {emptyLibrary,emptyRecord,chatReference}=await import('/library-data.js');
                const data=emptyLibrary();
                data.records[chatReference('character:none','chat-b')]={
                    ...emptyRecord(),description:value,
                };
                window.__stmnView.elevator.libraryUI.setData(data,'character:none');
                window.__stmnView.elevator.renderBuildings();
            },value);
            const info=page.locator('.stmn-library-card').filter({hasText:'건물 B'});
            const description=info.locator('.stmn-quiet-chat-description');
            await description.waitFor();
            const measure=await description.evaluate(node=>{
                const font=getComputedStyle(node);
                const title=node.closest('.stmn-building-card-body').querySelector('.stmn-building-card-title');
                return {
                    full:node.textContent,
                    font:parseFloat(font.fontSize),
                    titleFont:parseFloat(getComputedStyle(title).fontSize),
                    whiteSpace:font.whiteSpace,
                    height:node.getBoundingClientRect().height,
                    lineHeight:parseFloat(font.lineHeight),
                    client:node.clientHeight,scroll:node.scrollHeight,
                };
            });
            assert.equal(measure.full,value);
            assert.ok(measure.font<measure.titleFont);
            assert.equal(measure.whiteSpace,'pre-wrap');
            assert.ok(measure.height>measure.lineHeight*2);
            assert.ok(measure.scroll<=measure.client+1,'description is not clipped');
            await page.evaluate(()=>window.__stmnView.elevator.libraryUI.setDrawerOpen(true));
            await page.locator('.stmn-quiet-folder-drawer').waitFor({state:'visible'});
            // Drawer content is intentionally lazy; expand a section before
            // asserting the small wrapping description is displayed.
            const section=page.locator('.stmn-quiet-folder-section').first();
            await section.locator('summary').click();
            const folderDescription=section.locator('.stmn-quiet-folder-chat-description').first();
            await folderDescription.waitFor({state:'visible'});
            const computed=await folderDescription.evaluate(node=>getComputedStyle(node).whiteSpace);
            assert.equal(computed,'pre-wrap');
        });

        await check('Q10 Quiet multi-message bookmarks and numbered titles with one ST save each',async setup=>{
            const page=await setup(8);
            await page.evaluate(()=>{
                window.__stmnView.elevator.applyTheme('quiet','auto');
                window.__stmnSaveCount=0;
                window.__stmnContext.saveMetadata=async()=>{window.__stmnSaveCount++;};
            });
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('button',{name:'메시지 다중 선택',exact:true}).click();
            await page.getByRole('checkbox',{name:'#0 메시지 선택'}).check();
            await page.getByRole('checkbox',{name:'#2 메시지 선택'}).check();
            await page.getByRole('checkbox',{name:'#4 메시지 선택'}).check();
            assert.match(await page.locator('.stmn-message-batch-summary').textContent(),/3\/20/);
            await page.getByRole('button',{name:'변경 적용'}).click();
            await page.waitForFunction(()=>window.__stmnSaveCount===1);
            const state=await page.evaluate(async()=>{
                const {DATA_KEY,MESSAGE_KEY}=await import('/model.js');
                const ctx=window.__stmnContext;
                return {
                    count:ctx.chat.length,
                    bookmarks:ctx.chat.map(m=>ctx.chatMetadata[DATA_KEY]?.bookmarks?.[m[MESSAGE_KEY]]===true),
                    saveCount:window.__stmnSaveCount,
                };
            });
            assert.equal(state.count,8);
            assert.deepEqual(state.bookmarks,[true,false,true,false,true,false,false,false]);
            assert.equal(state.saveCount,1);
            await page.getByRole('button',{name:'메시지 다중 선택',exact:true}).click();
            await page.getByRole('checkbox',{name:'#2 메시지 선택'}).check();
            await page.getByRole('checkbox',{name:'#4 메시지 선택'}).check();
            await page.getByRole('combobox',{name:'메시지 다중 편집 작업'}).selectOption('title');
            await page.getByRole('textbox',{name:'일괄 변경할 공통 메시지 제목'}).fill('첫 만남');
            await page.getByRole('button',{name:'변경 적용'}).click();
            await page.waitForFunction(()=>window.__stmnSaveCount===2);
            const titles=await page.evaluate(async()=>{
                const {DATA_KEY,MESSAGE_KEY}=await import('/model.js');
                const ctx=window.__stmnContext;
                return [2,4].map(i=>ctx.chatMetadata[DATA_KEY].titles[ctx.chat[i][MESSAGE_KEY]]);
            });
            assert.deepEqual(titles,['첫 만남 1','첫 만남 2']);
            assert.deepEqual(await page.evaluate(()=>window.__stmnContext.chat.map(m=>m.mes)),
                Array.from({length:8},(_,i)=>'메시지 '+i+' · 흥미로운 이야기 '+
                    (i===14?'비밀 #4는 여기에 있어요.':'이야기의 다음 장면입니다.')));
        });

        await check('Q10 hidden messages reflect native is_system flag and unhide safely',async setup=>{
            const page=await setup(6);
            await page.evaluate(()=>{
                window.__stmnView.elevator.applyTheme('quiet','auto');
                window.__stmnContext.saveMetadata=async()=>{};
            });
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('button',{name:'메시지 다중 선택',exact:true}).click();
            await page.getByRole('checkbox',{name:'#1 메시지 선택'}).check();
            await page.getByRole('checkbox',{name:'#3 메시지 선택'}).check();
            await page.getByRole('combobox',{name:'메시지 다중 편집 작업'}).selectOption('hide');
            await page.getByRole('button',{name:'변경 적용'}).click();
            await page.waitForFunction(()=>window.__stmnContext.chat[1].is_system===true);
            assert.equal(await page.locator('.stmn-row.stmn-hidden-message').count(),2);
            await page.getByRole('button',{name:'메시지 다중 선택',exact:true}).click();
            await page.getByRole('checkbox',{name:'#1 메시지 선택'}).check();
            await page.getByRole('checkbox',{name:'#3 메시지 선택'}).check();
            await page.getByRole('combobox',{name:'메시지 다중 편집 작업'}).selectOption('show');
            await page.getByRole('button',{name:'변경 적용'}).click();
            await page.waitForFunction(()=>window.__stmnContext.chat[1].is_system===false);
            assert.equal(await page.locator('.stmn-row.stmn-hidden-message').count(),0);
        });

        await check('Q10 deletion is gated by verified ZIP download and native descending deletes',async setup=>{
            const page=await setup(8);
            const reads=[];
            await page.route('**/api/chats/export',async route=>{
                const payload=route.request().postDataJSON();
                reads.push(payload.file);
                const raw=await page.evaluate(()=>{
                    const ctx=window.__stmnContext;
                    return [JSON.stringify({chat_metadata:ctx.chatMetadata}),
                        ...ctx.chat.map(m=>JSON.stringify(m))].join('\n')+'\n';
                });
                await route.fulfill({status:200,contentType:'application/json',
                    body:JSON.stringify({result:raw})});
            });
            await page.evaluate(()=>{
                window.__stmnView.elevator.applyTheme('quiet','auto');
                window.__stmnDeleted=[];
                const ctx=window.__stmnContext;
                ctx.getRequestHeaders=()=>({'Content-Type':'application/json'});
                ctx.saveChat=async()=>{};
                ctx.deleteMessage=async(index,_swipe,_confirm,tools)=>{
                    if(tools!==false)throw Error('unexpected deletion of neighboring tool calls');
                    window.__stmnDeleted.push(index);
                    ctx.chat.splice(index,1);
                    document.querySelector('#chat > .mes[mesid="'+index+'"]')?.remove();
                    document.querySelectorAll('#chat > .mes[mesid]').forEach(node=>{
                        const n=Number(node.getAttribute('mesid'));
                        if(n>index)node.setAttribute('mesid',String(n-1));
                    });
                };
                const host=document.getElementById('chat');
                host.replaceChildren();
                for(let i=0;i<ctx.chat.length;i++){
                    const row=document.createElement('div');
                    row.className='mes';row.setAttribute('mesid',String(i));
                    host.append(row);
                }
            });
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('button',{name:'메시지 다중 선택',exact:true}).click();
            await page.getByRole('checkbox',{name:'#2 메시지 선택'}).check();
            await page.getByRole('checkbox',{name:'#5 메시지 선택'}).check();
            await page.getByRole('combobox',{name:'메시지 다중 편집 작업'}).selectOption('delete');
            const submit=page.getByRole('button',{name:'③ 선택 메시지 영구 삭제'});
            assert.equal(await submit.isDisabled(),true);
            assert.deepEqual(reads,[]);
            await page.getByRole('button',{name:'① 원본 ZIP 다운로드'}).click();
            await page.waitForFunction(()=>document.querySelector('.stmn-message-batch-confirm input')?.disabled===false);
            assert.equal(await submit.isDisabled(),true);
            assert.deepEqual(await page.evaluate(()=>window.__stmnDeleted),[]);
            await page.getByRole('checkbox',{name:/백업 파일을 보관했고/}).check();
            await submit.click();
            await page.waitForFunction(()=>window.__stmnDeleted.length===2);
            assert.deepEqual(await page.evaluate(()=>window.__stmnDeleted),[5,2]);
            assert.equal(await page.evaluate(()=>window.__stmnContext.chat.length),6);
            assert.equal(reads.length,3,'prepare, preflight and post-delete verification');
        });

        await check('Q09 Quiet copy stages new chat and verifies source/destination before metadata clone',async setup=>{
            const page=await setup(3);
            const raw='{"chat_metadata":{}}\n{"mes":"원문 복제","swipes":["하나","둘"]}\n';
            const files=new Map([['chat-b',raw]]);
            const calls=[];
            await page.route('**/api/chats/export',async route=>{
                const payload=route.request().postDataJSON();
                const id=payload.file.slice(0,-6);
                calls.push({action:'read',id});
                if(!files.has(id)){
                    await route.fulfill({status:404,contentType:'application/json',body:'{}'});
                    return;
                }
                await route.fulfill({status:200,contentType:'application/json',
                    body:JSON.stringify({result:files.get(id)})});
            });
            await page.route('**/api/chats/save',async route=>{
                const payload=route.request().postDataJSON();
                calls.push({action:'save',id:payload.file_name});
                files.set(payload.file_name,payload.chat.map(x=>JSON.stringify(x)).join('\n'));
                await route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});
            });
            await page.route('**/api/chats/rename',async route=>{
                const payload=route.request().postDataJSON();
                const from=payload.original_file.slice(0,-6);
                const to=payload.renamed_file.slice(0,-6);
                calls.push({action:'rename',from,to});
                if(!files.has(from)||files.has(to)){
                    await route.fulfill({status:400,contentType:'application/json',body:'{}'});return;
                }
                files.set(to,files.get(from));files.delete(from);
                await route.fulfill({status:200,contentType:'application/json',
                    body:JSON.stringify({ok:true,sanitizedFileName:to})});
            });
            await page.evaluate(()=>{
                window.__stmnContext.getRequestHeaders=()=>({'Content-Type':'application/json'});
                window.__stmnView.elevator.applyTheme('quiet','auto');
            });
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('tab',{name:'건물 로비'}).click();
            const inactive=page.locator('.stmn-library-card').nth(1);
            await inactive.locator('.stmn-quiet-item-menu summary').click();
            await inactive.getByRole('button',{name:'채팅 파일 복제'}).click();
            const panel=page.locator('.stmn-file-action');
            await panel.waitFor({state:'visible'});
            assert.match(await panel.locator('input').inputValue(),/복사본/);
            assert.equal(calls.length,0);
            await panel.getByRole('textbox',{name:'새 채팅 파일 이름'}).fill('새로운 복제');
            await panel.getByRole('button',{name:'복제',exact:true}).click();
            await page.waitForFunction(()=>document.querySelector('.stmn-file-action')?.hidden===true);
            assert.equal(files.get('chat-b'),raw);
            assert.equal(files.has('새로운 복제'),true);
            assert.deepEqual(calls.filter(c=>c.action==='save').length,1);
            const staged=calls.find(x=>x.action==='save')?.id;
            assert.match(staged,/^stmn-copy-/);
            assert.deepEqual(calls.filter(c=>c.action==='rename').map(x=>[x.from,x.to]),
                [[staged,'새로운 복제']]);
            assert.equal(files.has(staged),false);
            assert.equal(await page.evaluate(()=>window.__stmnContext.chatId),'chat-a');
        });

        await check('Q07C single delete confirmation preserves archive on a 503 failure',async setup=>{
            const page=await setup(3);
            let deletes=0;
            await page.route('**/api/chats/export',async route=>{
                await route.fulfill({status:200,contentType:'application/json',
                    body:JSON.stringify({result:'{"chat_metadata":{}}\n{"mes":"backup"}\n'})});
            });
            await page.route('**/api/chats/delete',async route=>{
                deletes++;
                await route.fulfill({status:503,contentType:'application/json',
                    body:JSON.stringify({error:true})});
            });
            await page.evaluate(()=>{
                window.__stmnContext.getRequestHeaders=()=>({'Content-Type':'application/json'});
                window.__stmnView.elevator.applyTheme('quiet','auto');
            });
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('tab',{name:'건물 로비'}).click();
            const inactive=page.locator('.stmn-library-card').nth(1);
            await inactive.locator('.stmn-quiet-item-menu summary').click();
            await inactive.getByRole('button',{name:'파일 삭제'}).click();
            const panel=page.locator('.stmn-file-action');
            await panel.waitFor({state:'visible'});
            assert.equal(await panel.getByRole('textbox').count(),0);
            assert.equal(await panel.getByRole('checkbox').count(),0);
            assert.equal(deletes,0);
            await panel.getByRole('button',{name:'삭제',exact:true}).click();
            await page.waitForFunction(()=>document.querySelector('.stmn-file-action')?.hidden===true);
            assert.equal(deletes,1);
            const archive=await page.evaluate(async()=>{
                const {RecoveryVault}=await import('/recovery-vault.js');
                const vault=new RecoveryVault();const rows=await vault.list();
                return {state:rows[0]?.state,raw:(await vault.read(rows[0].id)).raw};
            });
            assert.equal(archive.state,'uncertain','Uncertain deletion must keep a recovery copy');
            assert.ok(archive.raw.includes('"mes":"backup"'));
            assert.equal(await page.evaluate(()=>window.__stmnContext.chatId),'chat-a');
            await page.locator('.stmn-quiet-global summary').click();
            await page.getByRole('button',{name:'복구 보관함'}).click();
            await page.locator('.stmn-bin-entry').first().waitFor({state:'visible'});
            assert.ok(await page.locator('.stmn-bin-entry').first().innerText().then(x=>x.includes('결과 확인 필요')));
            await page.locator('.stmn-bin-entry').getByRole('button',{name:'서버 상태 확인'}).click();
            await page.waitForFunction(()=>document.querySelector('.stmn-bin-status')?.textContent.includes('원본 파일'));
            assert.equal(deletes,1,'read-only audit must never retry deletion');
        });

        await check('Q07C IndexedDB unavailable means file deletion is NEVER called',async setup=>{
            const page=await setup(3);
            let deletes=0;
            await page.route('**/api/chats/export',async route=>{
                await route.fulfill({status:200,contentType:'application/json',
                    body:JSON.stringify({result:'{"chat_metadata":{}}\n{"mes":"backup"}\n'})});
            });
            await page.route('**/api/chats/delete',async route=>{
                deletes++;
                await route.fulfill({status:200,contentType:'application/json',
                    body:JSON.stringify({ok:true})});
            });
            await page.evaluate(()=>{
                window.__stmnContext.getRequestHeaders=()=>({'Content-Type':'application/json'});
                window.__stmnView.elevator.applyTheme('quiet','auto');
                Object.defineProperty(window,'indexedDB',{value:undefined,configurable:true});
            });
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('tab',{name:'건물 로비'}).click();
            const inactive=page.locator('.stmn-library-card').nth(1);
            await inactive.locator('.stmn-quiet-item-menu summary').click();
            await inactive.getByRole('button',{name:'파일 삭제'}).click();
            await page.locator('.stmn-file-action').getByRole('button',{name:'삭제',exact:true}).click();
            await page.waitForFunction(()=>document.querySelector('.stmn-file-action')?.hidden===true);
            assert.equal(deletes,0);
        });

        await check('Q07A explicit multi-select ZIP preserves raw JSONL and skips any file writes', async setup => {
            const page=await setup(3);
            const calls=[];
            await page.route('**/api/chats/export',async route=>{
                const payload=route.request().postDataJSON();
                calls.push(payload);
                await route.fulfill({status:200,contentType:'application/json',
                    body:JSON.stringify({result:'{"chat_metadata":{}}\n{"mes":"'+payload.file+' 내용"}\n'})});
            });
            await page.evaluate(()=>{
                window.__stmnContext.getRequestHeaders=()=>({
                    'Content-Type':'application/json','X-CSRF-Token':'mock',
                });
                window.__stmnContext.saveChat=async()=>{
                    window.__q07SaveCalls=(window.__q07SaveCalls||0)+1;
                    return true;
                };
                window.__stmnView.elevator.applyTheme('quiet','auto');
            });
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('tab',{name:'건물 로비'}).click();
            await page.locator('.stmn-library-card').first().waitFor();
            assert.equal(await page.locator('.stmn-batch-checkbox').count(),0,
                'Ordinary Quiet view must remain minimal without batch checkboxes');
            const second=page.locator('.stmn-library-card').nth(1);
            await second.locator('.stmn-quiet-item-menu summary').click();
            await second.getByRole('button',{name:'다중 선택 · 정리 / 원본 백업'}).click();
            assert.equal(await page.locator('.stmn-batch-checkbox').count(),2);
            assert.equal(await page.locator('.stmn-batch-checkbox:checked').count(),1);
            await page.getByRole('checkbox',{name:'건물 A 선택'}).check();
            assert.equal(await page.locator('.stmn-batch-count').textContent(),'2개 선택');
            const downloadPromise=page.waitForEvent('download',{timeout:5000}).catch(()=>null);
            await page.getByRole('button',{name:'원본 백업 ZIP'}).click();
            await page.waitForTimeout(500);
            const status=await page.locator('.stmn-batch-status').textContent();
            const download=await downloadPromise;
            assert.ok(download,'ZIP 다운로드가 시작되지 않았습니다. UI 상태: '+status+
                ' / API 호출: '+JSON.stringify(calls));
            assert.ok(download.suggestedFilename().endsWith('.zip'));
            const file=await readFile(await download.path());
            assert.equal(file.readUInt32LE(0),0x04034b50);
            const tail=file.length-22;
            assert.equal(file.readUInt32LE(tail),0x06054b50);
            assert.equal(file.readUInt16LE(tail+10),2);
            assert.deepEqual(calls.map(x=>x.file).sort(),['chat-a.jsonl','chat-b.jsonl']);
            assert.ok(calls.every(x=>x.format==='jsonl' && x.is_group===false));
            assert.equal(await page.evaluate(()=>window.__q07SaveCalls),1,
                'The active chat must flush pending content using ST before export');
            assert.equal(await page.evaluate(()=>window.__stmnContext.chatId),'chat-a');
            assert.equal(await page.evaluate(()=>window.__stmnContext.chat.length),3);
            await page.getByRole('button',{name:'완료'}).click();
            assert.equal(await page.locator('.stmn-batch-toolbar').isVisible(),false);
            assert.equal(await page.locator('.stmn-batch-checkbox').count(),0);
        });

        await check('Q07A failed export leaves selection and chat untouched without creating a download', async setup => {
            const page=await setup(3);
            await page.route('**/api/chats/export',async route=>{
                await route.fulfill({status:404,contentType:'application/json',
                    body:JSON.stringify({message:'not found'})});
            });
            await page.evaluate(()=>{
                window.__stmnContext.getRequestHeaders=()=>({'Content-Type':'application/json'});
                window.__stmnView.elevator.applyTheme('quiet','auto');
            });
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('tab',{name:'건물 로비'}).click();
            await page.locator('.stmn-library-card').nth(1).locator('.stmn-quiet-item-menu summary').click();
            await page.locator('.stmn-library-card').nth(1)
                .getByRole('button',{name:'다중 선택 · 정리 / 원본 백업'}).click();
            await page.getByRole('button',{name:'원본 백업 ZIP'}).click();
            await page.waitForFunction(()=>document.querySelector('.stmn-batch-status')?.textContent.includes('404'));
            assert.equal(await page.locator('.stmn-batch-checkbox:checked').count(),1);
            assert.equal(await page.evaluate(()=>window.__stmnContext.chatId),'chat-a');
            assert.equal(await page.locator('.stmn-batch-toolbar').isVisible(),true);
        });

        await check('E03B explicit server search finds chat candidate without downloading full files',async setup=>{
            const page=await setup(3);
            const reads=[],writes=[],queries=[];
            await page.route('**/api/chats/search',async route=>{
                queries.push(route.request().postDataJSON());
                await route.fulfill({status:200,contentType:'application/json',
                    body:JSON.stringify([
                        {file_name:'chat-b.jsonl'},
                        {file_name:'outside-character.jsonl'},
                    ])});
            });
            page.on('request',request=>{
                const url=request.url();
                if(url.includes('/api/chats/get'))reads.push(url);
                if(['/api/chats/save','/api/chats/delete','/api/chats/rename']
                    .some(path=>url.includes(path)))writes.push(url);
            });
            await page.evaluate(()=>{
                window.__stmnContext.getRequestHeaders=()=>({'Content-Type':'application/json'});
                window.__stmnView.elevator.applyTheme('quiet','auto');
            });
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('tab',{name:'건물 로비'}).click();
            await page.locator('.stmn-library-card').first().waitFor();
            await page.locator('.stmn-quiet-list-menu summary').click();
            await page.getByRole('button',{name:'통합 검색 · 메시지 제목/본문'}).click();
            await page.getByRole('searchbox',{name:'통합 검색어'}).fill('독특한 단어');
            assert.equal(queries.length,0,'no server request until explicit click');
            await page.getByRole('button',{name:'대용량 본문 후보 찾기 · 서버 검색'}).click();
            await page.waitForFunction(()=>document.querySelectorAll('.stmn-chat-search-result').length===1);
            assert.deepEqual(queries,[{query:'독특한 단어',avatar_url:'none'}]);
            assert.deepEqual(reads,[],'server candidates must avoid browser full-chat reads');
            assert.match(await page.locator('.stmn-chat-search-result').textContent(),/번호는 채팅을 열어 확인/);
            await page.locator('.stmn-chat-search-result').click();
            await page.waitForFunction(()=>window.__stmnContext.chatId==='chat-b');
            assert.deepEqual(writes,[]);
        });

        await check('E03A Quiet search: metadata-only skips network; body search jumps to correct chat message',async setup=>{
            const page=await setup(3);
            const requests=[],writes=[];
            await page.route('**/api/chats/get',async route=>{
                requests.push(route.request().postDataJSON().file_name);
                await route.fulfill({status:200,contentType:'application/json',
                    body:JSON.stringify([
                        {chat_metadata:{}},
                        {name:'User',is_user:true,mes:'평범한 이야기'},
                        {name:'Character',is_user:false,mes:'사과를 찾은 순간'},
                    ])});
            });
            page.on('request',req=>{
                if(['/api/chats/save','/api/chats/delete','/api/chats/rename'].some(x=>req.url().includes(x)))
                    writes.push(req.url());
            });
            await page.evaluate(()=>{
                window.__stmnContext.getRequestHeaders=()=>({'Content-Type':'application/json'});
                window.__stmnView.elevator.applyTheme('quiet','auto');
            });
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('tab',{name:'건물 로비'}).click();
            await page.locator('.stmn-library-card').first().waitFor();
            assert.equal(await page.locator('.stmn-chat-search').isVisible(),false);
            await page.locator('.stmn-quiet-list-menu summary').click();
            await page.getByRole('button',{name:'통합 검색 · 메시지 제목/본문'}).click();
            await page.getByRole('searchbox',{name:'통합 검색어'}).fill('건물');
            await page.getByLabel('메시지 제목',{exact:true}).uncheck();
            await page.getByLabel('메시지 본문',{exact:true}).uncheck();
            await page.getByRole('button',{name:'검색',exact:true}).click();
            await page.waitForFunction(()=>document.querySelectorAll('.stmn-chat-search-result').length===2);
            assert.deepEqual(requests,[],'metadata-only search must not fetch chat JSON');
            await page.getByRole('searchbox',{name:'통합 검색어'}).fill('사과');
            await page.getByLabel('파일명·설명·폴더·태그').uncheck();
            await page.getByLabel('메시지 제목',{exact:true}).check();
            await page.getByLabel('메시지 본문',{exact:true}).check();
            await page.getByRole('button',{name:'검색',exact:true}).click();
            await page.waitForFunction(()=>document.querySelectorAll('.stmn-chat-search-result').length===1);
            assert.deepEqual(requests,['chat-b']);
            assert.match(await page.locator('.stmn-chat-search-result').textContent(),/사과/);
            await page.locator('.stmn-chat-search-result').click();
            await page.waitForFunction(()=>window.__stmnContext.chatId==='chat-b');
            await page.waitForFunction(()=>window.__stmnActions.includes(1));
            assert.equal(await page.locator('.stmn-chat-search').isVisible(),false);
            assert.deepEqual(writes,[]);
        });

        await check('E03A 26 chats fetch exactly one bounded page until next click',async setup=>{
            const page=await setup(3);
            const fetched=[];
            await page.route('**/api/chats/get',async route=>{
                fetched.push(route.request().postDataJSON().file_name);
                await route.fulfill({status:200,contentType:'application/json',
                    body:JSON.stringify([{chat_metadata:{}},{mes:'없는 단어'}])});
            });
            await page.evaluate(()=>{
                window.__stmnContext.getRequestHeaders=()=>({'Content-Type':'application/json'});
                window.__stmnView.callbacks.listBuildings=async()=>({
                    scope:'character:none',title:'Character',
                    buildings:Array.from({length:26},(_,i)=>({
                        id:i===0?'chat-a':'chat-'+i,
                        name:'Chat '+i,lastActivity:1000-i,count:2,
                    })),
                });
                window.__stmnView.elevator.applyTheme('quiet','auto');
            });
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('tab',{name:'건물 로비'}).click();
            await page.locator('.stmn-library-card').first().waitFor();
            await page.locator('.stmn-quiet-list-menu summary').click();
            await page.getByRole('button',{name:'통합 검색 · 메시지 제목/본문'}).click();
            await page.getByRole('searchbox',{name:'통합 검색어'}).fill('찾기');
            assert.deepEqual(fetched,[],'opening and typing must not start a scan');
            await page.getByRole('button',{name:'검색',exact:true}).click();
            await page.waitForFunction(()=>document.querySelector('.stmn-chat-search-status')?.textContent.includes('12 / 26'));
            assert.equal(fetched.length,11,'page one includes in-memory active chat');
            await page.getByRole('button',{name:'다음 12개 채팅 검색'}).click();
            await page.waitForFunction(()=>document.querySelector('.stmn-chat-search-status')?.textContent.includes('24 / 26'));
            assert.equal(fetched.length,23);
            await page.getByRole('button',{name:'다음 12개 채팅 검색'}).click();
            await page.waitForFunction(()=>document.querySelector('.stmn-chat-search-status')?.textContent.includes('26 / 26'));
            assert.equal(fetched.length,25);
            assert.equal(await page.getByRole('button',{name:'다음 12개 채팅 검색'}).isVisible(),false);
        });

        await check('E03A changing tabs cancels in-flight read without stale results',async setup=>{
            const page=await setup(3);
            await page.route('**/api/chats/get',async route=>{
                await new Promise(resolve=>setTimeout(resolve,500));
                await route.fulfill({status:200,contentType:'application/json',
                    body:JSON.stringify([{chat_metadata:{}},{mes:'사과'}])}).catch(()=>{});
            });
            await page.evaluate(()=>{
                window.__stmnContext.getRequestHeaders=()=>({'Content-Type':'application/json'});
                window.__stmnView.elevator.applyTheme('quiet','auto');
            });
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('tab',{name:'건물 로비'}).click();
            await page.locator('.stmn-library-card').first().waitFor();
            await page.locator('.stmn-quiet-list-menu summary').click();
            await page.getByRole('button',{name:'통합 검색 · 메시지 제목/본문'}).click();
            await page.getByRole('searchbox',{name:'통합 검색어'}).fill('사과');
            await page.getByRole('button',{name:'검색',exact:true}).click();
            await page.getByRole('tab',{name:'층 안내'}).click();
            await page.waitForTimeout(600);
            assert.equal(await page.locator('.stmn-chat-search').isVisible(),false);
            assert.equal(await page.locator('.stmn-chat-search-result').count(),0);
        });

        await check('Q08 Quiet multi-select organizes folders and tags without touching JSONL',async setup=>{
            const page=await setup(3);
            const mutationRequests=[];
            page.on('request',request=>{
                const url=request.url();
                if(['/api/chats/save','/api/chats/delete','/api/chats/rename',
                    '/api/chats/group/save'].some(path=>url.includes(path)))
                    mutationRequests.push(url);
            });
            await page.evaluate(async()=>{
                const {LibraryRepository}=await import('/library-repository.js');
                const {emptyLibrary,LIBRARY_KEY}=await import('/library-data.js');
                const context=window.__stmnContext;
                const library=emptyLibrary();
                library.folders=[{id:'f1',name:'진행 중'}];
                library.tags=[{id:'t1',name:'중요'}];
                context.extensionSettings={[LIBRARY_KEY]:library};
                window.__q08Saves=0;
                context.saveSettingsDebounced=()=>{window.__q08Saves++;};
                const repo=new LibraryRepository(()=>context);
                window.__stmnView.callbacks.libraryRepository=repo;
                window.__stmnView.callbacks.readLibrary=()=>repo.read();
                window.__stmnView.callbacks.changeLibrary=action=>repo.update(action);
                window.__stmnView.elevator.applyTheme('quiet','auto');
            });
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('tab',{name:'건물 로비'}).click();
            const second=page.locator('.stmn-library-card').nth(1);
            await second.locator('.stmn-quiet-item-menu summary').click();
            await second.getByRole('button',{name:'다중 선택 · 정리 / 원본 백업'}).click();
            await page.getByRole('checkbox',{name:'건물 A 선택'}).check();
            assert.equal(await page.locator('.stmn-batch-count').textContent(),'2개 선택');
            await page.getByRole('button',{name:'일괄 정리'}).click();
            await page.getByRole('combobox',{name:'일괄 정리 종류'}).selectOption('folder');
            await page.getByRole('combobox',{name:'일괄 정리 대상 폴더 또는 태그'}).selectOption('f1');
            await page.getByRole('button',{name:'선택한 채팅에 적용'}).click();
            let data=await page.evaluate(()=>{
                const l=window.__stmnContext.extensionSettings.stmn_library_v1;
                return {records:l.records,writes:window.__q08Saves};
            });
            assert.equal(data.records['["character:none","chat-a"]'].folderId,'f1');
            assert.equal(data.records['["character:none","chat-b"]'].folderId,'f1');
            assert.equal(data.writes,1,'two chat edits must request one settings save');

            await page.getByRole('button',{name:'일괄 정리'}).click();
            await page.getByRole('combobox',{name:'일괄 정리 종류'}).selectOption('tag-add');
            await page.getByRole('combobox',{name:'일괄 정리 대상 폴더 또는 태그'}).selectOption('t1');
            await page.getByRole('button',{name:'선택한 채팅에 적용'}).click();
            data=await page.evaluate(()=>{
                const l=window.__stmnContext.extensionSettings.stmn_library_v1;
                return {records:l.records,writes:window.__q08Saves};
            });
            assert.deepEqual(data.records['["character:none","chat-a"]'].tagIds,['t1']);
            assert.deepEqual(data.records['["character:none","chat-b"]'].tagIds,['t1']);
            assert.equal(data.writes,2);
            assert.deepEqual(mutationRequests,[]);
            assert.equal(await page.evaluate(()=>window.__stmnContext.chatId),'chat-a');
            await page.getByRole('button',{name:'완료'}).click();
            assert.equal(await page.locator('.stmn-batch-toolbar').isVisible(),false);
        });

        await check('Q06 native message toolbar saves favorites/tags, filters, compares and selects swipe', async setup => {
            const page=await setup(2,undefined,true);
            await page.evaluate(()=>{
                const ctx=window.__themeAppContext;
                ctx.chat[0].swipes=[
                    '첫 번째 전체 원문 '+ '가'.repeat(1250),
                    '두 번째 후보 '+ '나'.repeat(1350),
                    '세 번째 비교 대상 '+ '다'.repeat(1460),
                ];
                ctx.chat[0].swipe_id=0;
                ctx.chat[0].mes=ctx.chat[0].swipes[0];
                ctx.chat[0].swipe_info=[{key:'keep1'},{key:'keep2'},{key:'keep3'}];
                ctx.chatMetadata={outside:{keep:true}};
                window.__q06Saves=0;window.__q06Swipes=[];
                ctx.saveMetadata=async()=>{
                    window.__q06Saves++;
                    window.__q06Snapshot=structuredClone(ctx.chatMetadata);
                };
                ctx.swipe={to:async (_event,_direction,options)=>{
                    window.__q06Swipes.push(options);
                    const m=ctx.chat[options.forceMesId];
                    m.swipe_id=options.forceSwipeId;
                    m.mes=m.swipes[options.forceSwipeId];
                }};
                const host=document.querySelector('#chat');
                for(let i=0;i<2;i++){
                    const row=document.createElement('div');
                    row.className='mes';row.setAttribute('mesid',String(i));
                    row.style.height='170px';
                    row.innerHTML='<div class="mes_block"><div class="mes_buttons"></div><div class="mes_text">Message</div></div>';
                    host.append(row);
                }
            });
            const tool=page.getByRole('button',{name:'메시지 #0 스와이프 관리'});
            await tool.waitFor({state:'visible'});
            assert.equal(await page.locator('#chat > .mes[mesid="0"] .stmn-swipe-tool').count(),1);
            await tool.click();
            const dialog=page.locator('.stmn-swipe-dialog');
            await dialog.waitFor({state:'visible'});
            assert.equal(await dialog.locator('.stmn-swipe-card').count(),3);
            assert.ok((await dialog.locator('.stmn-swipe-card-text').first().textContent()).length>1250,
                'Complete first swipe must be present, not truncated');
            await dialog.getByRole('button',{name:'스와이프 #2 즐겨찾기'}).click();
            assert.equal(await dialog.getByRole('button',{name:'스와이프 #2 즐겨찾기'}).getAttribute('aria-pressed'),'true');
            assert.equal(await page.evaluate(()=>window.__q06Saves),1);
            await dialog.locator('[data-swipe-index="1"] .stmn-swipe-edit').click();
            await dialog.getByRole('textbox',{name:'스와이프 #2 태그 수정'}).fill('재미, 액션');
            await dialog.locator('[data-swipe-index="1"] .stmn-swipe-tag-editor').getByRole('button',{name:'저장'}).click();
            await page.waitForFunction(()=>window.__q06Saves===2);
            assert.deepEqual(await dialog.locator('[data-swipe-index="1"] .stmn-swipe-tag').allTextContents(),['재미','액션']);

            await dialog.getByRole('button',{name:'★ 즐겨찾기'}).click();
            assert.equal(await dialog.locator('.stmn-swipe-card').count(),1);
            assert.equal(await dialog.locator('.stmn-swipe-card').first().getAttribute('data-swipe-index'),'1');
            await dialog.locator('.stmn-swipe-filter-tags').selectOption('액션');
            assert.equal(await dialog.locator('.stmn-swipe-card').count(),1);
            await dialog.getByRole('button',{name:'전체',exact:true}).click();
            await dialog.getByRole('checkbox',{name:'스와이프 #1 비교 선택'}).check();
            await dialog.getByRole('checkbox',{name:'스와이프 #3 비교 선택'}).check();
            assert.equal(await dialog.locator('.stmn-swipe-compare-column').count(),2);
            const full=await dialog.locator('.stmn-swipe-compare-text').allTextContents();
            assert.ok(full[0].length>1200&&full[1].length>1400,
                'Comparison must not truncate full swipe bodies');
            await dialog.getByRole('button',{name:'스와이프 #3 현재 답변으로 적용'}).click();
            await page.waitForFunction(()=>window.__q06Swipes.length===1);
            const actual=await page.evaluate(()=>{
                const ctx=window.__themeAppContext;
                return {active:ctx.chat[0].swipe_id,bodies:ctx.chat[0].swipes.length,
                    swipeInfo:ctx.chat[0].swipe_info.map(x=>x.key),
                    other:ctx.chatMetadata.outside.keep,
                    saved:window.__q06Snapshot,
                    options:window.__q06Swipes[0],
                };
            });
            assert.equal(actual.active,2);
            assert.equal(actual.bodies,3);
            assert.deepEqual(actual.swipeInfo,['keep1','keep2','keep3']);
            assert.equal(actual.other,true);
            assert.equal(actual.options.forceMesId,0);
            assert.equal(actual.options.forceSwipeId,2);
            const stableId=await page.evaluate(()=>window.__themeAppContext.chat[0].stmn_message_id_v1);
            assert.ok(actual.saved.stmn_message_outline_v1.swipeAnnotations[stableId],
                'Swipe marks must persist in extension-owned per-message metadata');
            await dialog.getByRole('button',{name:'스와이프 관리 닫기'}).click();
            assert.equal(await dialog.isVisible(),false);
            assert.equal(await page.locator('#chat .stmn-swipe-tool').count(),1,
                'A single toolbar icon is mounted without duplicates');
        });

        await check('Q06 failed metadata save rolls back swipe annotations and leaves other fields untouched', async setup => {
            const page=await setup(2,undefined,true);
            await page.evaluate(()=>{
                const ctx=window.__themeAppContext;
                ctx.chat[0].swipes=['원문 A','원문 B'];
                ctx.chat[0].swipe_id=0;
                ctx.chatMetadata={outside:{keep:'safe'}};
                ctx.saveMetadata=async()=>{throw Error('저장 장치 오류');};
                const row=document.createElement('div');
                row.className='mes';
                row.setAttribute('mesid','0');
                row.innerHTML='<div class="mes_block"><div class="mes_buttons"></div><div class="mes_text">A</div></div>';
                document.querySelector('#chat').append(row);
            });
            await page.getByRole('button',{name:'메시지 #0 스와이프 관리'}).click();
            const dialog=page.locator('.stmn-swipe-dialog');
            await dialog.getByRole('button',{name:'스와이프 #2 즐겨찾기'}).click();
            await page.waitForFunction(()=>
                document.querySelector('.stmn-swipe-feedback')?.textContent.includes('저장 장치 오류'));
            const data=await page.evaluate(()=>{
                const ctx=window.__themeAppContext;
                return {outside:ctx.chatMetadata.outside.keep,
                    hasMarks:Object.prototype.hasOwnProperty.call(ctx.chatMetadata,'stmn_message_outline_v1'),
                    hasId:Object.prototype.hasOwnProperty.call(ctx.chat[0],'stmn_message_id_v1'),
                    bodies:ctx.chat[0].swipes.slice(),active:ctx.chat[0].swipe_id};
            });
            assert.deepEqual(data,{outside:'safe',hasMarks:false,hasId:false,bodies:['원문 A','원문 B'],active:0});
            assert.equal(await dialog.getByRole('button',{name:'스와이프 #2 즐겨찾기'}).getAttribute('aria-pressed'),
                'false','Failed save must not make a favorite appear persisted');
            await dialog.getByRole('button',{name:'스와이프 관리 닫기'}).click();
        });

        await check('Q05 previous restarts current message before going back; next on last goes bottom; no white outline', async setup => {
            const page=await setup(6);
            await page.evaluate(async()=>{
                window.__stmnView.destroy();
                const host=document.getElementById('chat');
                host.replaceChildren();
                const heights=[260,260,950,260,260,950];
                for(let i=0;i<6;i++) {
                    const row=document.createElement('div');
                    row.className='mes';row.setAttribute('mesid',String(i));
                    row.style.height=heights[i]+'px';
                    row.textContent='Message #'+i;
                    host.append(row);
                }
                const ctx=window.__stmnContext;
                ctx.chatId='q05-chat';
                ctx.chat=Array.from({length:6},(_,i)=>({
                    name:'User',is_user:true,mes:'Text #'+i,
                }));
                ctx.extensionSettings={};
                ctx.eventTypes={};
                ctx.eventSource={on(){},removeListener(){}};
                ctx.saveSettingsDebounced=()=>{};
                window.SillyTavern={getContext:()=>ctx};
                await import('/index.js');
            });
            const previous=page.locator('[data-action="previous"]');
            const next=page.locator('[data-action="next"]');
            const last=page.locator('[data-action="last"]');
            await previous.waitFor({state:'visible'});
            // Scroll well inside #2 (index 2), rather than its first paragraph.
            await page.evaluate(()=>document.getElementById('chat').scrollTop=935);
            await page.waitForFunction(()=>Math.abs(document.getElementById('chat').scrollTop-935)<3);
            await previous.click();
            const restarted=await page.evaluate(()=>({
                top:document.getElementById('chat').scrollTop,
                marker:document.querySelectorAll('#chat .stmn-jump-target').length,
            }));
            assert.ok(restarted.top>460 && restarted.top<550,
                'First previous returns to message #2 start, not #1: '+JSON.stringify(restarted));
            assert.equal(restarted.marker,0,'The navigation must not decorate message DOM with a white outline');
            await previous.click();
            const older=await page.evaluate(()=>document.getElementById('chat').scrollTop);
            assert.ok(older>210 && older<290,
                'Second previous should go to message #1 (not #0): '+older);

            // If the user scrolls back into #2, its own start is offered again.
            await page.evaluate(()=>document.getElementById('chat').scrollTop=900);
            await page.waitForFunction(()=>Math.abs(document.getElementById('chat').scrollTop-900)<3);
            await previous.click();
            const again=await page.evaluate(()=>document.getElementById('chat').scrollTop);
            assert.ok(again>460 && again<550,'Manual scrolling resets the start landing: '+again);

            // At #0, "previous" is still available while the user is reading
            // halfway through that message, then disables after returning up.
            await page.evaluate(()=>document.getElementById('chat').scrollTop=120);
            await page.waitForFunction(()=>Math.abs(document.getElementById('chat').scrollTop-120)<3);
            await previous.click();
            const first=await page.evaluate(()=>document.getElementById('chat').scrollTop);
            assert.ok(first<=3,'First message should return to the actual chat start');
            assert.equal(await previous.isEnabled(),false);

            // "Last" lands on #5 start; "next" from there goes to chat bottom.
            await last.click();
            const atLast=await page.evaluate(()=>({
                top:document.getElementById('chat').scrollTop,
                max:document.getElementById('chat').scrollHeight-document.getElementById('chat').clientHeight,
                outline:getComputedStyle(document.querySelector('#chat > .mes[mesid="5"]')).outlineStyle,
                marker:document.querySelectorAll('#chat .stmn-jump-target').length,
            }));
            assert.ok(atLast.max-atLast.top>100,
                'Last press should land at last message start: '+JSON.stringify(atLast));
            assert.equal(atLast.outline,'none','No extension-generated focus box around last message');
            assert.equal(atLast.marker,0);
            assert.equal(await next.isEnabled(),true,
                'Next remains available when the current message is the last but bottom is further');
            await next.click();
            const atBottom=await page.evaluate(()=>({
                top:document.getElementById('chat').scrollTop,
                max:document.getElementById('chat').scrollHeight-document.getElementById('chat').clientHeight,
            }));
            assert.ok(Math.abs(atBottom.top-atBottom.max)<=3,'Next reaches the actual bottom');
            assert.equal(await next.isEnabled(),false,
                'Next disables when no additional scroll or message is possible');
            assert.equal(await page.locator('#chat > .mes.stmn-jump-target').count(),0);
        });

        await check('last button jumps to last message start, then bottom; manual scrolling resets', async setup => {
            const page = await setup(6);
            await page.evaluate(async () => {
                window.__stmnView.destroy();
                const chat = document.getElementById('chat');
                chat.replaceChildren();
                for (let i = 0; i < 6; i++) {
                    const el = document.createElement('div');
                    el.className = 'mes';
                    el.setAttribute('mesid', String(i));
                    el.style.height = (i === 5 ? 900 : 260) + 'px';
                    el.textContent = 'Message #' + i;
                    chat.append(el);
                }
                const current = window.__stmnContext;
                current.chatId = 'test-chat';
                current.chat = Array.from({ length: 6 }, (_, i) => ({ name: 'User', is_user: true, mes: 'text ' + i }));
                current.extensionSettings = {};
                current.saveSettingsDebounced = () => {};
                current.eventTypes = {};
                current.eventSource = { on() {}, removeListener() {} };
                globalThis.SillyTavern = { getContext: () => current };
                await import('/index.js');
            });
            const last = page.locator('[data-action="last"]');
            await last.waitFor({ state: 'visible' });
            await last.click();
            await page.waitForFunction(() => document.getElementById('chat').scrollTop > 200);
            const first = await page.evaluate(() => {
                const el = document.getElementById('chat');
                return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
            });
            assert.ok(first.max - first.top > 100, 'First click must land at message beginning, not bottom');
            await last.click();
            const second = await page.evaluate(() => {
                const el = document.getElementById('chat');
                return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
            });
            assert.ok(Math.abs(second.top - second.max) <= 2, 'Second click must reach chat bottom');
            await page.evaluate(() => document.getElementById('chat').scrollTop = 0);
            await page.waitForFunction(() => document.getElementById('chat').scrollTop === 0);
            await last.click();
            const again = await page.evaluate(() => {
                const el = document.getElementById('chat');
                return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
            });
            assert.ok(again.max - again.top > 100, 'Manual scrolling must clear prior last-button state');
        });

        await check('panel resize saves only on pointer release and clamps to viewport', async setup => {
            const page = await setup(60);
            await page.locator('[data-action="outline"]').click();
            const handle = page.locator('.stmn-panel-resize');
            const original = await page.locator('.stmn-outline').boundingBox();
            const rect = await handle.boundingBox();
            assert.ok(rect);
            await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
            await page.mouse.down();
            await page.mouse.move(rect.x + rect.width / 2 + 90, rect.y + rect.height / 2 + 60, { steps: 5 });
            assert.equal(await page.evaluate(() => window.__stmnPanelSize), null);
            await page.mouse.up();
            const changed = await page.evaluate(() => ({
                saved: window.__stmnPanelSize,
                width: document.querySelector('.stmn-outline').getBoundingClientRect().width,
                height: document.querySelector('.stmn-outline').getBoundingClientRect().height,
            }));
            assert.ok(changed.saved?.width > original.width + 35);
            assert.ok(changed.saved?.height > original.height + 15);
            assert.ok(changed.width > original.width);
            assert.ok(changed.height > original.height);
            await page.setViewportSize({ width: 375, height: 667 });
            // Let the viewport resize listener and layout settle before
            // checking the panel geometry.
            await page.waitForFunction(() => {
                const rect = document.querySelector('.stmn-outline').getBoundingClientRect();
                return rect.x >= 0 && rect.x + rect.width <= innerWidth + 1 &&
                    rect.y + rect.height <= innerHeight + 1;
            }, { timeout: 2500 });
            const clamped = await page.locator('.stmn-outline').boundingBox();
            assert.ok(clamped.x >= 0 && clamped.x + clamped.width <= 375);
            assert.ok(clamped.y + clamped.height <= 667);
        });

        await check('C library backup does not write until confirmed and keeps other extension data', async setup => {
            const page = await setup(23);
            await page.evaluate(async () => {
                const { installLibraryBackupUI } = await import('/library-backup-ui.js');
                const { LibraryRepository } = await import('/library-repository.js');
                const { emptyLibrary, emptyRecord, currentChatReference, createLibraryBackup } =
                    await import('/library-data.js');
                const context = window.__stmnContext;
                context.extensionSettings = { unrelated_extension: { keep: 123 } };
                window.__librarySaves = 0;
                context.saveSettingsDebounced = () => { window.__librarySaves++; };
                const storage = new LibraryRepository(() => context);
                const data = emptyLibrary();
                data.records[currentChatReference(context)] = { ...emptyRecord(), alias: '테스트 건물' };
                window.__libraryBackupText = createLibraryBackup(data, { version: '1.5.0' });
                installLibraryBackupUI(document.getElementById('extensions_settings2'), {
                    readLibrary: () => storage.read(),
                    importLibrary: backup => storage.importAdditively(backup),
                });
            });
            await page.locator('.stmn-library-settings > summary').click();
            await page.getByRole('button', { name: '관리 데이터 상태 확인' }).click();
            assert.match(await page.locator('.stmn-library-preview').innerText(), /채팅: 0/);
            const input = page.locator('.stmn-library-settings input[type="file"]');
            await input.setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{invalid') });
            assert.equal(await page.getByRole('button', { name: '관리 데이터 병합 복원' }).isDisabled(), true);
            const valid = await page.evaluate(() => window.__libraryBackupText);
            await input.setInputFiles({ name: 'library.json', mimeType: 'application/json', buffer: Buffer.from(valid) });
            await page.locator('.stmn-library-consent input').waitFor({ state: 'visible' });
            assert.equal(await page.evaluate(() => window.__librarySaves), 0);
            assert.equal(await page.getByRole('button', { name: '관리 데이터 병합 복원' }).isDisabled(), true);
            await page.locator('.stmn-library-consent input').check();
            await page.getByRole('button', { name: '관리 데이터 병합 복원' }).click();
            assert.deepEqual(await page.evaluate(() => {
                const ext = window.__stmnContext.extensionSettings;
                return {
                    saves: window.__librarySaves,
                    untouched: ext.unrelated_extension.keep,
                    chats: Object.keys(ext.stmn_library_v1.records).length,
                    alias: Object.values(ext.stmn_library_v1.records)[0].alias,
                };
            }), { saves: 1, untouched: 123, chats: 1, alias: '테스트 건물' });
        });

        await check('Q02 Quiet cards preserve v1 aliases, edit descriptions and expose message actions', async setup => {
            const page = await setup(23);
            await page.evaluate(async () => {
                const { LibraryRepository } = await import('/library-repository.js');
                const { chatReference, emptyLibrary, emptyRecord, LIBRARY_KEY } =
                    await import('/library-data.js');
                const { isMessageBookmarked, setMessageBookmark } = await import('/model.js');
                const ctx = window.__stmnContext;
                const reference = chatReference('character:none','chat-b');
                const legacy = emptyLibrary();
                legacy.schemaVersion = 1;
                const oldRecord = emptyRecord();
                delete oldRecord.description;
                oldRecord.alias = '예전 별명';
                legacy.records[reference] = oldRecord;
                ctx.extensionSettings = { [LIBRARY_KEY]:legacy, other_extension:'untouched' };
                window.__q02SaveCount = 0;
                ctx.saveSettingsDebounced = () => { window.__q02SaveCount++; };
                const repo = new LibraryRepository(()=>ctx);
                window.__stmnView.callbacks.readLibrary = () => repo.read();
                window.__stmnView.callbacks.changeLibrary = action => repo.update(action);
                window.__stmnView.callbacks.currentLibraryScope = () => 'character:none';
                window.__stmnView.callbacks.isBookmarked = index =>
                    isMessageBookmarked(ctx.chat[index],ctx.chatMetadata);
                window.__q02BookmarkEvents = [];
                window.__stmnView.callbacks.toggleBookmark = async index => {
                    try {
                        const before = isMessageBookmarked(ctx.chat[index],ctx.chatMetadata);
                        const changed = setMessageBookmark(ctx.chat,ctx.chatMetadata,index,true,()=> 'bookmark-'+index);
                        const after = isMessageBookmarked(ctx.chat[index],ctx.chatMetadata);
                        window.__q02BookmarkEvents.push({index,before,changed,after});
                        window.__stmnView.renderRows(true);
                    } catch(error) {
                        window.__q02BookmarkEvents.push({index,error:error?.message || String(error)});
                    }
                };
                window.__stmnView.elevator.applyTheme('quiet','auto');
            });
            await page.locator('[data-action="outline"]').click();
            await page.locator('.stmn-quiet-bookmark').first().click();
            const savedBookmark = await page.evaluate(() => {
                const event = window.__q02BookmarkEvents[0];
                const { bookmarks } = window.__stmnContext.chatMetadata.stmn_message_outline_v1 || {};
                return { event, stored: Boolean(bookmarks?.['bookmark-' + event?.index]) };
            });
            assert.equal(savedBookmark.event?.after, true);
            assert.equal(savedBookmark.stored, true);
            const markedRow = page.locator('.stmn-row[data-index="' + savedBookmark.event.index + '"] .stmn-quiet-bookmark');
            if (await markedRow.count()) {
                assert.equal(await markedRow.getAttribute('aria-pressed'), 'true');
            }
            await page.locator('.stmn-row').first().getByRole('button',{name:/내용 미리보기/}).click();
            assert.equal(await page.locator('.stmn-quiet-message-preview').isVisible(),true);
            await page.getByRole('button',{name:'미리보기 닫기'}).click();

            await page.getByRole('tab',{name:'건물 로비'}).click();
            const card=page.locator('.stmn-library-card').filter({
                has: page.locator('.stmn-building-card-title',{hasText:'건물 B'})
            });
            await card.waitFor();
            assert.equal(await card.locator('.stmn-building-card-title').textContent(),'건물 B');
            assert.equal(await page.evaluate(()=>window.__q02SaveCount),0,
                'reading legacy v1 must not migrate stored data');
            await card.getByRole('button',{name:'건물 B 설명 수정'}).click();
            await card.locator('.stmn-quiet-description-input').fill('차분한 겨울의 이야기');
            await card.locator('.stmn-quiet-description-editor').getByRole('button',{name:'저장'}).click();
            const after=await page.evaluate(()=>{
                const data=window.__stmnContext.extensionSettings.stmn_library_v1;
                const record=Object.values(data.records)[0];
                return {version:data.schemaVersion,alias:record.alias,description:record.description,
                    writes:window.__q02SaveCount,unchanged:window.__stmnContext.extensionSettings.other_extension,
                    chatId:window.__stmnContext.chatId};
            });
            assert.deepEqual(after,{version:2,alias:'예전 별명',description:'차분한 겨울의 이야기',
                writes:1,unchanged:'untouched',chatId:'chat-a'});
            assert.equal(await card.locator('.stmn-quiet-chat-description').textContent(),'차분한 겨울의 이야기');
            await card.getByLabel('건물 B 관리 메뉴').click();
            await card.getByRole('button',{name:'분류 · 폴더 / 태그'}).click();
            assert.equal(await card.locator('.stmn-library-details').evaluate(el=>el.open),true);
            await page.evaluate(()=>window.__stmnView.elevator.applyTheme('classic','auto'));
            assert.equal(await page.locator('.stmn-building-card-title').filter({hasText:'예전 별명'}).count(),1,
                'legacy alias remains functional in classic');
            await page.evaluate(()=>window.__stmnView.elevator.applyTheme('quiet','auto'));
            assert.equal(await page.locator('.stmn-building-card-title').filter({hasText:'건물 B'}).count(),1);
        });

        await check('Quiet v5 eye hover excerpt vs click full text and complete swipe navigation', async setup => {
            const page = await setup(25);
            await page.evaluate(() => {
                const ctx=window.__stmnContext;
                window.__previewSelections=[];
                for (const m of ctx.chat) {
                    m.mes='첫 번째 '+ '가'.repeat(1200);
                    m.swipes=[m.mes, '두 번째 '+ '나'.repeat(1150),'세 번째 '+ '다'.repeat(1400)];
                    m.swipe_id=0;
                }
                window.__stmnView.callbacks.selectSwipe=async(index,swipeIndex)=>{
                    window.__previewSelections.push({index,swipeIndex});
                    ctx.chat[index].swipe_id=swipeIndex;
                    ctx.chat[index].mes=ctx.chat[index].swipes[swipeIndex];
                    return true;
                };
                window.__stmnView.elevator.applyTheme('quiet','auto');
            });
            await page.locator('[data-action="outline"]').click();
            const eye=page.locator('.stmn-row').first().getByRole('button',{name:/내용 미리보기/});
            // Virtual rows recycle during pointer scroll; use the actually opened preview's message ID.
            await eye.hover();
            await page.locator('.stmn-quiet-tooltip').waitFor({state:'visible'});
            const excerpt=await page.locator('.stmn-quiet-tooltip-text').textContent();
            assert.equal(excerpt.length,681,'tooltip is the ONLY place limited to 680 chars');
            const tooltipRect=await page.locator('.stmn-quiet-tooltip').boundingBox();
            const eyeRect=await eye.boundingBox();
            assert.ok(tooltipRect.y>=eyeRect.y+eyeRect.height-2,'tooltip is below the eye');
            await eye.click();
            await page.locator('.stmn-quiet-message-preview').waitFor({state:'visible'});
            assert.equal((await page.locator('.stmn-quiet-preview-reading').textContent()).length,1205);
            assert.equal((await page.locator('.stmn-quiet-swipe-text').textContent()).length,1205);
            await page.getByRole('button',{name:'다음 스와이프'}).click();
            assert.ok((await page.locator('.stmn-quiet-swipe-text').textContent()).startsWith('두 번째'));
            assert.equal((await page.locator('.stmn-quiet-swipe-text').textContent()).length,1155);
            await page.getByRole('button',{name:'이 스와이프 적용'}).click();
            const previewIndex=Number((await page.locator('.stmn-quiet-message-preview')
                .getAttribute('aria-label')).match(/#(\d+)/)[1]);
            assert.deepEqual(await page.evaluate(()=>window.__previewSelections[0]),
                {index:previewIndex,swipeIndex:1});
            assert.equal((await page.locator('.stmn-quiet-preview-reading').textContent()).length,1155,
                'after applying, the actual current message becomes the selected swipe');
            await page.getByRole('button',{name:'미리보기 닫기'}).click();
            assert.equal(await page.locator('.stmn-quiet-message-preview').count(),0);
        });

        await check('extension settings updater checks Git branch and updates only after click', async setup => {
            const page=await setup(2,undefined,true);
            const mockBody=[];
            await page.route('**/api/extensions/version',async route=>{
                mockBody.push(route.request().postDataJSON());
                await route.fulfill({status:200,contentType:'application/json',
                    body:JSON.stringify({isUpToDate:false,currentBranchName:'main',
                        currentCommitHash:'1234567890abcdef',remoteUrl:'https://github.com/test/repo.git'})});
            });
            await page.route('**/api/extensions/update',async route=>{
                mockBody.push(route.request().postDataJSON());
                await route.fulfill({status:200,contentType:'application/json',
                    body:JSON.stringify({isUpToDate:false,shortCommitHash:'abcdef0'})});
            });
            await page.evaluate(()=>{window.__themeAppContext.getRequestHeaders=()=>({
                'Content-Type':'application/json','X-CSRF-Token':'test-token',
            });});
            await page.locator('#stmn-settings > details > summary').click();
            const update=page.locator('#stmn-update-button');
            await page.waitForFunction(() => document.querySelector('.stmn-update-controls')?.dataset.updateState === 'error');
            await update.click();
            await page.waitForFunction(()=>document.querySelector('.stmn-update-controls')?.dataset.updateState==='available');
            assert.equal(await update.textContent(),'업데이트 설치');
            assert.equal(await page.locator('.stmn-update-controls').getAttribute('data-update-state'),'available');
            await update.click();
            await page.waitForFunction(()=>document.querySelector('.stmn-update-controls')?.dataset.updateState==='updated');
            assert.equal(await page.getByRole('button',{name:'새로고침하여 적용'}).isVisible(),true);
            assert.equal(mockBody.length,2);
            assert.equal(mockBody[0].extensionName,'ST-Message-Navigator');
            assert.equal(mockBody[1].extensionName,'ST-Message-Navigator');
            assert.equal(mockBody[0].global,false);
            assert.equal(mockBody[1].global,false);
        });

        await check('Q04 eye-only chat tooltip fetches last five and full directory without chat switching', async setup => {
            const page=await setup(24);
            const requests=[];
            await page.route('**/api/chats/get',async route=>{
                const data=route.request().postDataJSON();
                requests.push(data);
                const messages=Array.from({length:260},(_,i)=>({
                    name:i%2?'Character':'User',is_user:i%2===0,
                    mes:'메시지 '+i+' · '+(i===259?'끝'.repeat(800):'본문의 첫 문장입니다.'),
                    ...(i===3?{stmn_message_id_v1:'special-id'}:{}),
                }));
                await route.fulfill({status:200,contentType:'application/json',
                    body:JSON.stringify([{chat_metadata:{
                        stmn_message_outline_v1:{schema:1,titles:{'special-id':'사용자 지정 제목'}}
                    }},...messages])});
            });
            await page.evaluate(()=>{
                const ctx=window.__stmnContext;
                ctx.getRequestHeaders=()=>({'Content-Type':'application/json'});
                window.__stmnView.elevator.applyTheme('quiet','auto');
            });
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('tab',{name:'건물 로비'}).click();
            await page.locator('.stmn-building-card').first().waitFor();
            // Whole-row hovering is intentionally inert.
            await page.locator('.stmn-building-card').last().hover();
            assert.equal(await page.locator('.stmn-quiet-chat-tooltip').isVisible(),false);
            const eye=page.getByRole('button',{name:'건물 B 채팅 미리보기'});
            await eye.hover();
            await page.locator('.stmn-quiet-chat-tooltip').waitFor({state:'visible'});
            await page.waitForFunction(()=>
                document.querySelectorAll('.stmn-quiet-chat-tooltip-title').length===5);
            assert.deepEqual(await page.locator('.stmn-quiet-chat-tooltip-title span:first-child').allTextContents(),
                ['#255','#256','#257','#258','#259']);
            const excerpt=await page.locator('.stmn-quiet-chat-tooltip-body').textContent();
            assert.equal(excerpt.length,681);
            const eyeRect=await eye.boundingBox();
            const tooltipRect=await page.locator('.stmn-quiet-chat-tooltip').boundingBox();
            assert.ok(tooltipRect.y>=eyeRect.y+eyeRect.height-2);
            assert.equal(requests.length,1);
            assert.equal(requests[0].file_name,'chat-b');
            assert.equal(requests[0].avatar_url,'none');
            assert.equal(await page.evaluate(()=>window.__stmnContext.chatId),'chat-a',
                'Viewing another chat must not switch away from current chat');
            await eye.click();
            await page.locator('.stmn-quiet-chat-detail').waitFor({state:'visible'});
            assert.equal(await page.locator('.stmn-quiet-chat-detail-headings small').textContent(),'260개 메시지');
            assert.ok((await page.locator('.stmn-quiet-chat-detail-row').count())<60,
                'Complete title list must remain virtualized');
            assert.equal(requests.length,1,'Click must reuse already-fetched view projection');
            await page.locator('.stmn-quiet-chat-detail-list').evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll'));});
            const custom=page.getByRole('button',{name:'#3 사용자 지정 제목 채팅으로 이동'});
            await custom.waitFor();
            await custom.click();
            await page.waitForFunction(()=>window.__stmnContext.chatId==='chat-b');
            assert.equal(await page.getByRole('tab',{name:'층 안내'}).getAttribute('aria-selected'),'true');
            assert.equal(await page.locator('.stmn-quiet-chat-detail').isVisible(),false);
            assert.equal(await page.evaluate(()=>window.__stmnActions.includes(3)),true,
                'Selected directory entry should navigate to its message after switching chats');
        });

        await check('Q04 group chat uses read-only group endpoint, scope changes invalidate stale previews', async setup => {
            const page=await setup(14);
            const calls=[];
            await page.route('**/api/chats/group/get',async route=>{
                calls.push(route.request().postDataJSON());
                await route.fulfill({status:200,contentType:'application/json',
                    body:JSON.stringify([{chat_metadata:{}},{mes:'그룹 이야기 첫 장면'},{mes:'그룹 마지막'}])});
            });
            await page.evaluate(()=>{
                const ctx=window.__stmnContext;
                ctx.groupId=77;
                ctx.groups=[{id:77,chats:['group-a','group-b']}];
                ctx.getRequestHeaders=()=>({'Content-Type':'application/json'});
                window.__stmnView.callbacks.listBuildings=async()=>({
                    scope:'group:77',title:'Group',
                    buildings:[
                        {id:'group-a',name:'그룹 A',lastActivity:30,count:1},
                        {id:'group-b',name:'그룹 B',lastActivity:20,count:2},
                    ],
                });
                window.__stmnView.elevator.applyTheme('quiet','auto');
            });
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('tab',{name:'건물 로비'}).click();
            const eye=page.getByRole('button',{name:'그룹 B 채팅 미리보기'});
            await eye.waitFor();
            await eye.click();
            await page.locator('.stmn-quiet-chat-detail-row').first().waitFor();
            assert.equal(await page.locator('.stmn-quiet-chat-detail-row').count(),2);
            assert.deepEqual(calls,[{id:'group-b'}]);
            assert.equal(await page.evaluate(()=>window.__stmnContext.chatId),'chat-a');
            await page.evaluate(()=>{
                const ctx=window.__stmnContext;
                ctx.groupId=null;
                window.__stmnView.elevator.onChatChanged();
            });
            await page.waitForFunction(()=>document.querySelector('.stmn-quiet-chat-detail')?.hidden===true);
        });

        await check('Q03 Quiet folder drawer expands lazily, filters and navigates without moving JSONL', async setup => {
            const page=await setup(24);
            await page.evaluate(async()=>{
                const {emptyLibrary,emptyRecord,chatReference}=await import('/library-data.js');
                const lib=emptyLibrary();
                lib.folders=[{id:'f_progress',name:'진행 중'},{id:'f_done',name:'완성작'}];
                for(let i=0;i<83;i++){
                    lib.records[chatReference('character:none','chat-'+i)]={
                        ...emptyRecord(),folderId:'f_progress',favorite:i%10===0,
                        description:'장면 '+i,
                    };
                }
                const cb=window.__stmnView.callbacks;
                cb.readLibrary=()=>lib;
                cb.listBuildings=async()=>({
                    scope:'character:none',title:'Character',
                    buildings:Array.from({length:120},(_,i)=>({
                        id:'chat-'+i,name:'File '+i,lastActivity:120-i,count:4,
                    })),
                });
                window.__q03Library=lib;
                window.__q03Before=JSON.stringify(lib);
                window.__stmnView.elevator.applyTheme('quiet','auto');
            });
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('tab',{name:'건물 로비'}).click();
            await page.locator('.stmn-building-card').first().waitFor();
            assert.equal(await page.locator('.stmn-building-card').count(),100,
                'Main list continues to render in pages');
            await page.getByRole('button',{name:'폴더 탐색 열기'}).click();
            const drawer=page.locator('#stmn-quiet-folder-drawer');
            await drawer.waitFor({state:'visible'});
            assert.equal(await page.getByRole('button',{name:'폴더 탐색 닫기'}).first()
                .getAttribute('aria-expanded'),'true');
            assert.equal(await drawer.locator('.stmn-quiet-folder-section').count(),5);
            assert.equal(await drawer.locator('.stmn-quiet-folder-chat').count(),0,
                'Closed folders must NOT instantiate 120 chat buttons');
            const progress=drawer.locator('[data-section="folder:f_progress"]');
            await progress.locator('summary').click();
            await page.waitForFunction(() =>
                document.querySelectorAll('[data-section="folder:f_progress"] .stmn-quiet-folder-chat').length === 30);
            assert.equal(await progress.locator('.stmn-quiet-folder-chat').count(),30);
            assert.equal((await progress.locator('.stmn-quiet-folder-chat').first().textContent())
                .includes('File 0'),true);
            await progress.getByRole('button',{name:/더 보기/}).click();
            assert.equal(await progress.locator('.stmn-quiet-folder-chat').count(),60);
            const done=drawer.locator('[data-section="folder:f_done"]');
            await done.locator('summary').click();
            assert.match(await done.locator('.stmn-quiet-folder-empty').textContent(),/채팅이 없습니다/);
            await progress.getByRole('button',{name:'진행 중만 채팅 목록에 보기'}).click();
            assert.equal(await page.locator('.stmn-building-card').count(),83,
                'The folder filter must exclude the other 37 chats');
            assert.equal(await page.locator('.stmn-quiet-folder-selected').getAttribute('data-section'),
                'folder:f_progress');
            const favorites=drawer.locator('[data-section="favorites"]');
            await favorites.locator('summary').click();
            await favorites.getByRole('button',{name:'즐겨찾기만 채팅 목록에 보기'}).click();
            assert.equal(await page.locator('.stmn-building-card').count(),9);
            await drawer.locator('[data-section="all"] summary').click();
            await drawer.getByRole('button',{name:'전체 채팅만 채팅 목록에 보기'}).click();
            assert.equal(await page.locator('.stmn-building-card').count(),100);
            await drawer.locator('[data-section="folder:f_progress"] .stmn-quiet-folder-chat').first().click();
            await page.waitForFunction(()=>window.__stmnContext.chatId==='chat-0');
            assert.equal(await page.getByRole('tab',{name:'층 안내'}).getAttribute('aria-selected'),'true');
            assert.equal(await page.evaluate(()=>JSON.stringify(window.__q03Library)===window.__q03Before),
                true,'Folder navigation must not write/delete chat records');
            await page.getByRole('tab',{name:'건물 로비'}).click();
            await page.evaluate(()=>window.__stmnView.elevator.applyTheme('classic','auto'));
            assert.equal(await drawer.isVisible(),false,
                'Legacy themes must not show the Quiet folder drawer');
            assert.equal(await page.locator('.stmn-building-card').first().isVisible(),true);
        });

        await check('Q03 narrow Quiet panel overlays drawer without hiding the chat list', async setup => {
            const page=await setup(15,{width:375,height:667});
            await page.evaluate(()=>window.__stmnView.elevator.applyTheme('quiet','auto'));
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('tab',{name:'건물 로비'}).click();
            await page.locator('.stmn-building-card').first().waitFor();
            await page.getByRole('button',{name:'폴더 탐색 열기'}).click();
            const drawer=page.locator('#stmn-quiet-folder-drawer');
            await drawer.waitFor({state:'visible'});
            const mainWidth=await page.locator('.stmn-building-list').evaluate(el=>el.getBoundingClientRect().width);
            const drawerWidth=await drawer.evaluate(el=>el.getBoundingClientRect().width);
            assert.ok(mainWidth>180,'Mobile main list remains full width, not squeezed: '+mainWidth);
            assert.ok(drawerWidth>0 && drawerWidth<300);
            await drawer.getByRole('button',{name:'폴더 탐색 닫기'}).click();
            assert.equal(await drawer.isVisible(),false);
        });

        await check('D library aliases, favorites, folder assignment and persistence', async setup => {
            const page = await setup(23);
            await page.evaluate(async () => {
                const { LibraryRepository } = await import('/library-repository.js');
                const { buildingScope } = await import('/building-data.js');
                const ctx = window.__stmnContext;
                ctx.extensionSettings = { other_extension: { keep: 'yes' } };
                window.__librarySaves = 0;
                ctx.saveSettingsDebounced = () => { window.__librarySaves++; };
                const repo = new LibraryRepository(() => ctx);
                const callbacks = window.__stmnView.callbacks;
                callbacks.readLibrary = () => repo.read();
                callbacks.changeLibrary = action => repo.update(action);
                callbacks.currentLibraryScope = () => buildingScope(ctx);
            });
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('tab', { name: '건물 로비' }).click();
            await page.locator('.stmn-building-card').first().waitFor();
            assert.equal(await page.locator('.stmn-building-card').count(), 2);
            await page.getByRole('button', { name: '건물 B 즐겨찾기 추가' }).click();
            assert.equal(await page.evaluate(() => window.__librarySaves), 1);
            await page.locator('.stmn-library-view').selectOption('favorites');
            assert.equal(await page.locator('.stmn-building-card').count(), 1);
            const card = page.locator('.stmn-library-card');
            await card.locator('.stmn-library-details summary').click();
            await card.getByRole('button', { name: '✎ 별명 변경' }).click();
            await page.locator('.stmn-library-editor input').fill('새 별명 B');
            await page.locator('.stmn-library-editor button[type="submit"]').click();
            assert.equal(await page.locator('.stmn-building-card-title').innerText(), '새 별명 B');
            assert.equal(await page.evaluate(() => window.__stmnContext.chatId), 'chat-a');

            // Folder catalog is independent from SillyTavern chat paths.
            await page.locator('.stmn-library-manage > summary').click();
            await page.locator('.stmn-library-toolbar').first().getByRole('button',{name:'+ 추가'}).click();
            await page.locator('.stmn-library-editor input').fill('작업 폴더');
            await page.locator('.stmn-library-editor button[type="submit"]').click();
            await page.locator('.stmn-library-card-folder').selectOption({label:'작업 폴더'});
            await page.locator('.stmn-library-view').selectOption('folders');
            await page.locator('.stmn-library-folder-filter').selectOption({label:'작업 폴더'});
            assert.equal(await page.locator('.stmn-building-card').count(),1);
            await page.locator('.stmn-library-toolbar').nth(1).getByRole('button',{name:'+ 추가'}).click();
            await page.locator('.stmn-library-editor input').fill('판타지');
            await page.locator('.stmn-library-editor button[type="submit"]').click();
            const detail = page.locator('.stmn-library-details');
            if (!(await detail.evaluate(el => el.open))) await detail.locator('summary').click();
            await page.locator('.stmn-library-tag-checkboxes').getByLabel('판타지').check();
            assert.match(await page.locator('.stmn-building-card-title').innerText(), /새 별명 B/);
            const saved = await page.evaluate(() => {
                const settings = window.__stmnContext.extensionSettings;
                const row = Object.values(settings.stmn_library_v1.records)[0];
                return { alias:row.alias, favorite:row.favorite, folderId:row.folderId,
                    folderName:settings.stmn_library_v1.folders[0].name,
                    tagNames:row.tagIds.map(id=>settings.stmn_library_v1.tags.find(x=>x.id===id)?.name),
                    other:settings.other_extension.keep, saves:window.__librarySaves,
                    originalChatId:window.__stmnContext.chatId };
            });
            assert.equal(saved.alias,'새 별명 B');
            assert.equal(saved.favorite,true);
            assert.equal(saved.folderName,'작업 폴더');
            assert.deepEqual(saved.tagNames,['판타지']);
            assert.equal(saved.other,'yes');
            assert.equal(saved.originalChatId,'chat-a');
            assert.equal(saved.saves,6);
        });

        await check('D library pages 350 chats and lazily creates tag controls', async setup => {
            const page = await setup(16);
            await page.evaluate(async () => {
                const { emptyLibrary } = await import('/library-data.js');
                const lib = emptyLibrary();
                lib.tags = Array.from({ length:40 },(_,i)=>({id:'t'+i,name:'태그 '+i}));
                const callbacks = window.__stmnView.callbacks;
                callbacks.readLibrary = () => lib;
                callbacks.listBuildings = async () => ({
                    scope:'character:none', title:'Character',
                    buildings:Array.from({length:350},(_,i)=>({
                        id:'chat-'+i, name:'Chat '+i, lastActivity:350-i, count:4, preview:'',
                    })),
                });
            });
            await page.locator('[data-action="outline"]').click();
            await page.getByRole('tab',{name:'건물 로비'}).click();
            await page.waitForFunction(() => document.querySelectorAll('.stmn-building-card').length === 100);
            assert.equal(await page.locator('.stmn-library-tag-checkbox').count(),0);
            await page.locator('.stmn-library-details summary').first().click();
            await page.locator('.stmn-library-tag-checkbox').first().waitFor();
            assert.equal(await page.locator('.stmn-library-tag-checkbox').count(),40);
            await page.getByRole('button',{name:/더 보기/}).click();
            assert.equal(await page.locator('.stmn-building-card').count(),200);
        });

        await check('10000 messages keep DOM list virtualized', async setup => {
            const page = await setup(10000);
            await page.locator('[data-action="outline"]').click();
            const stats = await page.evaluate(() => ({
                rendered: document.querySelectorAll('.stmn-row,.stmn-group').length,
                entries: window.__stmnView.entries.length,
                height: window.__stmnView.spacer.style.height,
            }));
            assert.equal(stats.entries, 10000);
            assert.ok(stats.rendered > 0 && stats.rendered < 70, 'DOM virtualization: ' + stats.rendered);
            assert.match(stats.height, /px$/);
        });

        await check('small viewport and theme switch do not crash the panel', async setup => {
            const page = await setup(34, { width: 375, height: 667 });
            await page.evaluate(() => window.__stmnView.elevator.applyTheme('sky', 'night'));
            await page.locator('[data-action="outline"]').click();
            const data = await page.evaluate(() => ({
                theme: document.querySelector('#stmn-root').dataset.elevatorTheme,
                sky: document.querySelector('#stmn-root').dataset.elevatorSky,
                panel: document.querySelector('.stmn-outline').getBoundingClientRect().toJSON(),
            }));
            assert.equal(data.theme, 'sky');
            assert.equal(data.sky, 'night');
            assert.ok(data.panel.width <= 375);
        });
    } finally {
        await browser?.close();
        await new Promise(resolve => server.close(resolve));
    }
    process.stdout.write('Browser smoke checks: ' + (count - failures) + '/' + count + ' passed\n');
    if (failures) process.exitCode = 1;
}

await run();
