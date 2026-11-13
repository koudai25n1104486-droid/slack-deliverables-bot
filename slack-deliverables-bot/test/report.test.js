'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { currentWeekRange, OnDemandReporter } = require('../src/report');
const { ScheduleStore, parseCommand, registerScheduleCommands, DEFAULT_SCHEDULE } = require('../src/schedule');
const now = new Date('2026-11-18T15:00:00+09:00');
const config = { sourceChannel: 'C12345', allowPost: true, weeklyEnabled: false, maxItems: 50, maxPages: 20,
  categories: ['イラスト', '動画'] };
const command = { channel: 'C12345', user: 'UANYONE', ts: String(now.getTime() / 1000) + '.000000', text: '<@UBOT> 今週の制作物' };
function message(date, extra = {}) {
  return { user: 'UCREATOR', ts: String(Date.parse(date) / 1000) + '.000000', text: '#制作物-イラスト', files: [{ name: '架空作品.png' }], ...extra };
}
function client(messages = [message('2026-11-17T12:00:00+09:00')], hooks = {}) {
  const calls = [];
  let posts = 0;
  return { calls,
    conversations: { history: async payload => {
      calls.push({ method: 'history', payload });
      if (hooks.history) return hooks.history(payload);
      return { ok: true, messages };
    } },
    chat: {
      getPermalink: async payload => { calls.push({ method: 'permalink', payload }); return { ok: true, permalink: 'https://school.slack.com/archives/C12345/p123' }; },
      postMessage: async payload => {
        calls.push({ method: 'post', payload });
        if (hooks.post) return hooks.post(payload, ++posts);
        return { ok: true, ts: '1234567890.000001' };
      }
    },
    canvases: { edit: async () => assert.fail('on-demand report must not edit Canvas') },
    pins: { add: async () => assert.fail('on-demand report must not pin messages') }
  };
}
function reporter(c, overrides = {}) {
  return new OnDemandReporter({ client: c, config, wait: async () => {}, clock: () => 100000,
    reportError: () => {}, ...overrides });
}
const count = (c, method) => c.calls.filter(call => call.method === method).length;

test('随時集計は日本時間の今週月曜0時から現在までを対象にする', () => {
  const range = currentWeekRange(now);
  assert.equal(range.start.toISOString(), '2026-11-15T15:00:00.000Z');
  assert.equal(range.end.toISOString(), '2026-11-18T06:00:00.000Z');
  const monday = new Date('2026-11-16T00:00:00+09:00');
  assert.equal(currentWeekRange(monday).start.getTime(), monday.getTime());
});
test('今週のタグ付き投稿を分類して表示し、前週・雑談・返信を除外する', async () => {
  const c = client([
    message('2026-11-17T12:00:00+09:00'),
    message('2026-11-17T13:00:00+09:00', { text: '#制作物-動画', files: [{ name: '映像.mp4' }] }),
    message('2026-11-15T12:00:00+09:00'),
    message('2026-11-17T14:00:00+09:00', { text: '雑談' }),
    message('2026-11-17T15:00:00+09:00', { thread_ts: '123.000001' })
  ]);
  const result = await reporter(c).run(command, now);
  assert.equal(result.count, 2);
  const posts = c.calls.filter(call => call.method === 'post').map(call => call.payload);
  assert.equal(posts.length, 3);
  assert(posts[0].text.includes('今週の制作物（随時集計）'));
  assert(posts[1].text.includes('*イラスト*') && posts[1].text.includes('架空作品.png'));
  assert(posts[2].text.includes('*動画*') && posts[2].text.includes('映像.mp4'));
  assert(posts.every(post => post.channel === 'C12345' && post.thread_ts === command.ts && post.unfurl_media === false));
});
test('既存のスレッドで指示した場合はそのスレッドに表示する', async () => {
  const c = client();
  await reporter(c).run({ ...command, thread_ts: '1234567890.000100' }, now);
  assert(c.calls.filter(call => call.method === 'post').every(call => call.payload.thread_ts === '1234567890.000100'));
});
test('制作物が0件でも空であることを返答する', async () => {
  const c = client([]);
  assert.equal((await reporter(c).run(command, now)).count, 0);
  assert.equal(count(c, 'post'), 1);
  assert(c.calls.at(-1).payload.text.includes('まだありません'));
});
test('30秒以内の連続要求では履歴を再取得しない', async () => {
  const c = client();
  let clock = 100000;
  const r = reporter(c, { clock: () => clock });
  await r.run(command, now);
  clock++;
  assert.equal((await r.run(command, now)).status, 'cooldown');
  assert.equal(count(c, 'history'), 1);
  clock += 30000;
  assert.equal((await r.run(command, now)).status, 'done');
  assert.equal(count(c, 'history'), 2);
});
test('集計中に重なる要求では新しい集計を開始しない', async () => {
  let release;
  let collections = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const c = client();
  const r = reporter(c, { collect: async () => { collections++; await pending; return { matched: 0, items: [] }; } });
  const first = r.run(command, now);
  const second = await r.run(command, now);
  release();
  await first;
  assert.equal(second.status, 'cooldown');
  assert.equal(collections, 1);
});
test('履歴取得に失敗した場合は機密を含まないエラー案内を返す', async () => {
  const c = client([], { history: async () => { throw new Error('private-response-token'); } });
  assert.equal((await reporter(c).run(command, now)).status, 'failed');
  assert.equal(count(c, 'post'), 1);
  assert(c.calls.at(-1).payload.text.includes('随時集計に失敗'));
  assert(!c.calls.at(-1).payload.text.includes('private-response-token'));
});
test('一覧表示の途中で失敗したら内容を再送せず、部分表示の案内を返す', async () => {
  const c = client(undefined, { post: async (payload, number) => {
    if (number === 2) throw new Error('unknown delivery');
    return { ok: true, ts: '1234567890.000001' };
  } });
  assert.equal((await reporter(c).run(command, now)).status, 'failed');
  assert.equal(count(c, 'history'), 1);
  assert.equal(count(c, 'post'), 3);
  assert(c.calls.at(-1).payload.text.includes('一部のみ表示'));
});
test('他チャンネル・ボット・不正な投稿識別子・投稿無効を拒否する', async () => {
  const c = client();
  const r = reporter(c);
  for (const event of [{ ...command, channel: 'COTHER' }, { ...command, bot_id: 'B12345' },
    { ...command, user: undefined }, { ...command, ts: 'invalid' }, { ...command, thread_ts: 'invalid' }]) {
    await assert.rejects(r.run(event, now), { code: 'INVALID_REPORT_CONTEXT' });
  }
  await assert.rejects(reporter(c, { config: { ...config, allowPost: false } }).run(command, now), { code: 'POST_DISABLED' });
  assert.equal(c.calls.length, 0);
});
test('メンション経由で随時集計を呼び、予定・週次記録・Canvasは変更しない', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'report-route-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ledger = '{"version":1,"records":[]}\n';
  await fs.writeFile(path.join(directory, 'ledger.json'), ledger);
  const store = new ScheduleStore(directory);
  const c = client();
  const r = reporter(c, { config: { ...config, stateDir: directory } });
  let callback;
  registerScheduleCommands({ event(name, listener) { callback = listener; } }, config, { store, now: () => now,
    onChange: () => assert.fail('report must not change schedule'),
    onReport: ({ event, now: received }) => r.run(event, received), report: error => assert.fail(error.message) });
  const request = { event: command, body: { event_id: 'EvREPORT' }, client: c };
  await callback(request);
  await callback(request);
  assert.equal(count(c, 'history'), 1);
  assert.equal(count(c, 'post'), 2);
  assert.equal(await fs.readFile(path.join(directory, 'ledger.json'), 'utf8'), ledger);
  assert.deepEqual(await store.read(), DEFAULT_SCHEDULE);
  const saved = await fs.readFile(path.join(directory, 'schedule.json'), 'utf8');
  assert(!saved.includes('架空作品') && !saved.includes('UANYONE'));
});
test('随時集計の指示と予定変更の指示を区別する', () => {
  for (const text of ['今週の制作物', '<@UBOT> 最新の制作物', '今すぐ集計', '報告', '報告を見せて', 'レポート']) {
    assert.equal(parseCommand(text).kind, 'report');
  }
  assert.equal(parseCommand('今すぐ投稿').kind, 'help');
  assert.equal(parseCommand('毎週金曜18:00').kind, 'update');
});
