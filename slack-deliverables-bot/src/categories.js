'use strict';
const { BotError } = require('./errors');
const DEFAULT_CATEGORY = '制作物';

function validateCategories(value) {
  if (!Array.isArray(value) || !value.length || value.length > 20 || new Set(value).size !== value.length ||
    value.some(label => typeof label !== 'string' || !label.trim() || label !== label.trim() ||
      [...label].length > 60 || /[\s\u0000-\u001f\u007f#<>|、。！!？?：:]/u.test(label) || label === DEFAULT_CATEGORY)) {
    throw new BotError('INVALID_CATEGORIES', 'categories.jsonは重複のない1〜20件・各60文字以内の分類名にしてください。空白・改行・記号区切り・既定名「制作物」は使えません。');
  }
  return [...value];
}
function normalizeCategory(value, categories = []) {
  return categories.includes(value) ? value : DEFAULT_CATEGORY;
}
// 半角#と半角ハイフンを使用。複数ある場合は本文の最初の対象タグを採用します。
function parseCategoryTag(text, categories = []) {
  const match = /(^|\s)#制作物(?:-([^\s、。！!？?：:<>|]*))?(?=$|\s|[、。！!？?：:])/u.exec(String(text || ''));
  return { matched: Boolean(match), category: normalizeCategory(match?.[2], categories) };
}
function isOriginalDeliverable(message) {
  return Boolean(message?.user && !message.bot_id && (!message.subtype || message.subtype === 'file_share') &&
    (!message.thread_ts || message.thread_ts === message.ts) && parseCategoryTag(message.text).matched);
}
module.exports = { DEFAULT_CATEGORY, validateCategories, normalizeCategory, parseCategoryTag, isOriginalDeliverable };
