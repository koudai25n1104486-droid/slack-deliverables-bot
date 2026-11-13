'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { BotError } = require('./errors');
const { validateCategories } = require('./categories');

function booleanValue(env, name, fallback) {
  const value = env[name] ?? String(fallback);
  if (!['true', 'false'].includes(value)) throw new BotError('INVALID_CONFIG', `${name}はtrueまたはfalseにしてください。`);
  return value === 'true';
}
function integerValue(env, name, fallback, max) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new BotError('INVALID_CONFIG', `${name}は1〜${max}の整数にしてください。`);
  }
  return value;
}
function loadCategoryFile(filename = path.join(__dirname, '..', 'categories.json')) {
  let text;
  try { text = fs.readFileSync(filename, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new BotError('CATEGORIES_FILE_MISSING', 'categories.jsonがありません。更新版ZIPのファイルをコード直下に配置してください。');
    throw new BotError('CATEGORIES_FILE_ACCESS', 'categories.jsonを読み取れません。アクセス権限を確認してください。');
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new BotError('CATEGORIES_JSON_INVALID', 'categories.jsonのJSON形式が正しくありません。配列・二重引用符・カンマを確認してください。'); }
  return validateCategories(parsed);
}
function loadConfig(env = process.env) {
  const mentionCommandsEnabled = booleanValue(env, 'ENABLE_MENTION_COMMANDS', false);
  const outputMode = env.OUTPUT_MODE || 'thread';
  if (!['thread', 'canvas', 'both'].includes(outputMode)) throw new BotError('INVALID_CONFIG', 'OUTPUT_MODEはthread、canvas、bothのいずれかにしてください。');
  for (const name of ['SLACK_CANVAS_ID', 'SLACK_TEST_CANVAS_ID']) {
    if (env[name] && !/^F[A-Z0-9]+$/.test(env[name])) throw new BotError('INVALID_CANVAS', `${name}にはFから始まるCanvas IDを設定してください。`);
  }
  if (!/^xoxb-\S+$/.test(env.SLACK_BOT_TOKEN || '') || !/^xapp-\S+$/.test(env.SLACK_APP_TOKEN || '')) {
    throw new BotError('MISSING_TOKEN', 'SLACK_BOT_TOKENとSLACK_APP_TOKENを設定してください。');
  }
  if (!/^[CG][A-Z0-9]+$/.test(env.SLACK_SOURCE_CHANNEL_ID || '')) {
    throw new BotError('INVALID_CHANNEL', 'SLACK_SOURCE_CHANNEL_IDにチャンネルIDを設定してください。');
  }
  for (const key of ['SLACK_TEST_CHANNEL_ID', 'SLACK_OUTPUT_CHANNEL_ID']) {
    if (env[key] && !/^[CG][A-Z0-9]+$/.test(env[key])) {
      throw new BotError('INVALID_CHANNEL', `${key}にチャンネルIDを設定してください。`);
    }
  }
  return {
    botToken: env.SLACK_BOT_TOKEN, appToken: env.SLACK_APP_TOKEN,
    sourceChannel: env.SLACK_SOURCE_CHANNEL_ID,
    testChannel: env.SLACK_TEST_CHANNEL_ID, outputChannel: env.SLACK_OUTPUT_CHANNEL_ID,
    outputMode, canvasId: env.SLACK_CANVAS_ID, testCanvasId: env.SLACK_TEST_CANVAS_ID,
    allowPost: booleanValue(env, 'ALLOW_SLACK_POST', false),
    weeklyEnabled: booleanValue(env, 'ENABLE_WEEKLY', false),
    mentionCommandsEnabled,
    categories: loadCategoryFile(),
    autoPin: booleanValue(env, 'AUTO_PIN', true),
    maxItems: integerValue(env, 'MAX_ITEMS', 50, 100),
    maxPages: integerValue(env, 'MAX_PAGES', 20, 50),
    stateDir: path.resolve(__dirname, '..', '.state')
  };
}
module.exports = { loadConfig, loadCategoryFile };
