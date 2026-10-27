import test from 'node:test';
import assert from 'node:assert/strict';
import {
    GROUP_SIZE, GROUP_ROW_HEIGHT, MESSAGE_ROW_HEIGHT,
    filterOutlineEntries, buildOutlineRows, findOutlineRow,
} from '../outline.js';

const entries = Array.from({ length: 23 }, (_, index) => ({
    index,
    searchable: index === 14 ? 'chapter four: #4 is mentioned here' : 'some dialogue',
}));

test('exact #number filter matches the zero-based index only', () => {
    assert.deepEqual(filterOutlineEntries(entries, '#4').map(row => row.index), [4]);
    assert.deepEqual(filterOutlineEntries(entries, ' #0 ').map(row => row.index), [0]);
    assert.deepEqual(filterOutlineEntries(entries, '#14').map(row => row.index), [14]);
    assert.deepEqual(filterOutlineEntries(entries, '#040').map(row => row.index), []);
    assert.deepEqual(filterOutlineEntries(entries, '#999999999999999999').map(row => row.index), []);
    assert.deepEqual(filterOutlineEntries(entries, '#4').filter(row => row.index === 14), []);
});

test('normal text search keeps case-insensitive title/body/name matching', () => {
    assert.deepEqual(filterOutlineEntries(entries, 'CHAPTER').map(row => row.index), [14]);
    assert.deepEqual(filterOutlineEntries(entries, 'not found'), []);
    assert.equal(filterOutlineEntries(entries, ''), entries);
});

test('messages group into #0–#9, #10–#19 and partial last group', () => {
    assert.equal(GROUP_SIZE, 10);
    const layout = buildOutlineRows(entries, entries.length);
    const headers = layout.rows.filter(row => row.kind === 'group');
    assert.deepEqual(headers.map(row => [row.start, row.end, row.count]), [
        [0, 9, 10], [10, 19, 10], [20, 22, 3],
    ]);
    assert.equal(layout.rows.filter(row => row.kind === 'message').length, 23);
    assert.equal(layout.totalHeight, 23 * MESSAGE_ROW_HEIGHT + 3 * GROUP_ROW_HEIGHT);
});

test('individually collapsed groups retain their headers and hide only their messages', () => {
    const layout = buildOutlineRows(entries, entries.length, new Set([10]));
    assert.equal(layout.rows.filter(row => row.kind === 'message').length, 13);
    assert.equal(layout.rows.filter(row => row.kind === 'group').length, 3);
    assert.equal(layout.rows.find(row => row.kind === 'group' && row.start === 10).collapsed, true);
    assert.equal(layout.rows.some(row => row.kind === 'message' && row.entry.index === 14), false);
});

test('collapse all and expand all respect partially filled groups', () => {
    const collapsed = new Set([0, 10, 20]);
    const closed = buildOutlineRows(entries, entries.length, collapsed);
    assert.equal(closed.rows.length, 3);
    assert.equal(closed.totalHeight, 3 * GROUP_ROW_HEIGHT);
    const open = buildOutlineRows(entries, entries.length, new Set());
    assert.equal(open.rows.length, 26);
});

test('a search bypasses group collapse and renders only matching message rows', () => {
    const subset = filterOutlineEntries(entries, '#14');
    const layout = buildOutlineRows(subset, entries.length, new Set([10]), true);
    assert.deepEqual(layout.rows.map(row => [row.kind, row.entry.index]), [['message', 14]]);
    assert.equal(layout.totalHeight, MESSAGE_ROW_HEIGHT);
});

test('virtualization binary search finds exact row boundaries across mixed heights', () => {
    const layout = buildOutlineRows(entries.slice(0, 12), 12);
    assert.equal(findOutlineRow(layout.rows, 0), 0);
    assert.equal(findOutlineRow(layout.rows, GROUP_ROW_HEIGHT - 1), 0);
    assert.equal(findOutlineRow(layout.rows, GROUP_ROW_HEIGHT), 1);
    assert.equal(findOutlineRow(layout.rows, GROUP_ROW_HEIGHT + MESSAGE_ROW_HEIGHT), 2);
    assert.equal(findOutlineRow(layout.rows, layout.totalHeight + 100), layout.rows.length - 1);
    assert.equal(findOutlineRow([], 0), 0);
});
