'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('テスト番号のCLI引数を検証する', () => {
  const { parseTestRunId } = require('../src/app');
  assert.equal(parseTestRunId('test', ['--run-id=2']), '2');
  assert.equal(parseTestRunId('test', []), undefined);
  for (const [mode, args] of [['weekly', ['--run-id=2']], ['test', ['--run-id=02']], ['test', ['--run-id=0']], ['test', ['--unknown=2']]]) {
    assert.throws(() => parseTestRunId(mode, args), { code: 'INVALID_ARGUMENT' });
  }
});

test('実際のBoltの初期化は通信もHTTP受信口も作らず、投稿APIの自動リトライを無効にする', t => {
  t.mock.method(http, 'request', () => { assert.fail('unexpected HTTP request'); });
  t.mock.method(https, 'request', () => { assert.fail('unexpected HTTPS request'); });
  t.mock.method(globalThis, 'fetch', () => { assert.fail('unexpected fetch'); });
  const { createBoltApp } = require('../src/app');
  const app = createBoltApp({ botToken: 'xoxb-synthetic-fixture', appToken: 'xapp-synthetic-fixture' });
  assert.equal(app.webClientOptions.retryConfig.retries, 0);
  assert.equal(app.webClientOptions.rejectRateLimitedCalls, true);
  assert.equal(app.initialized, false);
  assert.equal(app.receiver.httpServer, undefined);
  assert.equal(typeof app.client.canvases.edit, 'function');
  assert.equal(typeof app.client.conversations.canvases.create, 'function');
});

test('CLIの架空表示と自動実行無効時はトークンなし／接続なしで終了できる', () => {
  const entry = path.join(__dirname, '..', 'src', 'app.js');
  const mock = spawnSync(process.execPath, [entry, 'mock'], { encoding: 'utf8', env: {} });
  assert.equal(mock.status, 0);
  assert(mock.stdout.includes('架空データのみ'));
  const stopped = spawnSync(process.execPath, [entry, 'start'], {
    encoding: 'utf8', env: {
      SLACK_BOT_TOKEN: 'xoxb-synthetic-fixture', SLACK_APP_TOKEN: 'xapp-synthetic-fixture',
      SLACK_SOURCE_CHANNEL_ID: 'C12345', ENABLE_WEEKLY: 'false'
    }
  });
  assert.equal(stopped.status, 0);
  assert(stopped.stdout.includes('Slackには接続していません'));
});
