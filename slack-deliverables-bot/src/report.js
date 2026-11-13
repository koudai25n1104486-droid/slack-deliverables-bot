'use strict';
const { setTimeout: sleep } = require('node:timers/promises');
const { BotError, callSlack, safeError } = require('./errors');
const { makeRange, collectDigest, groupedReplies, postPayload } = require('./digest');

function currentWeekRange(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new BotError('INVALID_DATE', '集計時刻を確認できません。');
  const start = makeRange(now, true).end;
  const end = new Date(now);
  const format = date => new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 16).replace('T', ' ').replaceAll('-', '/');
  return { start, end, label: `${format(start)} 〜 ${format(end)}（日本時間・終端は含まない）` };
}

class OnDemandReporter {
  constructor({ client, config, wait = sleep, clock = Date.now, collect = collectDigest,
    reportError = error => console.error(safeError(error)) }) {
    this.client = client;
    this.config = config;
    this.wait = wait;
    this.clock = clock;
    this.collect = collect;
    this.reportError = reportError;
    this.busy = false;
    this.lastStarted = -Infinity;
  }
  async reply(text, event) {
    await this.wait(1100);
    return callSlack(this.client, 'chat.postMessage', postPayload(this.config.sourceChannel, text, event.thread_ts || event.ts));
  }
  async run(event, now = new Date()) {
    if (!this.config.allowPost) throw new BotError('POST_DISABLED', '随時報告はALLOW_SLACK_POST=trueで有効にしてください。');
    if (!event?.user || event.bot_id || event.subtype === 'bot_message' || event.channel !== this.config.sourceChannel ||
      !/^\d+\.\d+$/.test(event.ts || '') || (event.thread_ts && !/^\d+\.\d+$/.test(event.thread_ts))) {
      throw new BotError('INVALID_REPORT_CONTEXT', '指定チャンネルの投稿から指示してください。');
    }
    if (this.busy || this.clock() - this.lastStarted < 30000) {
      await this.reply('随時集計の実行中、または前回の開始から30秒以内です。少し待ってもう一度お試しください。', event);
      return { status: 'cooldown' };
    }
    this.busy = true;
    this.lastStarted = this.clock();
    let displayed = false;
    try {
      const range = currentWeekRange(now);
      const data = await this.collect(this.client, this.config, range);
      const replies = groupedReplies(data.items, this.config.categories);
      const title = `今週の制作物（随時集計）\n対象期間：${range.label}\n${data.matched}投稿・${data.items.length}項目。`;
      await this.reply(title + (data.items.length ? '\n分類別の一覧をこのスレッドに表示します。' : '\nこの期間の制作物はまだありません。'), event);
      displayed = true;
      for (const text of replies) await this.reply(text, event);
      // 週次の実行記録・Canvas・ピンは変更しません。内容はメモリ上だけで扱います。
      return { status: 'done', count: data.items.length, matched: data.matched };
    } catch (error) {
      this.reportError(error);
      try {
        await this.reply(displayed
          ? '一覧の表示中にエラーが発生しました。一部のみ表示されている可能性があります。少し待ってもう一度お試しください。'
          : '随時集計に失敗しました。少し待ってもう一度お試しください。続く場合は運用担当者に確認してください。', event);
      } catch (replyError) { this.reportError(replyError); }
      return { status: 'failed' };
    } finally { this.busy = false; }
  }
}

module.exports = { currentWeekRange, OnDemandReporter };
