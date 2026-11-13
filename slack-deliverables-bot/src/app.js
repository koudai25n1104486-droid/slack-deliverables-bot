'use strict';
const { loadConfig } = require('./config');
const { BotError, safeError, startupStep } = require('./errors');
const { makeRange, runDigest } = require('./digest');
const { setupChannelCanvas } = require('./canvas');
const { ScheduleStore, describeSchedule, scheduleIsDue, registerScheduleCommands } = require('./schedule');

// SDKに渡すロガーはAPI応答やイベントを出力しません。
const quietLogger = {
  debug() {}, info() {}, warn() {},
  error() { console.error('SLACK_SDK_ERROR: Slack接続処理でエラーが発生しました。'); },
  getLevel() { return 'error'; }, setLevel() {}, setName() {}
};

function parseTestRunId(mode, args = []) {
  if (!args.length) return undefined;
  const match = args.length === 1 && /^--run-id=([1-9]\d{0,3})$/.exec(args[0]);
  if (mode !== 'test' || !match) throw new BotError('INVALID_ARGUMENT', 'テスト番号は post:test -- --run-id=2 の形式で、1〜9999を指定してください。');
  return match[1];
}

function createBoltApp(config) {
  const { App } = require('@slack/bolt');
  return new App({
    token: config.botToken, appToken: config.appToken, socketMode: true, logger: quietLogger,
    deferInitialization: true, convoStore: false,
    clientOptions: { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 30000, logger: quietLogger }
  });
}

async function main() {
  const mode = process.argv[2] || 'mock';
  if (mode === 'mock') {
    console.log('今週の制作物\n│\n└─ スレッド\n    イラスト\n    └─ のーたんさん20261114.png → Slackの元投稿\n    動画\n    └─ サンプル動画.mp4 → Slackの元投稿\n    制作物（未分類）\n    └─ ぴんちゃんさん20261111.jpeg → Slackの元投稿\n\n架空データのみです。接続・投稿・データ保存はしていません。');
    return;
  }
  if (!['preview', 'test', 'weekly', 'start', 'diagnose', 'canvas-setup'].includes(mode)) throw new BotError('INVALID_MODE', 'mock / preview / test / weekly / start / diagnose / canvas-setup のいずれかを指定してください。');
  const testRunId = parseTestRunId(mode, process.argv.slice(3));
  const config = await startupStep('設定ファイル', () => loadConfig());
  if (mode === 'start' && !config.weeklyEnabled && !config.mentionCommandsEnabled) {
    console.log('週次実行は無効です。ENABLE_WEEKLY=trueで有効にできます。タグの読み取り確認はnpm run previewを実行してください。Slackには接続していません。');
    return;
  }
  if ((mode === 'start' || ['test', 'weekly', 'canvas-setup'].includes(mode)) && !config.allowPost) {
    throw new BotError('POST_DISABLED', '投稿は無効です。確認後にALLOW_SLACK_POST=trueを設定してください。');
  }
  if (mode === 'start' && config.weeklyEnabled && !config.outputChannel) throw new BotError('MISSING_OUTPUT', 'SLACK_OUTPUT_CHANNEL_IDを設定してください。');
  const app = await startupStep('Boltの読み込み', () => createBoltApp(config));
  app.error(async () => { console.error('SLACK_EVENT_ERROR: Slack接続の処理を確認してください。'); });
  if (mode === 'diagnose') {
    await diagnoseApp(app, config);
    return;
  }
  if (mode === 'canvas-setup') {
    console.log(JSON.stringify(await setupChannelCanvas(app.client, config)));
    return;
  }
  if (mode !== 'start') {
    const result = await runDigest({ client: app.client, config, mode, testRunId });
    console.log(JSON.stringify(result));
    return;
  }
  let busy = false;
  let stopping = false;
  let nextAttempt = 0;
  let lastPeriod;
  const scheduleStore = new ScheduleStore(config.stateDir);
  const initialSchedule = await startupStep('投稿スケジュール', () => scheduleStore.read());
  if (config.mentionCommandsEnabled) registerScheduleCommands(app, config, { store: scheduleStore, onChange: () => { nextAttempt = 0; } });
  // 管理用のapp_mentionだけを購読。制作物は週次の履歴取得で抽出します。
  await startupStep('ボット認証（xoxb）', () => app.init());
  await startupStep('Socket Mode接続（xapp）', () => app.start());
  console.log(`ボットを起動しました。出力先：${config.outputMode}／予定：${describeSchedule(initialSchedule)}／週次実行：${config.weeklyEnabled ? '有効' : '無効'}／メンション操作：${config.mentionCommandsEnabled ? '有効' : '無効'}`);
  async function tick() {
    const now = new Date();
    const range = makeRange(now, true);
    if (!config.weeklyEnabled || stopping || busy || now.getTime() < nextAttempt || lastPeriod === range.key) return;
    busy = true;
    try {
      const schedule = await scheduleStore.read();
      if (!scheduleIsDue(now, range, schedule)) return;
      const result = await runDigest({ client: app.client, config, mode: 'weekly', now });
      lastPeriod = range.key;
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(safeError(error));
      // 再取得の連発を防ぐ。投稿結果が不明な場合は実行記録が再投稿を止めます。
      nextAttempt = Date.now() + 3600000;
    } finally { busy = false; }
  }
  const timer = setInterval(() => { void tick(); }, 60000);
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    console.log('終了要求を受け付けました。進行中の処理が終わるまでお待ちください。');
    // 途中終了による投稿結果不明を減らすため処理の終了を待ちます。
    while (busy) await new Promise(resolve => setTimeout(resolve, 100));
    await app.stop();
  }
  process.once('SIGINT', () => { void stop().catch(() => { process.exitCode = 1; }); });
  process.once('SIGTERM', () => { void stop().catch(() => { process.exitCode = 1; }); });
  await tick();
}

async function diagnoseApp(app, config, log = console.log) {
  await startupStep('ボット認証（xoxb）', () => app.init(), log);
  await startupStep('Socket Mode用トークン（xapp）', async () => {
    const result = await app.client.apps.connections.open({ token: config.appToken });
    if (!result?.ok || typeof result.url !== 'string') {
      throw new BotError('SOCKET_TOKEN_FAILED', 'Socket Mode用の接続情報を取得できません。');
    }
    // 一時接続URLは表示・保存せず、WebSocketにも接続しません。
  }, log);
  log('診断完了：トークン確認に成功しました。WebSocketの実接続・制作物の読み取り・投稿・分類の保存はしていません。');
}

if (require.main === module) {
  main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
}
module.exports = { main, createBoltApp, diagnoseApp, parseTestRunId };
