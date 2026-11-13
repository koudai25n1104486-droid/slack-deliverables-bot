'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { canvasMarkdown, canvasLink, setupChannelCanvas } = require('../src/canvas');
const { runDigest, makeRange } = require('../src/digest');
const { StateStore } = require('../src/state');
const { loadConfig } = require('../src/config');
const now = new Date('2026-11-16T09:01:00+09:00');
const range = makeRange(now, true);
const config = { sourceChannel: 'C12345', outputChannel: 'C12345', testChannel: 'C12345',
  canvasId: 'F12345', testCanvasId: 'F12345', outputMode: 'canvas', allowPost: true,
  autoPin: true, maxItems: 50, maxPages: 20, categories: ['イラスト', '動画'] };
const data = { matched: 2, items: [
  { category: 'イラスト', label: '架空.png', url: 'https://school.slack.com/archives/C12345/p123' },
  { category: '候補外', label: '架空.pdf', url: 'https://school.slack.com/archives/C12345/p124' }
] };
function fakeClient({ editError, createError } = {}) {
  const calls = [];
  function record(method, payload) { calls.push({ method, payload }); }
  const client = { calls,
    conversations: {
      history: async payload => { record('history', payload); return { ok: true, messages: [{
        user: 'U_SYNTHETIC', ts: String(Date.parse('2026-11-14T12:00:00+09:00') / 1000) + '.000000',
        text: '#制作物-イラスト', files: [{ name: '架空.png' }]
      }] }; },
      canvases: { create: async payload => { record('create', payload); if (createError) throw createError; return { ok: true, canvas_id: 'F12345' }; } }
    },
    chat: { getPermalink: async payload => { record('permalink', payload); return { ok: true, permalink: data.items[0].url }; },
      postMessage: async () => { assert.fail('Canvas mode must not post chat messages'); } },
    pins: { add: async () => { assert.fail('Canvas mode must not pin messages'); } },
    canvases: { edit: async payload => { record('edit', payload); if (editError) throw editError; return { ok: true }; } }
  };
  return client;
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { store: new StateStore(directory) };
}

test('Canvasは対象期間・分類別見出し・元リンクだけで一覧を作る', () => {
  const text = canvasMarkdown(data, range, { mode: 'weekly', categories: config.categories });
  assert(text.includes('## 今週の制作物'));
  assert(text.includes('### イラスト'));
  assert(text.includes('### 制作物'));
  assert(!text.includes('### 動画'));
  assert(text.includes('[架空\\.png](https://school.slack.com/archives/'));
  assert(text.indexOf('イラスト') < text.indexOf('### 制作物'));
});
test('Canvasのファイル名によるリンク・見出し・メンション埋め込みを防ぐ', () => {
  const text = canvasMarkdown({ matched: 1, items: [{ ...data.items[0], label: 'x](https://evil.example)\n# <!channel> ![x]' }] }, range,
    { mode: 'test', testRunId: '2', categories: config.categories });
  assert(text.includes('【試作品 #2】'));
  assert(!text.includes('<!channel>'));
  assert(!text.includes('x](https://evil.example)'));
  assert(!text.includes('\n# <!channel>'));
  for (const value of ['https://school.slack.com.evil.example/x', 'http://school.slack.com/x', 'https://name@school.slack.com/x']) {
    assert.throws(() => canvasLink(value), { code: 'INVALID_LINK' });
  }
  assert(canvasLink('https://school.slack.com/x(y)').includes('%28y%29'));
});
test('同じCanvasへ追記だけを1回行い、再実行しても二重追記しない', async t => {
  const { store } = await fixture(t);
  const client = fakeClient();
  const args = { client, config, mode: 'weekly', now, store };
  assert.equal((await runDigest(args)).status, 'done');
  const edit = client.calls.find(call => call.method === 'edit').payload;
  assert.equal(edit.canvas_id, 'F12345');
  assert.equal(edit.changes.length, 1);
  assert.equal(edit.changes[0].operation, 'insert_at_end');
  assert.equal((await runDigest(args)).status, 'already_processed');
  assert.equal(client.calls.filter(call => call.method === 'edit').length, 1);
  const state = JSON.stringify(await store.read());
  assert(!state.includes('架空.png') && !state.includes('U_SYNTHETIC'));
});
test('Canvasの通信結果不明時は追記を自動再送しない', async t => {
  const { store } = await fixture(t);
  const client = fakeClient({ editError: new Error('timeout-with-private-data') });
  const args = { client, config, mode: 'weekly', now, store };
  await assert.rejects(runDigest(args), { code: 'SLACK_CONNECTION_ERROR' });
  await assert.rejects(runDigest(args), { code: 'NEEDS_REVIEW' });
  assert.equal(client.calls.filter(call => call.method === 'edit').length, 1);
});
test('翌週も同じCanvasへ追記し、前週の実行記録を残す', async t => {
  const { store } = await fixture(t);
  const client = fakeClient();
  client.conversations.history = async payload => ({ ok: true, messages: [{
    user: 'U_SYNTHETIC', ts: String(Number(payload.oldest) + 86400) + '.000000',
    text: '#制作物-イラスト', files: [{ name: '架空.png' }]
  }] });
  await runDigest({ client, config, mode: 'weekly', now, store });
  await runDigest({ client, config, mode: 'weekly', now: new Date(now.getTime() + 7 * 86400000), store });
  const edits = client.calls.filter(call => call.method === 'edit');
  assert.equal(edits.length, 2);
  assert(edits.every(call => call.payload.canvas_id === 'F12345' && call.payload.changes[0].operation === 'insert_at_end'));
  assert.equal((await store.read()).records.length, 2);
});
test('テストCanvas未指定の場合、本番Canvasへ代わりに書き込まない', async t => {
  const { store } = await fixture(t);
  const client = fakeClient();
  await assert.rejects(runDigest({ client, config: { ...config, testCanvasId: undefined }, mode: 'test', now, store }), { code: 'MISSING_CANVAS' });
  assert.equal(client.calls.length, 0);
});
test('Canvasモードでもプレビューは読み取りだけで状態保存しない', async () => {
  const client = fakeClient();
  const result = await runDigest({ client, config: { ...config, allowPost: false }, mode: 'preview', now,
    store: { withLock: () => assert.fail('preview must not write') } });
  assert.equal(result.count, 1);
  assert(!client.calls.some(call => ['edit', 'create'].includes(call.method)));
});
test('番号付きのCanvas追加テストも同じ番号では重複しない', async t => {
  const { store } = await fixture(t);
  const client = fakeClient();
  const args = { client, config, mode: 'test', now, store };
  await runDigest(args);
  await runDigest({ ...args, testRunId: '2' });
  assert.equal((await runDigest({ ...args, testRunId: '2' })).status, 'already_processed');
  assert.equal(client.calls.filter(call => call.method === 'edit').length, 2);
});
test('チャンネルCanvasを明示的に作成し、既存Canvasを変更しない', async () => {
  const client = fakeClient();
  assert.equal((await setupChannelCanvas(client, config)).canvasId, 'F12345');
  assert.equal(client.calls[0].payload.channel_id, 'C12345');
  const existing = fakeClient({ createError: { data: { error: 'channel_canvas_already_exists' } } });
  await assert.rejects(setupChannelCanvas(existing, config), { code: 'CANVAS_ALREADY_EXISTS' });
  assert.deepEqual(existing.calls.map(call => call.method), ['create']);
  await assert.rejects(setupChannelCanvas(client, { ...config, allowPost: false }), { code: 'POST_DISABLED' });
});
test('Canvas設定の不正なID・出力先を拒否し、既定はスレッドを維持する', () => {
  const env = { SLACK_BOT_TOKEN: 'xoxb-synthetic', SLACK_APP_TOKEN: 'xapp-synthetic', SLACK_SOURCE_CHANNEL_ID: 'C12345' };
  assert.equal(loadConfig(env).outputMode, 'thread');
  assert.equal(loadConfig({ ...env, OUTPUT_MODE: 'canvas', SLACK_CANVAS_ID: 'F12345' }).canvasId, 'F12345');
  assert.throws(() => loadConfig({ ...env, OUTPUT_MODE: 'other' }), { code: 'INVALID_CONFIG' });
  assert.throws(() => loadConfig({ ...env, SLACK_CANVAS_ID: 'https://example.com' }), { code: 'INVALID_CANVAS' });
});
