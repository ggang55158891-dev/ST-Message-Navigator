import test from 'node:test';
import assert from 'node:assert/strict';
import { getCurrentIndex, scrollToMessage, NavigationCursor } from '../scroll.js';
import { findTarget } from '../model.js';
function node(id, top, height = 100) {
    return { getAttribute: () => `${id}`, getBoundingClientRect: () => ({ top, bottom: top + height, height }) };
}
test('detects the first message intersecting the top of chat viewport', () => {
    const children = [node(4, -40), node(5, 60), node(6, 160)];
    const chat = {
        querySelectorAll: () => children,
        getBoundingClientRect: () => ({ top: 0, bottom: 400 }),
    };
    assert.equal(getCurrentIndex(chat, 10), 4);
    const scrolled = { ...chat, querySelectorAll: () => [node(4, -120), node(5, 10), node(6, 160)] };
    assert.equal(getCurrentIndex(scrolled, 10), 5);
});
test('scroll offset is relative to chat viewport, without touching page scroll', () => {
    let target;
    const chat = {
        scrollTop: 120,
        getBoundingClientRect: () => ({ top: 100 }),
        scrollTo: arg => { target = arg; },
    };
    assert.equal(scrollToMessage(chat, node(1, 350)), true);
    assert.equal(target.top, 358);
    assert.equal(target.behavior, 'instant');
});

test('previous navigation uses explicit message when end-of-chat scrolling is clamped', () => {
    // #7 was requested, but #6 remains the top-most visible row because the
    // chat cannot scroll farther near its bottom edge.
    const chat = {
        scrollTop: 500,
        querySelectorAll: () => [node(5, -50), node(6, 150)],
        getBoundingClientRect: () => ({ top: 0, bottom: 400 }),
    };
    assert.equal(getCurrentIndex(chat, 7), 5);
    const cursor = new NavigationCursor();
    cursor.set(chat, 6); // #7 (0-based index 6) was the selected outline row
    assert.equal(cursor.resolve(chat, 7), 6);
    assert.equal(cursor.resolve(chat, 7), 6); // even after a refresh event
    const messages = Array.from({ length: 7 }, () => ({ is_system: false }));
    assert.equal(findTarget(messages, cursor.resolve(chat, 7), 'previous'), 5); // #6, not #5
});

test('manual scrolling clears the explicit navigation anchor', () => {
    const chat = {
        scrollTop: 500,
        querySelectorAll: () => [node(5, -50), node(6, 150)],
        getBoundingClientRect: () => ({ top: 0, bottom: 400 }),
    };
    const cursor = new NavigationCursor();
    cursor.set(chat, 6);
    chat.scrollTop = 440;
    assert.equal(cursor.resolve(chat, 7), 5);
    assert.equal(cursor.index, -1);
});

test('chat changes and invalidated message ranges clear explicit position', () => {
    const chat = {
        scrollTop: 90,
        querySelectorAll: () => [node(0, -15), node(1, 85)],
        getBoundingClientRect: () => ({ top: 0 }),
    };
    const cursor = new NavigationCursor();
    cursor.set(chat, 6);
    assert.equal(cursor.resolve(chat, 2), 0);
    cursor.set(chat, 1);
    cursor.clear();
    assert.equal(cursor.resolve(chat, 2), 0);
});

test('scrolling aligns using the inner scrollport instead of its border', () => {
    let target;
    const chat = {
        scrollTop: 40,
        clientTop: 3,
        getBoundingClientRect: () => ({ top: 100 }),
        scrollTo: arg => { target = arg; },
    };
    assert.equal(scrollToMessage(chat, node(8, 300)), true);
    assert.equal(target.top, 225);
    assert.equal(target.behavior, 'instant');
});
