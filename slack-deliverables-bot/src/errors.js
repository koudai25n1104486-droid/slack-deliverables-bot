'use strict';

class BotError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'BotError';
  }
}

const diagnosticHints = new Map([
  ['invalid_auth', 'トークンが無効です。対象アプリで発行した値を.envに設定し直してください。'],
  ['not_authed', 'トークンが渡されていません。.envの設定を確認してください。'],
  ['token_revoked', 'トークンが失効しています。再インストール・再発行した値を設定してください。'],
  ['token_expired', 'トークンの有効期限が切れています。認証設定を確認してください。'],
  ['not_allowed_token_type', 'トークンの種類が違います。ボット認証はxoxb-、Socket Modeはxapp-です。'],
  ['missing_scope', '必要な権限がありません。Socket Mode用のxapp-にはconnections:writeを確認してください。'],
  ['not_enabled', 'SlackアプリのSocket Mode等が有効になっているか確認してください。'],
  ['app_not_found', '対象のSlackアプリを確認できません。トークンの発行元を確認してください。'],
  ['account_inactive', 'アカウントまたはアプリのインストール状態を確認してください。'],
  ['access_denied', 'アクセスが拒否されました。ワークスペースの管理設定を確認してください。'],
  ['accesslimited', 'ネットワークからのアクセスが制限されています。管理者へ確認してください。'],
  ['team_access_not_granted', '対象ワークスペースへの許可を確認してください。'],
  ['invalid_arguments', 'Slackへ渡した設定を確認できません。更新版のコード一式を確認してください。'],
  ['ratelimited', 'Slackの呼び出し制限です。時間を空けて再実行してください。'],
  ['MODULE_NOT_FOUND', '必要なファイルがありません。コード一式を配置し、npm ci --ignore-scriptsを実行してください。'],
  ['ERR_MODULE_NOT_FOUND', '必要なファイルがありません。コード一式を配置し、npm ci --ignore-scriptsを実行してください。'],
  ['ENOENT', '必要なファイルがありません。更新版ZIPの全ファイルを確認してください。'],
  ['EACCES', 'ファイルのアクセス権限を確認してください。'],
  ['EPERM', '実行環境のファイル・操作権限を確認してください。'],
  ['ENOTFOUND', 'Slackの接続先を名前解決できません。ネットワーク設定を確認してください。'],
  ['EAI_AGAIN', '名前解決に一時的に失敗しました。ネットワーク設定を確認してください。'],
  ['ECONNREFUSED', '接続が拒否されました。ネットワーク制限を確認してください。'],
  ['ECONNRESET', '接続が切断されました。ネットワーク制限を確認してください。'],
  ['ETIMEDOUT', '接続がタイムアウトしました。ネットワーク制限を確認してください。'],
  ['CERT_HAS_EXPIRED', '証明書の期限・PCの時刻・学校のネットワーク設定を確認してください。'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', '証明書を検証できません。学校の管理者へ確認してください。'],
  ['SELF_SIGNED_CERT_IN_CHAIN', '学校のネットワーク証明書の設定を管理者へ確認してください。'],
  ['DEPTH_ZERO_SELF_SIGNED_CERT', '学校のネットワーク証明書の設定を管理者へ確認してください。'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', '接続先の証明書を検証できません。管理者へ確認してください。']
]);

// 既知のコードだけを表示します。例外のmessage・stack・API応答は表示しません。
function diagnosticReason(error, visited = new Set()) {
  if (!error || typeof error !== 'object' || visited.has(error) || visited.size >= 8) return null;
  visited.add(error);
  for (const code of [error.data?.error, error.code]) {
    if (diagnosticHints.has(code)) return `${code}: ${diagnosticHints.get(code)}`;
  }
  for (const nested of [error.cause, error.original]) {
    const reason = diagnosticReason(nested, visited);
    if (reason) return reason;
  }
  if (error instanceof SyntaxError) return 'JSON_PARSE_ERROR: 分類設定等のJSON形式を確認してください。';
  if (error instanceof TypeError) return 'TYPE_ERROR: コードや依存パッケージの組み合わせを確認してください。';
  if (error.name === 'AppInitializationError') return 'BOLT_INITIALIZATION_ERROR: Boltの設定を確認してください。';
  return null;
}

async function startupStep(stage, action, log = console.log) {
  log(`STARTUP: ${stage}を確認しています。`);
  try {
    const result = await action();
    log(`STARTUP: ${stage} OK`);
    return result;
  } catch (error) {
    if (error instanceof BotError) throw new BotError(error.code, `${stage}: ${error.message}`);
    throw new BotError('STARTUP_FAILED', `${stage}: ${diagnosticReason(error) || '原因を安全に判別できません。直前のSTARTUP行を確認してください。'}`);
  }
}

// SDKのエラー全体にはAPI応答やリクエスト情報が含まれ得るため出力しません。
function safeError(error) {
  if (error instanceof BotError) return `${error.code}: ${error.message}`;
  const reason = diagnosticReason(error);
  if (reason) return reason;
  return 'UNEXPECTED_ERROR: 処理に失敗しました。権限・ネットワーク・実行環境を確認してください。';
}

async function callSlack(client, method, payload) {
  const allowed = ['conversations.history', 'chat.getPermalink', 'chat.postMessage', 'pins.add', 'canvases.edit', 'conversations.canvases.create'];
  if (!allowed.includes(method)) throw new BotError('API_NOT_ALLOWED', '許可されていないAPIです。');
  const parts = method.split('.');
  const name = parts.pop();
  const owner = parts.reduce((object, part) => object?.[part], client);
  try {
    const result = await owner[name](payload);
    if (!result?.ok) {
      const code = /^[a-z_]+$/.test(result?.error || '') ? result.error : 'unknown_error';
      throw new BotError('SLACK_API_ERROR', `${method}: ${code}`);
    }
    return result;
  } catch (error) {
    if (error instanceof BotError) throw error;
    const code = error?.data?.error;
    if (typeof code === 'string' && /^[a-z_]+$/.test(code)) {
      throw new BotError('SLACK_API_ERROR', `${method}: ${code}`);
    }
    if (error?.code === 'slack_webapi_rate_limited_error' || error?.statusCode === 429) {
      throw new BotError('RATE_LIMITED', `${method}: 呼び出し制限です。時間を空けて確認してください。`);
    }
    throw new BotError('SLACK_CONNECTION_ERROR', `${method}: 通信結果を確認できません。自動再送はしません。`);
  }
}

module.exports = { BotError, safeError, callSlack, diagnosticReason, startupStep };
