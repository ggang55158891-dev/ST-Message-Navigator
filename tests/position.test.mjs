import test from 'node:test';
import assert from 'node:assert/strict';
import { validNavPosition, constrainNavPosition, fromRelativeNavPosition, toRelativeNavPosition } from '../position.js';

test('stored coordinates must be normalized and finite', () => {
    assert.equal(validNavPosition({ x: 0.3, y: 0.6 }), true);
    assert.equal(validNavPosition({ x: -0.1, y: 0.6 }), false);
    assert.equal(validNavPosition({ x: 0.3, y: Number.NaN }), false);
    assert.equal(validNavPosition(null), false);
});
test('dragged location is bounded inside available desktop viewport', () => {
    assert.deepEqual(constrainNavPosition(-100, -50, 1200, 800, 38, 220), { left: 6, centerY: 116 });
    assert.deepEqual(constrainNavPosition(1300, 900, 1200, 800, 38, 220), { left: 1156, centerY: 684 });
});
test('position survives a resize using relative offsets', () => {
    const saved = toRelativeNavPosition(800, 360, 1200, 800, 38, 220);
    assert.deepEqual(fromRelativeNavPosition(saved, 1200, 800, 38, 220), { left: 800, centerY: 360 });
    const resized = fromRelativeNavPosition(saved, 800, 600, 38, 220);
    assert.ok(resized.left >= 6 && resized.left <= 756);
    assert.ok(resized.centerY >= 116 && resized.centerY <= 484);
});
test('narrow screens do not produce negative saved positions', () => {
    const saved = toRelativeNavPosition(500, 350, 320, 420, 34, 194);
    assert.equal(validNavPosition(saved), true);
    const restored = fromRelativeNavPosition(saved, 320, 420, 34, 194);
    assert.ok(restored.left + 34 <= 320);
    assert.ok(restored.centerY - 97 >= 0);
});
