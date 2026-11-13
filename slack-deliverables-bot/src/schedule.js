'use strict';
const { StateStore } = require('./state');
const { BotError, callSlack, safeError } = require('./errors');
const DAY = 86400000;
const JST = 9 * 3600000;
const DAYS = '日月火水木金土';
const DEFAULT_SCHEDULE = Object.freeze({ weekday: 1, hour: 9, minute: 0, effectiveFrom: null });
const HELP = '使い方（日本時間）\n・毎週 金曜 18:00\n・投稿曜日 金曜\n・投稿時刻 18:00\n・設定確認\n変更は次の予定から適用します。同じ週を投稿済みなら再投稿しません。集計は前週の月曜〜日曜です。';

function validateSchedule(value) {
  if (!value || !Number.isInteger(value.weekday) || value.weekday < 0 || value.weekday > 6 ||
    !Number.isInteger(value.hour) || value.hour < 0 || value.hour > 23 ||
    !Number.isInteger(value.minute) || value.minute < 0 || value.minute > 59 ||
    !(value.effectiveFrom === null || (typeof value.effectiveFrom === 'string' && Number.isFinite(Date.parse(value.effectiveFrom))))) {
    throw new BotError('INVALID_SCHEDULE', '保存済みの曜日・時刻を確認できません。自動実行せず停止します。');
  }
  return { weekday: value.weekday, hour: value.hour, minute: value.minute, effectiveFrom: value.effectiveFrom };
}
function describeSchedule(value) {
  const schedule = validateSchedule(value);
  return `毎週${DAYS[schedule.weekday]}曜 ${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}（日本時間）`;
}
function parseCommand(text) {
  const cleaned = String(text || '').normalize('NFKC').replace(/<@[A-Z0-9]+>/g, ' ').trim();
  if (/^(設定確認|スケジュール確認|設定)$/.test(cleaned)) return { kind: 'status' };
  if (/^(ヘルプ|help)$/i.test(cleaned)) return { kind: 'help' };
  const time = '(\\d{1,2})(?::(\\d{2})|時(?:(\\d{1,2})分)?)';
  const weekly = new RegExp('^毎週\\s*([日月火水木金土])(?:曜日|曜)?\\s*' + time + '(?:に投稿(?:して|してください)?)?$').exec(cleaned);
  const day = /^投稿曜日\s*([日月火水木金土])(?:曜日|曜)?$/.exec(cleaned);
  const clock = new RegExp('^投稿時刻\\s*' + time + '$').exec(cleaned);
  let patch;
  if (weekly) patch = { weekday: DAYS.indexOf(weekly[1]), hour: Number(weekly[2]), minute: Number(weekly[3] ?? weekly[4] ?? 0) };
  else if (day) patch = { weekday: DAYS.indexOf(day[1]) };
  else if (clock) patch = { hour: Number(clock[1]), minute: Number(clock[2] ?? clock[3] ?? 0) };
  else return { kind: 'help' };
  if ((patch.hour !== undefined && (patch.hour < 0 || patch.hour > 23)) ||
    (patch.minute !== undefined && (patch.minute < 0 || patch.minute > 59))) return { kind: 'invalid_time' };
  return { kind: 'update', patch };
}

function nextOccurrence(schedule, now) {
  const date = new Date(now.getTime() + JST).toISOString().slice(0, 10);
  const midnight = new Date(date + 'T00:00:00+09:00');
  const currentDay = new Date(midnight.getTime() + JST).getUTCDay();
  let next = midnight.getTime() + ((schedule.weekday - currentDay + 7) % 7) * DAY + schedule.hour * 3600000 + schedule.minute * 60000;
  if (next <= now.getTime()) next += 7 * DAY;
  return new Date(next);
}
function scheduledTime(range, schedule) {
  validateSchedule(schedule);
  return new Date(range.end.getTime() + ((schedule.weekday + 6) % 7) * DAY + schedule.hour * 3600000 + schedule.minute * 60000);
}
function scheduleIsDue(now, range, schedule) {
  const due = scheduledTime(range, schedule);
  return now >= due && (!schedule.effectiveFrom || due.getTime() >= Date.parse(schedule.effectiveFrom));
}

class ScheduleStore {
  constructor(directory) {
    this.store = new StateStore(directory, { filename: 'schedule.json', lockName: 'schedule.lock', maxRecords: 101 });
  }
  resolve(state) {
    const settings = state.records.filter(record => record?.kind === 'schedule');
    if (settings.length > 1) throw new BotError('INVALID_SCHEDULE', '保存されたスケジュールが重複しています。担当者が確認してください。');
    return settings.length ? validateSchedule(settings[0].value) : { ...DEFAULT_SCHEDULE };
  }
  async read() { return this.resolve(await this.store.read()); }
  async execute(command, eventKey, now) {
    return this.store.withLock(async () => {
      const state = await this.store.read();
      const current = this.resolve(state);
      const seen = state.records.filter(record => record?.kind === 'command');
      if (seen.some(record => record.eventKey === eventKey)) return { duplicate: true };
      let schedule = current;
      const changed = command.kind === 'update' && Object.entries(command.patch).some(([key, value]) => current[key] !== value);
      if (changed) {
        schedule = validateSchedule({ ...current, ...command.patch });
        schedule.effectiveFrom = nextOccurrence(schedule, now).toISOString();
      }
      await this.store.save({ version: 1, records: [
        { kind: 'schedule', value: schedule },
        ...seen.slice(-99), { kind: 'command', eventKey }
      ] });
      return { schedule, changed };
    });
  }
}

function registerScheduleCommands(app, config, { store = new ScheduleStore(config.stateDir), now = () => new Date(),
  onChange = () => {}, report = error => console.error(safeError(error)) } = {}) {
  app.event('app_mention', async ({ event, body, client }) => {
    // 指定チャンネルに投稿できる人なら操作できます。利用者ID・本文は記録しません。
    if (!event.user || event.bot_id || event.subtype === 'bot_message' || event.channel !== config.sourceChannel || !config.allowPost) return;
    const received = now();
    const age = received.getTime() - Number(event.ts) * 1000;
    if (!Number.isFinite(age) || age > 10 * 60000 || age < -60000) return;
    const id = body?.event_id;
    const eventKey = typeof id === 'string' && /^Ev[A-Za-z0-9]+$/.test(id)
      ? id : `${event.channel}:${event.ts}`;
    const command = parseCommand(event.text);
    try {
      const result = await store.execute(command, eventKey, received);
      if (result.duplicate) return;
      let text;
      if (command.kind === 'help') text = HELP;
      else if (command.kind === 'invalid_time') text = '時刻は00:00〜23:59で指定してください。設定は変更していません。';
      else if (result.changed) {
        text = `${describeSchedule(result.schedule)}に変更しました。次の予定から適用し、同じ週の再投稿はしません。\n集計対象：前週の月曜〜日曜。`;
        if (!config.weeklyEnabled) text += '\n現在、週次実行は無効です。開始には学校の運用担当者がENABLE_WEEKLY=trueで起動してください。';
        onChange();
      } else {
        text = `現在の設定：${describeSchedule(result.schedule)}\n週次実行：${config.weeklyEnabled ? '有効' : '無効'}\n集計対象：前週の月曜〜日曜。`;
      }
      await callSlack(client, 'chat.postMessage', { channel: config.sourceChannel, thread_ts: event.thread_ts || event.ts,
        text, unfurl_links: false, unfurl_media: false, parse: 'none', link_names: false });
    } catch (error) { report(error); }
  });
}

module.exports = { DEFAULT_SCHEDULE, HELP, validateSchedule, describeSchedule, parseCommand, nextOccurrence,
  scheduledTime, scheduleIsDue, ScheduleStore, registerScheduleCommands };
