'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BotError } = require('./errors');

class StateStore {
  constructor(directory, { filename = 'ledger.json', lockName = 'run.lock', maxRecords = 128 } = {}) {
    this.directory = directory;
    this.filename = filename;
    this.lockName = lockName;
    this.maxRecords = maxRecords;
  }

  async withLock(work) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BotError('INVALID_STATE', '状態保存先を確認してください。');
    await fs.chmod(this.directory, 0o700);
    const lockPath = path.join(this.directory, this.lockName);
    let handle;
    try {
      handle = await fs.open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') throw new BotError('LOCKED', '処理中または停止時のロックが残っています。READMEの復旧手順を確認してください。');
      throw error;
    }
    try { return await work(); }
    finally { await handle.close(); await fs.unlink(lockPath); }
  }

  async read() {
    try {
      const file = path.join(this.directory, this.filename);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error('invalid state');
      const state = JSON.parse(await fs.readFile(file, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.records) || state.records.length > this.maxRecords) throw new Error('invalid state');
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, records: [] };
      throw new BotError('INVALID_STATE', '実行記録を読み取れません。自動投稿せず停止します。');
    }
  }

  async save(state) {
    const temporary = path.join(this.directory, `ledger-${randomUUID()}.tmp`);
    const trimmed = { version: 1, records: state.records.slice(-this.maxRecords) };
    try {
      await fs.writeFile(temporary, JSON.stringify(trimmed, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, path.join(this.directory, this.filename));
    } finally {
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}
module.exports = { StateStore };
