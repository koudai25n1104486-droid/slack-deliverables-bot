'use strict';
const { BotError, callSlack } = require('./errors');
const { DEFAULT_CATEGORY, normalizeCategory } = require('./categories');

function canvasText(value) {
  return String(value).replace(/[\r\n\t]/g, ' ').slice(0, 180)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replace(/[\\`*_{}\[\]()#+.!|~-]/g, char => '\\' + char);
}
function canvasLink(value) {
  let url;
  try { url = new URL(String(value).replaceAll('&amp;', '&')); }
  catch { throw new BotError('INVALID_LINK', 'Canvasの元投稿リンクを確認できません。'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9.-]+\.slack\.com$/i.test(url.hostname) || url.username || url.password || url.port) {
    throw new BotError('INVALID_LINK', 'Canvasに掲載できるのはSlackの元投稿リンクだけです。');
  }
  return url.href.replace(/[()]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())
    .replace(/[\s<>\\]/g, char => encodeURIComponent(char));
}
function canvasMarkdown(data, range, { mode, testRunId, categories = [] }) {
  const title = mode === 'test' ? `【試作品${testRunId ? ' #' + testRunId : ''}】今週の制作物` : '今週の制作物';
  const groups = new Map([...categories, DEFAULT_CATEGORY].map(category => [category, []]));
  for (const item of data.items) groups.get(normalizeCategory(item.category, categories)).push(item);
  let markdown = `\n\n---\n\n## ${title}\n\n対象期間：${range.label}\n\n${data.matched}投稿・${data.items.length}項目\n`;
  for (const [category, items] of groups) {
    if (!items.length) continue;
    markdown += `\n### ${canvasText(category)}\n\n`;
    for (const item of items) markdown += `- [${canvasText(item.label)}](${canvasLink(item.url)})\n`;
  }
  if (Buffer.byteLength(markdown, 'utf8') > 1024 * 1024) {
    throw new BotError('CANVAS_CONTENT_TOO_LONG', 'Canvasへの追記が1MiBを超えるため停止しました。');
  }
  return markdown;
}

async function runCanvasDigest({ client, config, mode, testRunId, range, store, collect }) {
  const canvasId = mode === 'test' ? config.testCanvasId : config.canvasId;
  const channel = mode === 'test' ? config.testChannel : config.outputChannel;
  if (!canvasId || !/^F[A-Z0-9]+$/.test(canvasId)) {
    throw new BotError('MISSING_CANVAS', mode === 'test'
      ? 'SLACK_TEST_CANVAS_IDを設定してください。テストでは本番Canvasへ自動で切り替えません。'
      : 'SLACK_CANVAS_IDを設定してください。');
  }
  if (!channel) throw new BotError('MISSING_OUTPUT', 'Canvasに対応する投稿先チャンネルIDを設定してください。');
  return store.withLock(async () => {
    const state = await store.read();
    const key = `canvas:${mode}:${canvasId}:${range.key}${testRunId ? ':run-' + testRunId : ''}`;
    const existing = state.records.find(record => record.key === key);
    if (existing) {
      if (['done', 'empty'].includes(existing.phase)) return { status: 'already_processed', output: 'canvas' };
      throw new BotError('NEEDS_REVIEW', '前回のCanvas追記結果を確認してください。二重追記を避けるため自動再送しません。');
    }
    const data = await collect();
    const markdown = data.items.length ? canvasMarkdown(data, range, { mode, testRunId, categories: config.categories }) : '';
    const record = { key, channel, canvasId, periodStart: range.start.toISOString(), periodEnd: range.end.toISOString(),
      phase: data.items.length ? 'canvas_posting' : 'empty' };
    state.records.push(record);
    await store.save(state);
    if (!data.items.length) return { status: 'empty', count: 0, output: 'canvas' };
    // 既存内容の読み取り・置換・削除は行わず、1回のAPI呼び出しで末尾に追加します。
    await callSlack(client, 'canvases.edit', { canvas_id: canvasId, changes: [{ operation: 'insert_at_end',
      document_content: { type: 'markdown', markdown } }] });
    record.phase = 'done';
    await store.save(state);
    return { status: 'done', count: data.items.length, output: 'canvas' };
  });
}

async function setupChannelCanvas(client, config) {
  if (!config.allowPost) throw new BotError('POST_DISABLED', 'Canvasの作成にはALLOW_SLACK_POST=trueが必要です。');
  if (!config.outputChannel) throw new BotError('MISSING_OUTPUT', '作成先のSLACK_OUTPUT_CHANNEL_IDを設定してください。');
  let result;
  try {
    result = await callSlack(client, 'conversations.canvases.create', { channel_id: config.outputChannel,
      title: '制作物一覧', document_content: { type: 'markdown', markdown: '# 制作物一覧\n\n週ごとの制作物を分類別に追記します。\n' } });
  } catch (error) {
    if (error instanceof BotError && error.message === 'conversations.canvases.create: channel_canvas_already_exists') {
      throw new BotError('CANVAS_ALREADY_EXISTS', 'チャンネルには既にCanvasがあります。既存CanvasのリンクからIDを確認して.envに設定してください。既存内容は変更していません。');
    }
    throw error;
  }
  if (typeof result.canvas_id !== 'string' || !/^F[A-Z0-9]+$/.test(result.canvas_id)) {
    throw new BotError('INVALID_RESPONSE', 'Canvasの作成結果を確認できません。チャンネルを確認してください。');
  }
  return { status: 'canvas_created', canvasId: result.canvas_id };
}

module.exports = { canvasText, canvasLink, canvasMarkdown, runCanvasDigest, setupChannelCanvas };
