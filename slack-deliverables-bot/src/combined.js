'use strict';
const { createHash } = require('node:crypto');
const { BotError, callSlack } = require('./errors');
const { canvasMarkdown } = require('./canvas');

function contentHash(replies, markdown) {
  return createHash('sha256').update(JSON.stringify({ replies, markdown })).digest('hex');
}
function rejectedBeforeCanvasWrite(error) {
  if (!(error instanceof BotError)) return false;
  if (error.code === 'RATE_LIMITED') return true;
  return error.code === 'SLACK_API_ERROR' && [
    'missing_scope', 'no_permission', 'canvas_not_found', 'file_not_found', 'not_in_channel',
    'invalid_auth', 'token_revoked', 'token_expired', 'access_denied', 'canvas_disabled_user_team',
    'not_allowed_token_type', 'not_authed', 'enterprise_is_restricted'
  ].some(code => error.message === `canvases.edit: ${code}`);
}

async function runCombinedDigest({ client, config, mode, testRunId, range, store, collect, groupedReplies, postPayload, wait }) {
  const channel = mode === 'test' ? config.testChannel : config.outputChannel;
  const canvasId = mode === 'test' ? config.testCanvasId : config.canvasId;
  if (!channel) throw new BotError('MISSING_OUTPUT', '投稿先チャンネルIDを設定してください。');
  if (!canvasId || !/^F[A-Z0-9]+$/.test(canvasId)) throw new BotError('MISSING_CANVAS',
    mode === 'test' ? 'SLACK_TEST_CANVAS_IDを設定してください。本番Canvasへ自動で切り替えません。' : 'SLACK_CANVAS_IDを設定してください。');
  return store.withLock(async () => {
    const state = await store.read();
    const suffix = `${mode}:${channel}:${range.key}${testRunId ? ':run-' + testRunId : ''}`;
    const canvasKey = `canvas:${mode}:${canvasId}:${range.key}${testRunId ? ':run-' + testRunId : ''}`;
    let record = state.records.find(item => item.key === suffix);
    let canvasRecord = state.records.find(item => item.key === canvasKey);
    let currentData;
    let markdown;
    let replies;
    if (record) {
      // 以前のスレッド投稿も、同じ期間・番号では再投稿しません。
      if (['done', 'empty'].includes(record.phase)) return { status: 'already_processed', output: record.outputMode || 'thread' };
      if (record.outputMode !== 'both' || record.phase !== 'posted') {
        throw new BotError('NEEDS_REVIEW', '前回のチャンネル投稿の完了を確認できません。自動で再投稿しません。');
      }
      if (record.canvasId !== canvasId || record.canvasKey !== canvasKey || !canvasRecord) {
        throw new BotError('CONFIG_CHANGED', '処理途中でCanvas設定や実行記録が変わっています。担当者が確認してください。');
      }
      if (!['done', 'canvas_reserved', 'canvas_retryable'].includes(canvasRecord.phase)) {
        throw new BotError('NEEDS_REVIEW', 'チャンネル投稿は完了していますがCanvas追記の結果が不明です。Canvasを確認するまで自動再送しません。');
      }
      if (canvasRecord.phase !== 'done') {
        const savedRange = { ...range, start: new Date(record.periodStart), end: new Date(record.periodEnd), label: record.rangeLabel };
        currentData = await collect(savedRange);
        replies = groupedReplies(currentData.items, config.categories);
        markdown = canvasMarkdown(currentData, savedRange, { mode, testRunId, categories: config.categories });
        if (contentHash(replies, markdown) !== record.contentHash) {
          throw new BotError('CONTENT_CHANGED', 'チャンネル投稿後に元投稿や分類設定が変更されています。同じ内容を保証できないためCanvas追記を停止しました。');
        }
      }
    } else {
      if (canvasRecord && !['done', 'empty'].includes(canvasRecord.phase)) {
        throw new BotError('NEEDS_REVIEW', '同じ期間のCanvas追記が未確認です。確認後に実行してください。');
      }
      currentData = await collect(range);
      replies = groupedReplies(currentData.items, config.categories);
      markdown = currentData.items.length ? canvasMarkdown(currentData, range, { mode, testRunId, categories: config.categories }) : '';
      record = { key: suffix, outputMode: 'both', channel, canvasId, canvasKey,
        periodStart: range.start.toISOString(), periodEnd: range.end.toISOString(), rangeLabel: range.label,
        phase: currentData.items.length ? 'posting' : 'empty', parentTs: null, sentReplies: 0,
        itemCount: currentData.items.length, contentHash: contentHash(replies, markdown),
        pinRequested: config.autoPin, pinDone: false, canvasReused: canvasRecord?.phase === 'done' };
      state.records.push(record);
      if (!currentData.items.length) {
        await store.save(state);
        return { status: 'empty', count: 0, output: 'both' };
      }
      if (!canvasRecord || canvasRecord.phase === 'empty') {
        if (canvasRecord) state.records.splice(state.records.indexOf(canvasRecord), 1);
        canvasRecord = { key: canvasKey, channel, canvasId, periodStart: record.periodStart, periodEnd: record.periodEnd,
          phase: 'canvas_reserved' };
        state.records.push(canvasRecord);
      }
      await store.save(state);
      const title = `${mode === 'test' ? (testRunId ? '【試作品 #' + testRunId + '】' : '【試作品】') : ''}今週の制作物\n対象期間：${range.label}\n${currentData.matched}投稿・${currentData.items.length}項目。スレッドをご覧ください。`;
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
      record.phase = 'posted';
      await store.save(state);
    }

    if (canvasRecord.phase !== 'done') {
      canvasRecord.phase = 'canvas_posting';
      await store.save(state);
      try {
        await callSlack(client, 'canvases.edit', { canvas_id: canvasId,
          changes: [{ operation: 'insert_at_end', document_content: { type: 'markdown', markdown } }] });
      } catch (error) {
        if (rejectedBeforeCanvasWrite(error)) {
          canvasRecord.phase = 'canvas_retryable';
          await store.save(state);
          throw new BotError('THREAD_POSTED_CANVAS_PENDING', `チャンネルへの投稿は完了しました。Canvasは未更新です。権限等を修正し、同じコマンドでCanvasだけ再試行できます。原因：${error.message}`);
        }
        throw new BotError('THREAD_POSTED_CANVAS_UNCERTAIN', 'チャンネルへの投稿は完了しました。Canvasの追記結果が不明のため、自動再送せず担当者の確認を待ちます。');
      }
      canvasRecord.phase = 'done';
      await store.save(state);
    }
    if (record.pinRequested && config.autoPin && !record.pinDone) {
      try {
        await callSlack(client, 'pins.add', { channel, timestamp: record.parentTs });
      } catch (error) {
        if (!(error instanceof BotError && error.message === 'pins.add: already_pinned')) throw error;
      }
      record.pinDone = true;
    }
    record.phase = 'done';
    await store.save(state);
    return { status: 'done', output: 'both', count: record.itemCount, canvasReused: record.canvasReused };
  });
}

module.exports = { runCombinedDigest, contentHash, rejectedBeforeCanvasWrite };
