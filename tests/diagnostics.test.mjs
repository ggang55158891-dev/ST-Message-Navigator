import test from 'node:test';
import assert from 'node:assert/strict';
import {
    Diagnostics, diagnosticErrorType, MAX_DIAGNOSTIC_EVENTS, DIAGNOSTIC_VERSION,
} from '../diagnostics.js';

test('diagnostics are opt-in for normal events but retain errors in memory', () => {
    const log = new Diagnostics({ now: () => 1782864000000 });
    assert.equal(log.record('navigation', 'jump_started', { status: 'started' }), false);
    assert.equal(log.snapshot().length, 0);
    assert.equal(log.record('navigation', 'jump_failed', {
        status: 'error', targetIndex: 12, error: new TypeError('secret: private dialogue'),
    }), true);
    const entries = log.snapshot();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].errorType, 'TypeError');
    assert.equal(entries[0].targetIndex, 12);
    assert.equal(JSON.stringify(entries).includes('private dialogue'), false);
});

test('strict whitelist drops IDs, chat text, file paths, arbitrary details and stack', () => {
    const log = new Diagnostics({ enabled: true });
    log.record('chat-switch', 'switch_completed', {
        status: 'ok', targetIndex: 5, count: 20, durationMs: 12.4,
        chatName: '비밀 대화', chatId: 'private.jsonl', message: 'password=1234',
        filePath: 'C:/secret/private.jsonl', stack: 'super sensitive',
    });
    const snapshot = JSON.stringify(log.snapshot());
    for (const secret of ['비밀 대화', 'private.jsonl', 'password', 'secret', 'stack']) {
        assert.equal(snapshot.includes(secret), false);
    }
    assert.equal(log.snapshot()[0].durationMs, 12);
});

test('invalid categories, event codes and arbitrary error types are rejected', () => {
    const log = new Diagnostics({ enabled: true });
    assert.equal(log.record('hack', 'jump_started', {}), false);
    assert.equal(log.record('navigation', '../path', {}), false);
    assert.equal(log.record('navigation', 'text:' + 'a'.repeat(100), {}), false);
    assert.equal(diagnosticErrorType({ name: 'MyDialogContents' }), 'Error');
    assert.equal(log.snapshot().length, 0);
});

test('ring buffer keeps recent events with stable sequence numbers', () => {
    const log = new Diagnostics({ enabled: true, maxEvents: 10, now: () => 1782864000000 });
    for (let i = 0; i < 17; i++) log.record('ui', 'panel_opened', { status: 'ok' });
    assert.equal(log.snapshot().length, 10);
    assert.equal(log.snapshot()[0].sequence, 8);
    assert.equal(log.snapshot()[9].sequence, 17);
    assert.equal(log.limit, 10);
    assert.equal(MAX_DIAGNOSTIC_EVENTS, 120);
});

test('snapshot is a copy, cleared events are gone and disabling stops normal logs', () => {
    const log = new Diagnostics({ enabled: true });
    log.record('save', 'title_saved');
    log.snapshot()[0].code = 'modified';
    assert.equal(log.snapshot()[0].code, 'title_saved');
    log.setEnabled(false);
    assert.equal(log.record('save', 'title_saved'), false);
    log.clear();
    assert.equal(log.snapshot().length, 0);
});

test('invalid or enormous numeric metadata is omitted, durations bounded', () => {
    const log = new Diagnostics({ enabled: true });
    log.record('scrolling', 'scroll_complete', {
        targetIndex: -2, count: Number.NaN, durationMs: 2e10,
    });
    const entry = log.snapshot()[0];
    assert.equal('targetIndex' in entry, false);
    assert.equal('count' in entry, false);
    assert.equal(entry.durationMs, 86_400_000);
});

test('JSON export includes only safe version and normalized events', () => {
    const log = new Diagnostics({ enabled: true });
    log.record('navigation', 'jump_completed', { targetIndex: 3, status: 'ok' });
    const report = JSON.parse(log.exportJSON({ extensionVersion: '1.3.1' }));
    assert.equal(report.schemaVersion, DIAGNOSTIC_VERSION);
    assert.equal(report.extensionVersion, '1.3.1');
    assert.equal(report.events[0].targetIndex, 3);
    assert.equal(JSON.parse(log.exportJSON({ extensionVersion: 'secret/file/path' })).extensionVersion, 'unknown');
});

test('the logger accepts documented categories without persisting raw errors', () => {
    const log = new Diagnostics({ enabled: true });
    for (const category of ['lifecycle','navigation','scrolling','chat-switch','save','search','swipe','compatibility','ui']) {
        assert.equal(log.record(category, 'sample', { status: 'error', error: Error('never export me') }), true);
    }
    assert.equal(log.snapshot().length, 9);
    assert.equal(log.exportJSON().includes('never export me'), false);
});
