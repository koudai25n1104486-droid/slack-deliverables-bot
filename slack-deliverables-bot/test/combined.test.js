'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runDigest } = require('../src/digest');
const { StateStore } = require('../src/state');
const { loadConfig } = require('../src/config');
const now = new Date('2026-11-16T09:01:00+09:00');
const config = { sourceChannel: 'C12345', outputChannel: 'C12345', testChannel: 'C12345',
  canvasId: 'F12345', testCanvasId: 'F12345', outputMode: 'both', allowPost: true,
  autoPin: true, maxItems: 50, maxPages: 20, categories: ['イラスト', '動画'] };
function fakeClient(hooks = {}) {
  const calls = [];
  let posts = 0;
  let filename = '架空作品.png';
  const record = (method, payload) => calls.push({ method, payload });
  const client = { calls, rename(value) { filename = value; },
    conversations: { history: async payload => {
      record('history', payload);
      if (hooks.history) return hooks.history(payload);
      return { ok: true, messages: [{ user: 'U_SYNTHETIC',
        ts: String(Date.parse('2026-11-14T12:00:00+09:00') / 1000) + '.000000',
        text: '#制作物-イラスト', files: [{ name: filename }] }] };
    } },
    chat: {
      getPermalink: async payload => { record('permalink', payload); return { ok: true, permalink: 'https://school.slack.com/archives/C12345/p123' }; },
      postMessage: async payload => { record('post', payload); posts++;
        if (hooks.post) return hooks.post(payload, posts);
        return { ok: true, ts: `1234567890.${String(posts).padStart(6, '0')}` };
      }
    },
    canvases: { edit: async payload => { record('canvas', payload); if (hooks.canvas) return hooks.canvas(payload); return { ok: true }; } },
    pins: { add: async payload => { record('pin', payload); if (hooks.pin) return hooks.pin(payload); return { ok: true }; } }
  };
  return client;
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'combined-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { store: new StateStore(directory) };
}
function args(client, store, extra = {}) { return { client, store, config, now, mode: 'test', wait: async () => {}, ...extra }; }
const count = (client, method) => client.calls.filter(call => call.method === method).length;

test('投稿・スレッドを作成した後、同じ内容をCanvasに追記してピン留めする', async t => {
  const { store } = await fixture(t);
  const client = fakeClient();
  const result = await runDigest(args(client, store));
  assert.equal(result.output, 'both');
  assert.deepEqual(client.calls.map(call => call.method), ['history', 'permalink', 'post', 'post', 'canvas', 'pin']);
  const reply = client.calls.filter(call => call.method === 'post')[1].payload;
  const canvas = client.calls.find(call => call.method === 'canvas').payload;
  assert(reply.thread_ts);
  assert(reply.text.includes('架空作品.png'));
  assert(canvas.changes[0].document_content.markdown.includes('架空作品\\.png'));
  assert.equal(canvas.changes[0].operation, 'insert_at_end');
  assert.equal((await runDigest(args(client, store))).status, 'already_processed');
  assert.equal(count(client, 'post'), 2);
  assert.equal(count(client, 'canvas'), 1);
  const state = JSON.stringify(await store.read());
  assert(!state.includes('架空作品') && !state.includes('U_SYNTHETIC'));
  assert.match((await store.read()).records.find(record => record.outputMode === 'both').contentHash, /^[a-f0-9]{64}$/);
});
test('Canvasの権限エラー修正後は、元の期間でCanvasだけを再試行する', async t => {
  const { store } = await fixture(t);
  let edits = 0;
  const client = fakeClient({ canvas: async () => {
    if (++edits === 1) throw { data: { error: 'missing_scope' } };
    return { ok: true };
  } });
  await assert.rejects(runDigest(args(client, store)), { code: 'THREAD_POSTED_CANVAS_PENDING' });
  const result = await runDigest(args(client, store, { now: new Date(now.getTime() + 20 * 60000) }));
  assert.equal(result.status, 'done');
  assert.equal(count(client, 'post'), 2);
  assert.equal(count(client, 'canvas'), 2);
  assert.equal(count(client, 'pin'), 1);
  const histories = client.calls.filter(call => call.method === 'history');
  assert.equal(histories[0].payload.latest, histories[1].payload.latest);
  assert.equal(histories[0].payload.oldest, histories[1].payload.oldest);
});
test('Canvas追記の結果が不明な場合は投稿も追記も自動再送しない', async t => {
  const { store } = await fixture(t);
  const client = fakeClient({ canvas: async () => { throw new Error('timeout secret response'); } });
  await assert.rejects(runDigest(args(client, store)), { code: 'THREAD_POSTED_CANVAS_UNCERTAIN' });
  await assert.rejects(runDigest(args(client, store)), { code: 'NEEDS_REVIEW' });
  assert.equal(count(client, 'post'), 2);
  assert.equal(count(client, 'canvas'), 1);
  assert.equal(count(client, 'history'), 1);
});
test('Canvas待ちの間に元投稿が変更された場合、異なる内容を追記しない', async t => {
  const { store } = await fixture(t);
  const client = fakeClient({ canvas: async () => { throw { data: { error: 'missing_scope' } }; } });
  await assert.rejects(runDigest(args(client, store)), { code: 'THREAD_POSTED_CANVAS_PENDING' });
  client.rename('変更後.png');
  await assert.rejects(runDigest(args(client, store)), { code: 'CONTENT_CHANGED' });
  assert.equal(count(client, 'post'), 2);
  assert.equal(count(client, 'canvas'), 1);
});
test('ピン留めだけの失敗では投稿・Canvasを繰り返さずピンだけ再試行する', async t => {
  const { store } = await fixture(t);
  let pins = 0;
  const client = fakeClient({ pin: async () => {
    if (++pins === 1) throw { data: { error: 'missing_scope' } };
    return { ok: true };
  } });
  await assert.rejects(runDigest(args(client, store)), { code: 'SLACK_API_ERROR' });
  assert.equal((await runDigest(args(client, store))).status, 'done');
  assert.equal(count(client, 'post'), 2);
  assert.equal(count(client, 'canvas'), 1);
  assert.equal(count(client, 'history'), 1);
  assert.equal(pins, 2);
});
test('チャンネル投稿が途中で失敗した場合、Canvasに進まず再投稿も止める', async t => {
  const { store } = await fixture(t);
  const client = fakeClient({ post: async (payload, number) => {
    if (number === 2) throw new Error('unknown result');
    return { ok: true, ts: '1234567890.000001' };
  } });
  await assert.rejects(runDigest(args(client, store)), { code: 'SLACK_CONNECTION_ERROR' });
  await assert.rejects(runDigest(args(client, store)), { code: 'NEEDS_REVIEW' });
  assert.equal(count(client, 'post'), 2);
  assert.equal(count(client, 'canvas'), 0);
});
test('既に同じ期間をCanvasだけで追記済みの場合はチャンネルだけ投稿する', async t => {
  const { store } = await fixture(t);
  const client = fakeClient();
  await runDigest(args(client, store, { config: { ...config, outputMode: 'canvas' } }));
  assert.equal((await runDigest(args(client, store))).canvasReused, true);
  assert.equal(count(client, 'canvas'), 1);
  assert.equal(count(client, 'post'), 2);
});
test('既にスレッド投稿済みの期間・番号へ切り替えても再投稿しない', async t => {
  const { store } = await fixture(t);
  const client = fakeClient();
  await runDigest(args(client, store, { config: { ...config, outputMode: 'thread' } }));
  assert.equal((await runDigest(args(client, store))).status, 'already_processed');
  assert.equal(count(client, 'post'), 2);
  assert.equal(count(client, 'canvas'), 0);
});
test('0件・テストCanvas未設定・投稿無効では書き込みを行わない', async t => {
  const { store } = await fixture(t);
  const client = fakeClient({ history: async () => ({ ok: true, messages: [] }) });
  assert.equal((await runDigest(args(client, store))).status, 'empty');
  assert.equal((await runDigest(args(client, store))).status, 'already_processed');
  assert.equal(count(client, 'post'), 0);
  assert.equal(count(client, 'canvas'), 0);
  await assert.rejects(runDigest(args(client, store, { config: { ...config, testCanvasId: undefined } })), { code: 'MISSING_CANVAS' });
  await assert.rejects(runDigest(args(client, store, { config: { ...config, allowPost: false } })), { code: 'POST_DISABLED' });
});
test('番号を変えた追加テストも両方に1回ずつだけ反映する', async t => {
  const { store } = await fixture(t);
  const client = fakeClient();
  await runDigest(args(client, store));
  await runDigest(args(client, store, { testRunId: '2' }));
  assert.equal((await runDigest(args(client, store, { testRunId: '2' }))).status, 'already_processed');
  assert.equal(count(client, 'post'), 4);
  assert.equal(count(client, 'canvas'), 2);
});
test('両方への出力を設定で選択でき、プレビューでは書き込まない', async () => {
  const env = { SLACK_BOT_TOKEN: 'xoxb-synthetic', SLACK_APP_TOKEN: 'xapp-synthetic', SLACK_SOURCE_CHANNEL_ID: 'C12345', OUTPUT_MODE: 'both' };
  assert.equal(loadConfig(env).outputMode, 'both');
  const client = fakeClient();
  const result = await runDigest(args(client, { withLock: () => assert.fail('must not write') }, { mode: 'preview' }));
  assert.equal(result.count, 1);
  assert.equal(count(client, 'post'), 0);
  assert.equal(count(client, 'canvas'), 0);
});
