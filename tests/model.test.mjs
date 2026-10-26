import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DATA_KEY, MESSAGE_KEY, isNavigable, findTarget, automaticTitle,
    getTitle, isCustomTitle, assignCustomTitle,
} from '../model.js';

const messages = [
    { is_user: true, is_system: false, mes: 'A' },
    { is_user: false, is_system: true, mes: 'B' },
    { is_user: false, is_system: true, mes: 'C' },
    { is_user: true, is_system: false, mes: 'D' },
    { is_user: false, is_system: false, mes: 'E' },
];

test('navigation visits all entries when including hidden', () => {
    assert.equal(findTarget(messages, 0, 'next', 'all'), 1);
    assert.equal(findTarget(messages, 2, 'previous', 'all'), 1);
    assert.equal(findTarget(messages, 2, 'first', 'all'), 0);
    assert.equal(findTarget(messages, 2, 'last', 'all'), 4);
});
test('navigation skips consecutive hidden messages in visible mode', () => {
    assert.equal(isNavigable(messages[1], 'visible'), false);
    assert.equal(findTarget(messages, 0, 'next', 'visible'), 3);
    assert.equal(findTarget(messages, 3, 'previous', 'visible'), 0);
    assert.equal(findTarget(messages, 3, 'last', 'visible'), 4);
    assert.equal(findTarget(messages, 0, 'previous', 'visible'), -1);
    assert.equal(findTarget(messages, 4, 'next', 'visible'), -1);
    assert.equal(findTarget([], 0, 'first'), -1);
    assert.equal(findTarget([{ is_system: true }], 0, 'first'), -1);
});
test('first sentence strips formatting and truncates', () => {
    assert.equal(automaticTitle({ mes: '**안녕하세요.** 다음 문장입니다.' }), '안녕하세요.');
    assert.equal(automaticTitle({ mes: '   ' }), '(내용 없는 메시지)');
    assert.equal(automaticTitle({ mes: '', extra: { image: 'x' } }), '(이미지/첨부 메시지)');
    assert.ok(automaticTitle({ mes: '가'.repeat(200) }).length <= 69);
});
test('title edit never changes mes, and remains bound after index shift', () => {
    const chat = structuredClone(messages);
    const metadata = {};
    const body = chat[3].mes;
    assignCustomTitle(chat, metadata, 3, '눈 내리는 첫 만남', () => 'uuid-1');
    assert.equal(chat[3].mes, body);
    assert.equal(chat[3][MESSAGE_KEY], 'uuid-1');
    assert.equal(metadata[DATA_KEY].titles['uuid-1'], '눈 내리는 첫 만남');
    assert.equal(isCustomTitle(chat[3], metadata), true);
    chat.splice(1, 1);
    assert.equal(getTitle(chat[2], metadata), '눈 내리는 첫 만남');
});
test('branch clones keep titles and can edit independently', () => {
    const chat = structuredClone(messages);
    const metadata = {};
    assignCustomTitle(chat, metadata, 3, '원본 제목', () => 'first-id');
    const branch = structuredClone(chat.slice(0, 4));
    const branchMetadata = structuredClone(metadata);
    assert.equal(getTitle(branch[3], branchMetadata), '원본 제목');
    assignCustomTitle(branch, branchMetadata, 3, '분기 제목', () => 'unused');
    assert.equal(getTitle(branch[3], branchMetadata), '분기 제목');
    assert.equal(getTitle(chat[3], metadata), '원본 제목');
});
test('duplicated message IDs are deconflicted when edited', () => {
    const chat = structuredClone(messages);
    const metadata = {};
    assignCustomTitle(chat, metadata, 0, '원본', () => 'id-original');
    chat.splice(1, 0, structuredClone(chat[0]));
    assignCustomTitle(chat, metadata, 1, '복사본', () => 'id-copy');
    assert.equal(getTitle(chat[0], metadata), '원본');
    assert.equal(getTitle(chat[1], metadata), '복사본');
});
test('reset title returns to automatic and keeps the body intact', () => {
    const chat = [{ mes: '본문입니다. 기타 설명.', is_user: true }];
    const metadata = {};
    assignCustomTitle(chat, metadata, 0, '내 제목', () => 'stable');
    assignCustomTitle(chat, metadata, 0, '');
    assert.equal(getTitle(chat[0], metadata), '본문입니다.');
    assert.equal(chat[0].mes, '본문입니다. 기타 설명.');
});
