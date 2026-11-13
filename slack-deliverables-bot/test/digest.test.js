'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { makeRange, labelText, safePermalink, collectDigest, runDigest } = require('../src/digest');
const { StateStore } = require('../src/state');
const { loadConfig } = require('../src/config');
const { BotError, safeError } = require('../src/errors');
const now = new Date('2026-11-16T09:01:00+09:00');
const sourceTime = Date.parse('2026-11-14T12:00:00+09:00') / 1000;
const baseConfig = { sourceChannel: 'C_SOURCE', testChannel: 'C_TEST', outputChannel: 'C_OUTPUT',
  allowPost: true, autoPin: true, maxItems: 50, maxPages: 20 };
function message(offset = 0, extra = {}) {
  return { ts: String(sourceTime + offset), user: 'U_SYNTHETIC', text: '#制作物\n架空データ',
    files: [{ name: '架空作品.png' }], ...extra };
}
function fakeClient(messages = [message()], hooks = {}) {
  const calls = [];
  let n = 0;
  const client = { calls };
  for (const method of ['conversations.history', 'chat.getPermalink', 'chat.postMessage', 'pins.add']) {
    const [group, name] = method.split('.');
    client[group] ||= {};
    client[group][name] = async payload => {
      calls.push({ method, payload });
      if (hooks[method]) return hooks[method](payload);
      if (method === 'conversations.history') return { ok: true, messages };
      if (method === 'chat.getPermalink') return { ok: true, permalink: 'https://school.slack.com/archives/C1/p123' };
      if (method === 'chat.postMessage') return { ok: true, ts: `1234567890.${String(++n).padStart(6, '0')}` };
      return { ok: true };
    };
  }
  return client;
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'weekly-bot-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, store: new StateStore(path.join(directory, 'state')) };
}

test('週の境界は日本時間の月曜0時、実行可能時刻は月曜9時', () => {
  const range = makeRange(now, true);
  assert.equal(range.start.toISOString(), '2026-11-08T15:00:00.000Z');
  assert.equal(range.end.toISOString(), '2026-11-15T15:00:00.000Z');
  assert.equal(range.readyAt.toISOString(), '2026-11-16T00:00:00.000Z');
  assert.equal(makeRange(new Date('2027-01-04T09:00:00+09:00'), true).key, '2026-12-28');
});
test('テスト用の直近7日間には当日の投稿も含まれる', () => {
  const range = makeRange(new Date('2026-11-14T12:30:00+09:00'), false);
  assert.equal(range.start.toISOString(), '2026-11-07T03:30:00.000Z');
  assert.equal(range.end.toISOString(), '2026-11-14T03:30:00.000Z');
});
test('期間開始を含み、終端・雑談・ボット・返信・似た目印を除外する', async () => {
  const range = makeRange(now, true);
  const client = fakeClient([
    message(0, { ts: String(range.start.getTime() / 1000) }),
    message(1, { files: [] }), message(2, { text: '雑談' }),
    message(3, { text: '#制作物です' }), message(4, { bot_id: 'B_SYNTHETIC' }),
    message(5, { thread_ts: '123.1' }), message(6, { subtype: 'channel_join' }),
    message(7, { ts: String(range.end.getTime() / 1000) })
  ]);
  const result = await collectDigest(client, baseConfig, range);
  assert.equal(result.matched, 2);
  assert.equal(result.items[0].label, '架空作品.png');
  assert.equal(result.items[1].label, '制作物（11/14）');
  assert(client.calls.every(c => ['conversations.history', 'chat.getPermalink'].includes(c.method)));
});
test('添付付き投稿、複数ファイル、次ページ、重複投稿を処理する', async () => {
  let page = 0;
  const first = message(0, { subtype: 'file_share', files: [{ name: 'a.png' }, { name: 'b.jpeg' }] });
  const client = fakeClient([], { 'conversations.history': async () => ++page === 1
    ? { ok: true, messages: [first], response_metadata: { next_cursor: 'next' } }
    : { ok: true, messages: [first, message(1)] } });
  const result = await collectDigest(client, baseConfig, makeRange(now, true));
  assert.equal(result.matched, 2);
  assert.equal(result.items.length, 3);
});
test('取得上限・不完全なページでは投稿しない', async () => {
  const tooMany = fakeClient([message(), message(1)]);
  await assert.rejects(collectDigest(tooMany, { ...baseConfig, maxItems: 1 }, makeRange(now, true)), { code: 'TOO_MANY_ITEMS' });
  const incomplete = fakeClient([], { 'conversations.history': async () => ({ ok: true, messages: [], has_more: true }) });
  await assert.rejects(collectDigest(incomplete, baseConfig, makeRange(now, true)), { code: 'INCOMPLETE_HISTORY' });
  const pages = fakeClient([], { 'conversations.history': async () => ({ ok: true, messages: [], response_metadata: { next_cursor: 'same' } }) });
  await assert.rejects(collectDigest(pages, baseConfig, makeRange(now, true)), { code: 'INVALID_CURSOR' });
});
test('ファイル名のメンション・リンク埋め込みを無害化する', () => {
  const value = labelText('<!channel>|*作品*\n.png');
  assert(!value.includes('<'));
  assert(!value.includes('|'));
  assert(!value.includes('*'));
  assert(!value.includes('\n'));
  assert(value.includes('&lt;!channel&gt;'));
  for (const url of ['https://slack.com.example.org/x', 'http://school.slack.com/x', 'https://user@school.slack.com/x', 'https://school.slack.com:444/x']) {
    assert.throws(() => safePermalink(url), BotError);
  }
});
test('プレビューは投稿・ローカル状態保存を行わない', async () => {
  const client = fakeClient();
  const store = { withLock() { throw new Error('must not write'); } };
  const result = await runDigest({ client, config: baseConfig, mode: 'preview', now, store });
  assert.equal(result.count, 1);
  assert.deepEqual(result.categories, [{ name: '制作物', count: 1 }]);
  assert(!JSON.stringify(result).includes('架空作品'));
  assert(!client.calls.some(c => c.method === 'chat.postMessage'));
});
test('投稿の許可がない場合はSlackにもアクセスしない', async () => {
  const client = fakeClient();
  await assert.rejects(runDigest({ client, config: { ...baseConfig, allowPost: false }, mode: 'test', now }), { code: 'POST_DISABLED' });
  assert.equal(client.calls.length, 0);
});
test('親・返信・ピンを作成し、再実行しても重複しない', async t => {
  const { store } = await fixture(t);
  const client = fakeClient();
  const args = { client, config: baseConfig, mode: 'weekly', now, store, wait: async () => {} };
  assert.equal((await runDigest(args)).status, 'done');
  const posts = client.calls.filter(c => c.method === 'chat.postMessage');
  assert.equal(posts.length, 2);
  assert(posts[1].payload.thread_ts);
  assert.equal(posts[1].payload.unfurl_media, false);
  assert.equal(posts[1].payload.unfurl_links, false);
  assert.equal((await runDigest(args)).status, 'already_processed');
  assert.equal(client.calls.filter(c => c.method === 'chat.postMessage').length, 2);
  const serialized = JSON.stringify(await store.read());
  assert(!serialized.includes('架空作品'));
  assert(!serialized.includes('U_SYNTHETIC'));
  assert(!serialized.includes('xoxb'));
});
test('0件は投稿せず、週次ループで再取得し続けない', async t => {
  const { store } = await fixture(t);
  const client = fakeClient([]);
  const args = { client, config: baseConfig, mode: 'weekly', now, store };
  assert.equal((await runDigest(args)).status, 'empty');
  assert.equal((await runDigest(args)).status, 'already_processed');
  assert.equal(client.calls.length, 1);
});
test('番号付きの追加テストは既存記録を消さずに投稿し、同じ番号の再送を防ぐ', async t => {
  const { store } = await fixture(t);
  const client = fakeClient();
  const args = { client, config: baseConfig, mode: 'test', now, store, wait: async () => {} };
  await runDigest(args);
  await runDigest({ ...args, testRunId: '2' });
  assert.equal(client.calls.filter(c => c.method === 'chat.postMessage').length, 4);
  assert(client.calls.find(c => c.method === 'chat.postMessage' && c.payload.text.includes('【試作品 #2】')));
  assert.equal((await runDigest({ ...args, testRunId: '2' })).status, 'already_processed');
  assert.equal((await store.read()).records.length, 2);
});
test('週次実行や不正な番号では追加テストを許可しない', async () => {
  const client = fakeClient();
  for (const [mode, testRunId] of [['weekly', '2'], ['test', '0'], ['test', 'personal-name'], ['test', '10000']]) {
    await assert.rejects(runDigest({ client, config: baseConfig, mode, testRunId, now }), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(client.calls.length, 0);
});
test('親投稿の通信結果が不明な場合、自動再送しない', async t => {
  const { store } = await fixture(t);
  const client = fakeClient([message()], { 'chat.postMessage': async () => { throw new Error('secret-token response-body'); } });
  const args = { client, config: baseConfig, mode: 'test', now, store, wait: async () => {} };
  await assert.rejects(runDigest(args), { code: 'SLACK_CONNECTION_ERROR' });
  await assert.rejects(runDigest(args), { code: 'NEEDS_REVIEW' });
  assert.equal(client.calls.filter(c => c.method === 'chat.postMessage').length, 1);
});
test('スレッドの途中失敗でも最初から再投稿しない', async t => {
  const { store } = await fixture(t);
  let posts = 0;
  const files = Array.from({ length: 20 }, (_, i) => ({ name: 'a'.repeat(180) + i + '.png' }));
  const client = fakeClient([message(0, { files })], { 'chat.postMessage': async () => {
    if (++posts === 3) throw new Error('timeout');
    return { ok: true, ts: '1234567890.000001' };
  } });
  const args = { client, config: baseConfig, mode: 'weekly', now, store, wait: async () => {} };
  await assert.rejects(runDigest(args), { code: 'SLACK_CONNECTION_ERROR' });
  await assert.rejects(runDigest(args), { code: 'NEEDS_REVIEW' });
  assert.equal(posts, 3);
  assert.equal((await store.read()).records[0].sentReplies, 1);
});
test('ピン留め失敗の再実行はピン留めだけを再試行する', async t => {
  const { store } = await fixture(t);
  let pins = 0;
  const client = fakeClient([message()], { 'pins.add': async () => {
    if (++pins === 1) throw { data: { error: 'missing_scope' } };
    return { ok: true };
  } });
  const args = { client, config: baseConfig, mode: 'test', now, store, wait: async () => {} };
  await assert.rejects(runDigest(args), { code: 'SLACK_API_ERROR' });
  const count = client.calls.length;
  assert.equal((await runDigest(args)).pinOnly, true);
  assert.equal(client.calls.length, count + 1);
  assert.equal(client.calls.at(-1).method, 'pins.add');
});
test('別プロセス用のロックと破損した状態ファイルで安全に停止する', async t => {
  const { store } = await fixture(t);
  await store.withLock(async () => {
    await assert.rejects(new StateStore(store.directory).withLock(async () => {}), { code: 'LOCKED' });
    await fs.writeFile(path.join(store.directory, 'ledger.json'), '{broken');
    await assert.rejects(store.read(), { code: 'INVALID_STATE' });
  });
  await assert.rejects(fs.stat(path.join(store.directory, 'run.lock')), { code: 'ENOENT' });
});
test('初期設定は投稿・自動実行が無効で、不正な設定を拒否する', () => {
  const env = { SLACK_BOT_TOKEN: 'xoxb-fixture', SLACK_APP_TOKEN: 'xapp-fixture', SLACK_SOURCE_CHANNEL_ID: 'C12345' };
  assert.equal(loadConfig(env).allowPost, false);
  assert.equal(loadConfig(env).weeklyEnabled, false);
  assert.throws(() => loadConfig({ ...env, ALLOW_SLACK_POST: 'TRUE' }), { code: 'INVALID_CONFIG' });
  assert.throws(() => loadConfig({ ...env, SLACK_TEST_CHANNEL_ID: 'channel-name' }), { code: 'INVALID_CHANNEL' });
  assert(!safeError(new Error('xoxb-secret-token')).includes('secret'));
});
