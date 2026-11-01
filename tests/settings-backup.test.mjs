import test from 'node:test';
import assert from 'node:assert/strict';
import {
    BACKUP_KIND, BACKUP_SCHEMA_VERSION, DEFAULT_SETTINGS, SETTINGS_FIELDS,
    normalizeSettings, createSettingsBackup, parseSettingsBackup, diffSettings, MAX_BACKUP_BYTES,
} from '../settings-backup.js';
import { inspectTitleMetadata } from '../metadata-audit.js';

const sample = () => createSettingsBackup({
    ...DEFAULT_SETTINGS, mode: 'all', side: 'left',
    position: { x: 0.25, y: 0.75 }, elevatorTheme: 'sky', elevatorSky: 'night',
}, { now: new Date('2026-11-01T01:00:00.000Z'), version: '1.3.3' });

test('legacy settings with invalid or missing fields normalize without mutating input', () => {
    const old = { mode: 'all', side: 'hack', position: { x: 5, y: 0.4 }, elevatorTheme: null, arbitrary: 'keep' };
    const before = JSON.stringify(old);
    const valid = normalizeSettings(old);
    assert.equal(valid.mode, 'all');
    assert.equal(valid.side, 'right');
    assert.equal(valid.position, null);
    assert.equal(valid.elevatorTheme, 'classic');
    assert.equal(valid.diagnosticsEnabled, false);
    assert.equal(Object.hasOwn(valid, 'arbitrary'), false);
    assert.equal(JSON.stringify(old), before);
    assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
    assert.deepEqual(normalizeSettings([]), DEFAULT_SETTINGS);
});

test('versioned backup round-trips all supported settings and excludes unrelated extension keys', () => {
    const input = JSON.parse(sample());
    assert.equal(input.type, BACKUP_KIND);
    assert.equal(input.schemaVersion, BACKUP_SCHEMA_VERSION);
    assert.equal(input.extensionVersion, '1.3.3');
    assert.deepEqual(Object.keys(input.sections.settings).sort(), [...SETTINGS_FIELDS].sort());
    const restored = parseSettingsBackup(sample());
    assert.equal(restored.settings.mode, 'all');
    assert.deepEqual(restored.settings.position, { x: 0.25, y: 0.75 });
    const exported = createSettingsBackup({ ...DEFAULT_SETTINGS, secret: 'SHOULD NEVER EXPORT' });
    assert.equal(exported.includes('SHOULD NEVER EXPORT'), false);
});

test('partial backups and modified/unknown schema versions are rejected', () => {
    const base = JSON.parse(sample());
    delete base.sections.settings.mode;
    assert.throws(() => parseSettingsBackup(JSON.stringify(base)), /설정/);
    const extra = JSON.parse(sample());
    extra.sections.newFeature = { tokens: 'secret' };
    assert.throws(() => parseSettingsBackup(JSON.stringify(extra)), /지원되지 않는 데이터/);
    const future = JSON.parse(sample());
    future.schemaVersion = 2;
    assert.throws(() => parseSettingsBackup(JSON.stringify(future)), /지원하는 설정 백업/);
});

test('unknown field types and out-of-bounds positions cannot be imported', () => {
    const base = JSON.parse(sample());
    base.sections.settings.position.x = 1.4;
    assert.throws(() => parseSettingsBackup(JSON.stringify(base)), /위치/);
    const another = JSON.parse(sample());
    another.sections.settings.showNavigationButtons = 'yes';
    assert.throws(() => parseSettingsBackup(JSON.stringify(another)), /설정값/);
    const injected = JSON.parse(sample());
    injected.sections.settings.position.secret = 'hidden';
    assert.throws(() => parseSettingsBackup(JSON.stringify(injected)), /위치 데이터/);
    const unknown = JSON.parse(sample());
    unknown.sections.settings.futureKey = true;
    assert.throws(() => parseSettingsBackup(JSON.stringify(unknown)), /설정 항목/);
});

test('invalid JSON, unexpected backup type and large files are rejected safely', () => {
    assert.throws(() => parseSettingsBackup('{broken'), /JSON/);
    assert.throws(() => parseSettingsBackup('[]'), /지원하는/);
    assert.throws(() => parseSettingsBackup('x'.repeat(MAX_BACKUP_BYTES + 1)), /너무 크거나/);
    assert.throws(() => parseSettingsBackup(new Uint8Array(10)), /텍스트/);
    const fake = JSON.parse(sample());
    fake.type = 'another-extension';
    assert.throws(() => parseSettingsBackup(JSON.stringify(fake)), /지원하는/);
});

test('prototype pollution properties in backup do not affect Object.prototype', () => {
    const object = JSON.parse(sample());
    object.sections.settings = JSON.parse(
        JSON.stringify(object.sections.settings).slice(0, -1) + ',"__proto__":{"polluted":true}}',
    );
    assert.throws(() => parseSettingsBackup(JSON.stringify(object)), /설정 항목/);
    assert.equal(({}).polluted, undefined);
});

test('settings diff displays only changed options and does not change the original', () => {
    const backup = parseSettingsBackup(sample()).settings;
    const current = { ...DEFAULT_SETTINGS };
    const diff = diffSettings(current, backup);
    assert.deepEqual(diff.map(row => row.key).sort(), ['elevatorSky','elevatorTheme','mode','position','side'].sort());
    assert.equal(current.mode, 'visible');
    assert.equal(backup.mode, 'all');
});

test('title metadata audit only reads existing chat and counts duplicates/orphans', () => {
    const chat = [
        { stmn_message_id_v1: 'one' }, { stmn_message_id_v1: 'one' },
        { stmn_message_id_v1: 'two' }, { mes: 'do not export this' },
    ];
    const metadata = { stmn_message_outline_v1: { titles: { one:'Title A', two:'Title B', orphan:'Lost', bad:'' } } };
    const before = JSON.stringify({ chat, metadata });
    const summary = inspectTitleMetadata(chat, metadata);
    assert.deepEqual(summary, {
        messages: 4, customTitles: 3, orphanTitles: 1,
        invalidTitles: 1, duplicateMessageIds: 1, malformedStore: false,
    });
    assert.equal(JSON.stringify({ chat, metadata }), before);
    assert.equal(JSON.stringify(summary).includes('do not export'), false);
});

test('title metadata audit tolerates missing or malformed existing metadata', () => {
    assert.equal(inspectTitleMetadata(null, null).malformedStore, false);
    assert.equal(inspectTitleMetadata([], {stmn_message_outline_v1:{titles:[]}}).malformedStore, true);
    assert.equal(inspectTitleMetadata([], {stmn_message_outline_v1:'invalid'}).malformedStore, true);
});
