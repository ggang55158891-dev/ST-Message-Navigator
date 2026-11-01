import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PANEL_MIN_WIDTH, PANEL_MIN_HEIGHT, PANEL_MAX_WIDTH, PANEL_MAX_HEIGHT,
  validPanelSize, fitPanelSize,
} from '../panel-size.js';
import { DEFAULT_SETTINGS, createSettingsBackup, parseSettingsBackup, diffSettings, normalizeSettings } from '../settings-backup.js';

test('panel size validation rejects out of range, NaN and unknown fields', () => {
  assert.equal(validPanelSize(null), false);
  assert.equal(validPanelSize({ width: 400, height: 500 }), true);
  assert.equal(validPanelSize({ width: 400, height: 500, injected: true }), false);
  assert.equal(validPanelSize({ width: NaN, height: 500 }), false);
  assert.equal(validPanelSize({ width: PANEL_MAX_WIDTH + 1, height: 500 }), false);
  assert.equal(validPanelSize({ width: PANEL_MIN_WIDTH - 1, height: 500 }), false);
  assert.equal(validPanelSize({ width: 400, height: PANEL_MIN_HEIGHT - 1 }), false);
  assert.equal(validPanelSize({ width: 400, height: PANEL_MAX_HEIGHT + 1 }), false);
});

test('panel dimensions respect desktop/mobile viewport and fixed top offset', () => {
  const desktop = fitPanelSize({ width: 600, height: 900 }, 1280, 800);
  assert.equal(desktop.width, 600);
  assert.ok(desktop.height <= 800 * 0.92 - 8);
  const mobile = fitPanelSize({ width: 600, height: 900 }, 375, 667);
  assert.equal(mobile.width, 351);
  assert.ok(mobile.height < 610);
  const tiny = fitPanelSize(null, 240, 350);
  assert.ok(tiny.width <= 216 && tiny.height <= 350);
  assert.equal(fitPanelSize(null, 1280, 800).width, 400);
});

test('new panelSize setting round-trips without touching other keys', () => {
  const settings = { ...DEFAULT_SETTINGS, panelSize: { width: 580, height: 620 } };
  const restored = parseSettingsBackup(createSettingsBackup(settings)).settings;
  assert.deepEqual(restored.panelSize, settings.panelSize);
  assert.deepEqual(normalizeSettings({ panelSize: { width: 9999, height: 900 } }).panelSize, null);
  assert.ok(diffSettings(DEFAULT_SETTINGS, settings).some(change => change.key === 'panelSize'));
});

test('legacy A-03 7-field settings backups still restore with default panel size', () => {
  const old = JSON.parse(createSettingsBackup(DEFAULT_SETTINGS));
  delete old.sections.settings.panelSize;
  const restored = parseSettingsBackup(JSON.stringify(old)).settings;
  assert.equal(restored.panelSize, null);
  assert.equal(restored.mode, 'visible');
});

test('malformed panel dimensions in backups fail before any settings change', () => {
  const old = JSON.parse(createSettingsBackup(DEFAULT_SETTINGS));
  old.sections.settings.panelSize = { width: 400, height: 9000 };
  assert.throws(() => parseSettingsBackup(JSON.stringify(old)), /패널 크기/);
  old.sections.settings.panelSize = { width: 400, height: 500, name: 'private' };
  assert.throws(() => parseSettingsBackup(JSON.stringify(old)), /패널 크기/);
});
