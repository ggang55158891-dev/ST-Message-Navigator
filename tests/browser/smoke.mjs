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

async function setupPage(browser, baseURL, messageCount = 23, size = { width: 1280, height: 800 }) {
    const page = await browser.newPage({ viewport: size });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseURL);
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
        const callbacks = {
            context: () => context,
            hasChat: () => true,
            navigate: action => window.__stmnActions.push(action),
            goToIndex: index => window.__stmnActions.push(index),
            canNavigate: () => true,
            saveTitle: async () => undefined,
            getPosition: () => window.__stmnPosition,
            savePosition: position => { window.__stmnPosition = position; },
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
        };
        window.__stmnView = new NavigatorView(callbacks);
        window.__stmnView.setActive(0);
    }, messageCount);
    return { page, errors };
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
            const result = await fn(async (messageCount, size) => {
                const setup = await setupPage(browser, baseURL, messageCount, size);
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
