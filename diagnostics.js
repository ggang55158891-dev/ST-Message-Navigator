/**
 * Opt-in, privacy-first diagnostic event ledger.
 *
 * No chat text, file names, character names, prompt text, URLs, stack traces,
 * raw exception messages, or arbitrary caller-supplied fields are stored.
 * Normal events are recorded only when enabled; errors are kept in memory
 * even when detailed diagnostics are off.
 */
export const DIAGNOSTIC_VERSION = 1;
export const MAX_DIAGNOSTIC_EVENTS = 120;
const CATEGORIES = new Set([
    'lifecycle', 'navigation', 'scrolling', 'chat-switch', 'save',
    'search', 'swipe', 'compatibility', 'ui',
]);
const STATUSES = new Set(['started', 'ok', 'error', 'cancelled', 'skipped']);
const ERROR_TYPES = new Set([
    'Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError',
    'URIError', 'AggregateError', 'AbortError', 'TimeoutError',
    'NotFoundError', 'InvalidStateError',
]);
const EVENT_CODE = /^[a-z][a-z0-9_-]{0,47}$/;
const safeNonnegative = value =>
    Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : undefined;

export function diagnosticErrorType(error) {
    const name = error?.name;
    return ERROR_TYPES.has(name) ? name : 'Error';
}

export class Diagnostics {
    constructor({ enabled = false, maxEvents = MAX_DIAGNOSTIC_EVENTS, now = () => Date.now() } = {}) {
        this.enabled = enabled === true;
        this.limit = Number.isInteger(maxEvents) ? Math.min(200, Math.max(10, maxEvents)) : MAX_DIAGNOSTIC_EVENTS;
        this.now = now;
        this.entries = [];
        this.sequence = 0;
    }

    setEnabled(enabled) {
        this.enabled = enabled === true;
    }

    record(category, code, details = {}) {
        // Invalid categories and codes never enter the exported audit trail.
        if (!CATEGORIES.has(category) || typeof code !== 'string' || !EVENT_CODE.test(code)) return false;
        const status = STATUSES.has(details?.status) ? details.status : 'ok';
        if (!this.enabled && status !== 'error') return false;
        const time = this.now();
        const event = {
            sequence: ++this.sequence,
            time: new Date(Number.isFinite(time) ? time : Date.now()).toISOString(),
            category,
            code,
            status,
        };
        const index = safeNonnegative(details?.targetIndex);
        const count = safeNonnegative(details?.count);
        if (index !== undefined) event.targetIndex = index;
        if (count !== undefined) event.count = count;
        if (typeof details?.durationMs === 'number' && Number.isFinite(details.durationMs) && details.durationMs >= 0) {
            event.durationMs = Math.round(Math.min(details.durationMs, 86_400_000));
        }
        if (status === 'error') event.errorType = diagnosticErrorType(details?.error);
        this.entries.push(event);
        if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
        return true;
    }

    snapshot() {
        return this.entries.map(entry => ({ ...entry }));
    }

    clear() {
        this.entries = [];
    }

    exportJSON({ extensionVersion = 'unknown' } = {}) {
        // Reject caller-defined version strings that could contain sensitive data.
        const version = typeof extensionVersion === 'string' && /^(\d+\.){2}\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(extensionVersion)
            ? extensionVersion : 'unknown';
        return JSON.stringify({
            schemaVersion: DIAGNOSTIC_VERSION,
            extensionVersion: version,
            diagnosticMode: this.enabled,
            events: this.snapshot(),
        }, null, 2);
    }
}
