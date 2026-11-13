'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { validateCategories, normalizeCategory, parseCategoryTag, isOriginalDeliverable } = require('../src/categories');
const { collectDigest, groupedReplies, makeRange } = require('../src/digest');
const categories = ['イラスト', '動画', '文章', '音楽', 'その他'];

test('分類設定の重複・空白・区切り記号・既定名を拒否する', () => {
  assert.deepEqual(validateCategories(categories), categories);
  for (const value of [[], ['動画', '動画'], ['制作物'], ['改行\n'], ['a'.repeat(61)], [' 前後の空白'], ['動画 作品'], ['動画、作品']]) {
    assert.throws(() => validateCategories(value), { code: 'INVALID_CATEGORIES' });
  }
});
test('本文のタグだけで候補にある分類を読み取る', () => {
  for (const category of categories) {
    assert.deepEqual(parseCategoryTag('#制作物-' + category + '\nサンプルです。', categories), { matched: true, category });
  }
  assert.deepEqual(parseCategoryTag('説明文\n#制作物-イラスト', categories), { matched: true, category: 'イラスト' });
  assert.deepEqual(parseCategoryTag('説明 #制作物-動画。', categories), { matched: true, category: '動画' });
});
test('分類なし・分類の誤字・空の分類・削除された候補は制作物にまとめる', () => {
  for (const text of ['#制作物', '#制作物-', '#制作物-候補外', '#制作物-イラスト追加', '#制作物--動画']) {
    assert.deepEqual(parseCategoryTag(text, categories), { matched: true, category: '制作物' });
  }
  assert.equal(parseCategoryTag('#制作物-動画', ['イラスト']).category, '制作物');
  assert.equal(normalizeCategory(undefined, categories), '制作物');
});
test('雑談・別のタグ・文章の一部・URLの中の文字列は対象にしない', () => {
  for (const text of ['雑談', '#成果物-イラスト', '#制作物です', 'これは#制作物-動画', 'https://example.com/#制作物-動画', '＃制作物-動画']) {
    assert.equal(parseCategoryTag(text, categories).matched, false, text);
  }
});
test('複数タグがある場合は先頭のタグを採用する', () => {
  assert.equal(parseCategoryTag('#制作物-動画\n#制作物-イラスト', categories).category, '動画');
  assert.equal(parseCategoryTag('#制作物\n#制作物-動画', categories).category, '制作物');
  assert.equal(parseCategoryTag('#制作物-不明 #制作物-動画', categories).category, '制作物');
});
test('分類タグ付きでもボット・スレッド返信は対象外にする', () => {
  const message = { user: 'U12345', ts: '123.000001', text: '#制作物-イラスト' };
  assert(isOriginalDeliverable(message));
  assert(!isOriginalDeliverable({ ...message, bot_id: 'B12345' }));
  assert(!isOriginalDeliverable({ ...message, thread_ts: '123.000000' }));
});
test('分類別の見出しは設定順、候補外・未分類は制作物にまとめる', () => {
  const item = (category, label) => ({ category, label, url: 'https://school.slack.com/x' });
  const replies = groupedReplies([item('動画', 'a.mp4'), item('イラスト', 'b.png'), item('候補外', 'c.txt'), item(undefined, 'd.jpeg')], categories);
  assert.equal(replies.length, 3);
  assert(replies[0].startsWith('*イラスト*'));
  assert(replies[1].startsWith('*動画*'));
  assert(replies[2].startsWith('*制作物*'));
  assert(replies[2].includes('c.txt') && replies[2].includes('d.jpeg'));
});
test('分類ごとの長い一覧はSlackの送信サイズに合わせて分割する', () => {
  const items = Array.from({ length: 30 }, () => ({ category: '動画', label: 'a'.repeat(180), url: 'https://school.slack.com/x' }));
  const replies = groupedReplies(items, categories);
  assert(replies.length > 1);
  assert(replies.every(reply => reply.length <= 2800));
  assert(replies[1].includes('続き'));
});
test('履歴からタグ付き・未分類を抽出し、旧分類ファイルは参照しない', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tag-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'categories.json'), '{broken-legacy-data');
  const now = new Date('2026-11-14T12:00:00+09:00');
  const messages = ['#制作物-イラスト', '#制作物-動画', '#制作物-不明', '#制作物', '雑談'].map((text, i) => ({
    user: 'U12345', ts: String(now.getTime() / 1000 - 600 + i) + '.000000', text, files: [{ name: '架空.png' }]
  }));
  const client = {
    conversations: { history: async () => ({ ok: true, messages }) },
    chat: { getPermalink: async () => ({ ok: true, permalink: 'https://school.slack.com/archives/C12345/p123' }) }
  };
  const result = await collectDigest(client, { sourceChannel: 'C12345', categories, maxPages: 20, maxItems: 50, stateDir: directory }, makeRange(now, false));
  assert.equal(result.matched, 4);
  assert.deepEqual(result.items.map(item => item.category), ['イラスト', '動画', '制作物', '制作物']);
  assert.equal(await fs.readFile(path.join(directory, 'categories.json'), 'utf8'), '{broken-legacy-data');
});
