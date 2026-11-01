/** Versioned, small, settings-only backups. Pure functions; no chat mutations. */
import { validNavPosition } from './position.js';

export const BACKUP_KIND = 'stmn-extension-settings';
export const BACKUP_SCHEMA_VERSION = 1;
export const MAX_BACKUP_BYTES = 32768;

export const DEFAULT_SETTINGS = Object.freeze({
    mode: 'visible',
    side: 'right',
    position: null,
    showNavigationButtons: true,
    elevatorTheme: 'classic',
    elevatorSky: 'auto',
    diagnosticsEnabled: false,
});
export const SETTINGS_FIELDS = Object.freeze(Object.keys(DEFAULT_SETTINGS));
const OPTIONS = Object.freeze({
    mode: ['visible', 'all'],
    side: ['left', 'right'],
    elevatorTheme: ['classic', 'restricted', 'sky'],
    elevatorSky: ['auto', 'day', 'night'],
});
const BOOLEAN_FIELDS = ['showNavigationButtons', 'diagnosticsEnabled'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

export function normalizeSettings(raw) {
    // Repairs legacy/partially missing settings without deleting unknown keys.
    const source = isObject(raw) ? raw : {};
    const out = { ...DEFAULT_SETTINGS };
    for (const [key, values] of Object.entries(OPTIONS)) {
        if (values.includes(source[key])) out[key] = source[key];
    }
    for (const key of BOOLEAN_FIELDS) {
        if (typeof source[key] === 'boolean') out[key] = source[key];
    }
    if (validNavPosition(source.position)) out.position = { x: source.position.x, y: source.position.y };
    return out;
}

function validateSettings(raw) {
    if (!isObject(raw)) throw new Error('설정 데이터 형식이 올바르지 않습니다.');
    const keys = Object.keys(raw);
    if (keys.length !== SETTINGS_FIELDS.length ||
        keys.some(key => !SETTINGS_FIELDS.includes(key)) ||
        SETTINGS_FIELDS.some(key => !has(raw, key))) {
        throw new Error('백업 설정 항목이 누락되었거나 지원되지 않는 항목이 있습니다.');
    }
    for (const [key, values] of Object.entries(OPTIONS)) {
        if (!values.includes(raw[key])) throw new Error('설정값이 유효하지 않습니다: ' + key);
    }
    for (const key of BOOLEAN_FIELDS) {
        if (typeof raw[key] !== 'boolean') throw new Error('설정값이 유효하지 않습니다: ' + key);
    }
    if (raw.position !== null && !validNavPosition(raw.position)) {
        throw new Error('저장된 버튼 위치가 유효하지 않습니다.');
    }
    if (isObject(raw.position) && (
        Object.keys(raw.position).length !== 2 ||
        !has(raw.position, 'x') || !has(raw.position, 'y')
    )) throw new Error('버튼 위치 데이터에 알 수 없는 값이 있습니다.');
    return normalizeSettings(raw);
}

export function createSettingsBackup(settings, { now = new Date(), version = 'unknown' } = {}) {
    const clean = normalizeSettings(settings);
    return JSON.stringify({
        type: BACKUP_KIND,
        schemaVersion: BACKUP_SCHEMA_VERSION,
        exportedAt: now.toISOString(),
        extensionVersion: /^\d+\.\d+\.\d+$/.test(version) ? version : 'unknown',
        sections: { settings: clean },
    }, null, 2);
}

/**
 * Parse fully BEFORE calling any mutate/save action.
 * Unsupported future schemas are rejected to avoid silent information loss.
 */
export function parseSettingsBackup(text) {
    if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) {
        throw new Error('백업 파일이 너무 크거나 텍스트 형식이 아닙니다. (최대 32KB)');
    }
    let root;
    try { root = JSON.parse(text); } catch { throw new Error('유효한 JSON 백업 파일이 아닙니다.'); }
    if (!isObject(root) || root.type !== BACKUP_KIND || root.schemaVersion !== BACKUP_SCHEMA_VERSION) {
        throw new Error('이 확장에서 지원하는 설정 백업 파일이 아닙니다.');
    }
    if (!isObject(root.sections) || Object.keys(root.sections).length !== 1 ||
        !has(root.sections, 'settings')) {
        throw new Error('지원되지 않는 데이터 구역이 포함된 백업입니다.');
    }
    if (typeof root.exportedAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(root.exportedAt) ||
        !Number.isFinite(Date.parse(root.exportedAt))) {
        throw new Error('백업 생성 시각을 읽을 수 없습니다.');
    }
    return {
        exportedAt: root.exportedAt,
        settings: validateSettings(root.sections.settings),
    };
}

export function diffSettings(current, incoming) {
    const from = normalizeSettings(current);
    const to = validateSettings(incoming);
    return SETTINGS_FIELDS.filter(key => JSON.stringify(from[key]) !== JSON.stringify(to[key]))
        .map(key => ({ key, before: from[key], after: to[key] }));
}
