'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_SCHEDULE, parseCommand, describeSchedule, nextOccurrence, scheduledTime,
  scheduleIsDue, ScheduleStore, registerScheduleCommands } = require('../src/schedule');
const { makeRange } = require('../src/digest');
const { loadConfig } = require('../src/config');
const now = new Date('2026-11-14T12:00:00+09:00');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, store: new ScheduleStore(directory) };
}
test('メンションと日本語・全角数字の曜日時刻を解析する', () => {
  for (const text of ['<@UBOT> 毎週 金曜 18:00', '毎週金曜日18時', '毎週 金曜日 １８：００', '毎週金曜18時00分に投稿してください']) {
    assert.deepEqual(parseCommand(text), { kind: 'update', patch: { weekday: 5, hour: 18, minute: 0 } });
  }
  assert.deepEqual(parseCommand('投稿曜日 日曜'), { kind: 'update', patch: { weekday: 0 } });
  assert.deepEqual(parseCommand('投稿時刻 7:30'), { kind: 'update', patch: { hour: 7, minute: 30 } });
});
test('不正な時刻や任意の命令を設定変更として解釈しない', () => {
  for (const text of ['毎週金曜24:00', '投稿時刻 18:60', '毎週金曜99時']) assert.equal(parseCommand(text).kind, 'invalid_time');
  for (const text of ['毎週金曜18:00;任意の処理', '今すぐ投稿', '投稿曜日 abc', '毎月 月曜 18:00']) assert.equal(parseCommand(text).kind, 'help');
  assert.equal(parseCommand('設定確認').kind, 'status');
});
test('日本時間で次回の予定を計算し、既に過ぎた予定は翌週にする', () => {
  const schedule = { ...DEFAULT_SCHEDULE, weekday: 5, hour: 18 };
  assert.equal(nextOccurrence(schedule, now).toISOString(), '2026-11-20T09:00:00.000Z');
  assert.equal(nextOccurrence(schedule, new Date('2026-11-20T18:00:00+09:00')).toISOString(), '2026-11-27T09:00:00.000Z');
  assert.equal(describeSchedule(schedule), '毎週金曜 18:00（日本時間）');
});
test('投稿曜日だけを変更し、前週月曜〜日曜の集計期間は維持する', () => {
  const date = new Date('2026-11-20T18:00:00+09:00');
  const range = makeRange(date, true);
  const schedule = { ...DEFAULT_SCHEDULE, weekday: 5, hour: 18 };
  assert.equal(scheduledTime(range, schedule).toISOString(), '2026-11-20T09:00:00.000Z');
  assert.equal(range.start.toISOString(), '2026-11-08T15:00:00.000Z');
  assert.equal(range.end.toISOString(), '2026-11-15T15:00:00.000Z');
  assert(scheduleIsDue(date, range, schedule));
  assert(!scheduleIsDue(new Date(date.getTime() - 1), range, schedule));
});
test('変更直後に過去の曜日へ遡って投稿せず、次の予定まで待つ', () => {
  const schedule = { ...DEFAULT_SCHEDULE, weekday: 5, hour: 18, effectiveFrom: '2026-11-20T09:00:00.000Z' };
  assert(!scheduleIsDue(now, makeRange(now, true), schedule));
  const next = new Date('2026-11-20T18:01:00+09:00');
  assert(scheduleIsDue(next, makeRange(next, true), schedule));
});
test('設定は再起動後も保持し、曜日だけ・時刻だけの変更に対応する', async t => {
  const { directory, store } = await fixture(t);
  assert.deepEqual(await store.read(), DEFAULT_SCHEDULE);
  await store.execute(parseCommand('毎週金曜18:00'), 'EvONE', now);
  await new ScheduleStore(directory).execute(parseCommand('投稿曜日 土曜'), 'EvTWO', now);
  assert.equal((await store.read()).weekday, 6);
  assert.equal((await store.read()).hour, 18);
  await store.execute(parseCommand('投稿時刻 8:30'), 'EvTHREE', now);
  const saved = await new ScheduleStore(directory).read();
  assert.equal(saved.weekday, 6);
  assert.equal(saved.hour, 8);
  assert.equal(saved.minute, 30);
});
test('Slackイベントの再配信は再起動後も二重に設定しない', async t => {
  const { directory, store } = await fixture(t);
  await store.execute(parseCommand('毎週金曜18:00'), 'EvDUPLICATE', now);
  const before = await store.read();
  const replay = await new ScheduleStore(directory).execute(parseCommand('毎週日曜12:00'), 'EvDUPLICATE', new Date(now.getTime() + 1000));
  assert(replay.duplicate);
  assert.deepEqual(await store.read(), before);
});
test('同じ曜日時刻を再指定しても次回適用時刻を先延ばししない', async t => {
  const { store } = await fixture(t);
  await store.execute(parseCommand('毎週金曜18:00'), 'EvFIRST', now);
  const original = await store.read();
  const result = await store.execute(parseCommand('毎週金曜18:00'), 'EvSAME', new Date('2026-11-21T12:00:00+09:00'));
  assert.equal(result.changed, false);
  assert.deepEqual(await store.read(), original);
});
test('保存した設定が壊れている場合は既定値に黙って戻さない', async t => {
  const { directory, store } = await fixture(t);
  await fs.writeFile(path.join(directory, 'schedule.json'), JSON.stringify({ version: 1, records: [{ kind: 'schedule', value: { ...DEFAULT_SCHEDULE, hour: 25 } }] }));
  await assert.rejects(store.read(), { code: 'INVALID_SCHEDULE' });
});
function handler(store, overrides = {}) {
  let callback;
  let changes = 0;
  const errors = [];
  const config = { sourceChannel: 'C12345', allowPost: true, weeklyEnabled: false, ...overrides };
  registerScheduleCommands({ event(name, listener) { assert.equal(name, 'app_mention'); callback = listener; } }, config,
    { store, now: () => now, onChange: () => changes++, report: error => errors.push(error) });
  return { callback, errors, changes: () => changes };
}
function event(overrides = {}) {
  return { channel: 'C12345', user: 'UADMIN', ts: String(now.getTime() / 1000) + '.000000',
    text: '<@UBOT> 毎週 金曜 18:00', ...overrides };
}
function client() {
  const replies = [];
  return { replies, chat: { postMessage: async payload => { replies.push(payload); return { ok: true, ts: '1.000001' }; } } };
}
test('チャンネル参加者のメンションで設定し、指示のスレッドへ返答する', async t => {
  const { directory, store } = await fixture(t);
  const h = handler(store);
  const c = client();
  await h.callback({ event: event(), body: { event_id: 'EvADMIN' }, client: c });
  assert.equal((await store.read()).weekday, 5);
  assert.equal(c.replies.length, 1);
  assert(c.replies[0].text.includes('毎週金曜 18:00'));
  assert(c.replies[0].text.includes('週次実行は無効'));
  assert.equal(c.replies[0].thread_ts, event().ts);
  assert.equal(h.changes(), 1);
  const stored = await fs.readFile(path.join(directory, 'schedule.json'), 'utf8');
  assert(!stored.includes('UADMIN'));
  assert(!stored.includes('毎週 金曜'));
});
test('他チャンネル・ボット・古い指示・利用者不明のイベントは扱わない', async t => {
  const { directory, store } = await fixture(t);
  const h = handler(store);
  const c = client();
  for (const e of [event({ user: undefined }), event({ channel: 'COTHER' }), event({ bot_id: 'B12345' }), event({ subtype: 'bot_message' }),
    event({ ts: String(now.getTime() / 1000 - 601) + '.000000' })]) {
    await h.callback({ event: e, body: { event_id: 'EvREJECT' }, client: c });
  }
  assert.equal(c.replies.length, 0);
  await assert.rejects(fs.stat(path.join(directory, 'schedule.json')), { code: 'ENOENT' });
});
test('同じイベントへの二重応答を抑止し、設定確認やヘルプは時刻を変えない', async t => {
  const { store } = await fixture(t);
  const h = handler(store);
  const c = client();
  const request = { event: event(), body: { event_id: 'EvONCE' }, client: c };
  await h.callback(request);
  await h.callback(request);
  assert.equal(c.replies.length, 1);
  for (const [text, eventId] of [['設定確認', 'EvSTATUS'], ['ヘルプ', 'EvHELP'], ['投稿時刻 25:00', 'EvINVALID']]) {
    await h.callback({ event: event({ text: '<@UBOT> ' + text }), body: { event_id: eventId }, client: c });
  }
  assert.equal((await store.read()).hour, 18);
  assert.equal(h.changes(), 1);
  assert(c.replies.at(-1).text.includes('設定は変更していません'));
});
test('投稿許可が無効ならメンション操作も書き込みしない', async t => {
  const { directory, store } = await fixture(t);
  const h = handler(store, { allowPost: false });
  const c = client();
  await h.callback({ event: event(), body: { event_id: 'EvDISABLED' }, client: c });
  assert.equal(c.replies.length, 0);
  await assert.rejects(fs.stat(path.join(directory, 'schedule.json')), { code: 'ENOENT' });
});
test('メンション操作は個人IDの事前登録なしで有効化できる', () => {
  const env = { SLACK_BOT_TOKEN: 'xoxb-synthetic', SLACK_APP_TOKEN: 'xapp-synthetic', SLACK_SOURCE_CHANNEL_ID: 'C12345' };
  assert.equal(loadConfig(env).mentionCommandsEnabled, false);
  assert.equal(loadConfig({ ...env, ENABLE_MENTION_COMMANDS: 'true' }).mentionCommandsEnabled, true);
  const config = loadConfig({ ...env, ENABLE_MENTION_COMMANDS: 'true', SLACK_ADMIN_USER_IDS: 'U12345,W12345,U12345' });
  assert.equal(config.mentionCommandsEnabled, true);
  assert.equal(config.adminUserIds, undefined);
});
test('個人IDを登録していない別の参加者も予定を変更できる', async t => {
  const { store } = await fixture(t);
  const h = handler(store);
  const c = client();
  await h.callback({ event: event({ user: 'UOTHER', text: '<@UBOT> 毎週水曜20:30' }), body: { event_id: 'EvNEWPERSON' }, client: c });
  assert.equal((await store.read()).weekday, 3);
  assert.equal((await store.read()).hour, 20);
  assert.equal((await store.read()).minute, 30);
  assert.equal(c.replies.length, 1);
});
