import test from 'node:test';
import assert from 'node:assert/strict';
import { getCurrentIndex, scrollToMessage } from '../scroll.js';
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
    assert.equal(target.behavior, 'auto');
});
