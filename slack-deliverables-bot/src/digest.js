'use strict';
const { setTimeout: sleep } = require('node:timers/promises');
const { BotError, callSlack } = require('./errors');
const { StateStore } = require('./state');
const { DEFAULT_CATEGORY, normalizeCategory, parseCategoryTag, isOriginalDeliverable } = require('./categories');
const { runCanvasDigest, canvasMarkdown } = require('./canvas');
const { runCombinedDigest } = require('./combined');
const DAY = 86400000;
const JST = 9 * 3600000;

function jstDate(date) { return new Date(date.getTime() + JST).toISOString().slice(0, 10); }
function formatJst(date) { return new Date(date.getTime() + JST).toISOString().slice(0, 16).replace('T', ' ').replaceAll('-', '/'); }
function makeRange(now, weekly) {
  const midnight = new Date(jstDate(now) + 'T00:00:00+09:00');
  const monday = new Date(midnight.getTime() - ((new Date(midnight.getTime() + JST).getUTCDay() + 6) % 7) * DAY);
  const end = weekly ? monday : new Date(now);
  const start = new Date(end.getTime() - 7 * DAY);
  return { start, end, label: `${formatJst(start)} 〜 ${formatJst(end)}（終端は含まない）`,
    key: weekly ? jstDate(start) : jstDate(now), readyAt: new Date(monday.getTime() + JST) };
}
function labelText(value) {
  return String(value).replace(/[\r\n\t]/g, ' ').replace(/[|*_~`]/g, ' ').slice(0, 180)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function safePermalink(value) {
  let url;
  try { url = new URL(value); } catch { throw new BotError('INVALID_LINK', '元投稿のリンクを確認できません。'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9.-]+\.slack\.com$/i.test(url.hostname) || url.username || url.password || url.port) {
    throw new BotError('INVALID_LINK', '元投稿のリンクがSlackのURLではありません。');
  }
  return url.href.replace(/[<>|]/g, char => encodeURIComponent(char)).replaceAll('&', '&amp;');
}
function postPayload(channel, text, threadTs) {
  return { channel, text, unfurl_links: false, unfurl_media: false, parse: 'none', link_names: false,
    ...(threadTs ? { thread_ts: threadTs } : {}) };
}

async function collectDigest(client, config, range) {
  let cursor;
  let scanned = 0;
  let matched = 0;
  const seen = new Set();
  const cursors = new Set();
  const items = [];
  for (let page = 0; page < config.maxPages; page++) {
    const result = await callSlack(client, 'conversations.history', {
      channel: config.sourceChannel, oldest: String(range.start.getTime() / 1000),
      latest: String(range.end.getTime() / 1000), inclusive: true, limit: 100,
      ...(cursor ? { cursor } : {})
    });
    for (const message of result.messages || []) {
      if (seen.has(message.ts)) continue;
      seen.add(message.ts);
      const time = Number(message.ts) * 1000;
      if (!Number.isFinite(time) || time < range.start.getTime() || time >= range.end.getTime()) continue;
      scanned++;
      if (!isOriginalDeliverable(message)) continue;
      matched++;
      const resultLink = await callSlack(client, 'chat.getPermalink', { channel: config.sourceChannel, message_ts: message.ts });
      const url = safePermalink(resultLink.permalink);
      const date = jstDate(new Date(time)).slice(5).replace('-', '/');
      const files = Array.isArray(message.files) ? message.files : [];
      const category = parseCategoryTag(message.text, config.categories).category;
      if (files.length) {
        for (const file of files) items.push({ label: file.name || file.title || `添付ファイル（${date}）`, url, time, category });
      } else {
        items.push({ label: `制作物（${date}）`, url, time, category });
      }
      if (items.length > config.maxItems) throw new BotError('TOO_MANY_ITEMS', '制作物が上限を超えました。不完全な一覧は投稿しません。');
    }
    cursor = result.response_metadata?.next_cursor?.trim();
    if (!cursor) {
      if (result.has_more) throw new BotError('INCOMPLETE_HISTORY', '次ページを取得できません。不完全な一覧は投稿しません。');
      items.sort((a, b) => a.time - b.time);
      return { scanned, matched, items };
    }
    if (cursors.has(cursor)) throw new BotError('INVALID_CURSOR', '履歴のページ取得が繰り返されています。');
    cursors.add(cursor);
  }
  throw new BotError('TOO_MANY_PAGES', '履歴取得の上限に達しました。不完全な一覧は投稿しません。');
}

function groupedReplies(items, categories = []) {
  const groups = new Map([...categories, DEFAULT_CATEGORY].map(category => [category, []]));
  for (const item of items) groups.get(normalizeCategory(item.category, categories)).push(item);
  const replies = [];
  for (const [category, entries] of groups) {
    if (!entries.length) continue;
    const heading = `*${labelText(category)}*\n`;
    const continuedHeading = `*${labelText(category)}（続き）*\n`;
    let text = heading;
    for (const item of entries) {
      const line = `• <${item.url}|${labelText(item.label)}>\n`;
      if (continuedHeading.length + line.length > 2800) throw new BotError('ITEM_TOO_LONG', '一覧項目が長すぎるため投稿を停止しました。');
      if (text.length + line.length > 2800) {
        replies.push(text);
        text = continuedHeading;
      }
      text += line;
    }
    replies.push(text);
  }
  return replies;
}

async function pinParent(client, record, state, store) {
  try {
    await callSlack(client, 'pins.add', { channel: record.channel, timestamp: record.parentTs });
  } catch (error) {
    if (!(error instanceof BotError && error.message === 'pins.add: already_pinned')) throw error;
  }
  record.phase = 'done';
  await store.save(state);
  return { status: 'done', pinOnly: true };
}

async function runDigest({ client, config, mode, testRunId, now = new Date(), store = new StateStore(config.stateDir), wait = sleep }) {
  if (!['preview', 'test', 'weekly'].includes(mode)) throw new BotError('INVALID_MODE', '実行モードが不正です。');
  if (testRunId !== undefined && (mode !== 'test' || typeof testRunId !== 'string' || !/^[1-9]\d{0,3}$/.test(testRunId))) {
    throw new BotError('INVALID_ARGUMENT', 'テスト番号は手動テストでのみ1〜9999を指定できます。');
  }
  const range = makeRange(now, mode === 'weekly');
  if (mode === 'preview') {
    const data = await collectDigest(client, config, range);
    groupedReplies(data.items, config.categories);
    if (['canvas', 'both'].includes(config.outputMode) && data.items.length) canvasMarkdown(data, range, { mode: 'test', categories: config.categories });
    const counts = new Map();
    for (const item of data.items) counts.set(item.category, (counts.get(item.category) || 0) + 1);
    return { status: 'preview', period: range.label, scanned: data.scanned, matched: data.matched, count: data.items.length,
      categories: Array.from(counts, ([name, count]) => ({ name, count })) };
  }
  if (!config.allowPost) throw new BotError('POST_DISABLED', '投稿は無効です。確認後にALLOW_SLACK_POST=trueを設定してください。');
  if (config.outputMode === 'both') {
    return runCombinedDigest({ client, config, mode, testRunId, range, store,
      collect: (savedRange = range) => collectDigest(client, config, savedRange), groupedReplies, postPayload, wait });
  }
  if (config.outputMode === 'canvas') {
    return runCanvasDigest({ client, config, mode, testRunId, range, store,
      collect: () => collectDigest(client, config, range) });
  }
  const channel = mode === 'test' ? config.testChannel : config.outputChannel;
  if (!channel) throw new BotError('MISSING_OUTPUT', '実行モードに対応する投稿先チャンネルを設定してください。');
  return store.withLock(async () => {
    const state = await store.read();
    const key = `${mode}:${channel}:${range.key}${testRunId ? ':run-' + testRunId : ''}`;
    const existing = state.records.find(record => record.key === key);
    if (existing) {
      if (existing.phase === 'posted_unpinned') return pinParent(client, existing, state, store);
      if (['done', 'empty'].includes(existing.phase)) return { status: 'already_processed' };
      throw new BotError('NEEDS_REVIEW', '前回の投稿結果を確認する必要があります。READMEの復旧手順を確認してください。');
    }
    const data = await collectDigest(client, config, range);
    const replies = groupedReplies(data.items, config.categories);
    const record = { key, channel, periodStart: range.start.toISOString(), periodEnd: range.end.toISOString(),
      phase: data.items.length ? 'posting' : 'empty', parentTs: null, sentReplies: 0 };
    state.records.push(record);
    // 投稿前に保存。通信結果不明時の二重投稿を防ぎます。
    await store.save(state);
    if (!data.items.length) return { status: 'empty', count: 0 };
    const title = `${mode === 'test' ? (testRunId ? '【試作品 #' + testRunId + '】' : '【試作品】') : ''}今週の制作物\n対象期間：${range.label}\n${data.matched}投稿・${data.items.length}項目。スレッドをご覧ください。`;
    const parent = await callSlack(client, 'chat.postMessage', postPayload(channel, title));
    if (typeof parent.ts !== 'string' || !/^\d+\.\d+$/.test(parent.ts)) throw new BotError('INVALID_RESPONSE', '親投稿の結果を確認できません。');
    record.parentTs = parent.ts;
    await store.save(state);
    for (const text of replies) {
      await wait(1100);
      await callSlack(client, 'chat.postMessage', postPayload(channel, text, parent.ts));
      record.sentReplies++;
      await store.save(state);
    }
    record.phase = config.autoPin ? 'posted_unpinned' : 'done';
    await store.save(state);
    if (config.autoPin) await pinParent(client, record, state, store);
    return { status: 'done', count: data.items.length };
  });
}

module.exports = { makeRange, labelText, safePermalink, postPayload, collectDigest, groupedReplies, runDigest };
