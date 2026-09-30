import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);

export class AgyAuth {
  constructor({ execute = exec, cliPath = path.join(os.homedir(), '.local/bin/agy') } = {}) { this.execute = execute; this.cliPath = cliPath; }
  async read() {
    try {
      const { stdout } = await this.execute('/usr/bin/security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'], { timeout: 15000, maxBuffer: 1024 * 1024 });
      const text = stdout.trim();
      const value = JSON.parse(text.startsWith('go-keyring-base64:') ? Buffer.from(text.slice(18), 'base64').toString() : text);
      if (!value.token?.access_token) throw new Error();
      return value;
    } catch { throw new Error('无法读取本机 agy 登录，请先在终端运行 agy 登录，再刷新。'); }
  }
  async token() {
    if (!this.pending) this.pending = this.load().finally(() => { this.pending = null; });
    return this.pending;
  }
  async models() {
    try {
      const { stdout } = await this.execute(this.cliPath, ['models'], { timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
      const models = stdout.split(/\r?\n/).map(line => line.split('\t')).filter(([id, name]) => /^[a-zA-Z0-9][\w.:-]*$/.test(id) && name?.trim()).map(([id, displayName]) => ({ id, displayName: displayName.trim() }));
      if (!models.length) throw new Error();
      return models;
    } catch { throw new Error('无法发现本机 AGY 模型，请确认 agy models 可以正常运行'); }
  }
  async load() {
    let value = await this.read();
    if (!(Date.parse(value.token.expiry) > Date.now() + 60000)) {
      // Delegate credential renewal to the installed CLI; never run an agent turn.
      try { await this.execute(this.cliPath, ['models'], { timeout: 45000, maxBuffer: 4 * 1024 * 1024 }); }
      catch { throw new Error('AGY 凭证刷新失败，请在终端运行 agy 重新登录。'); }
      value = await this.read();
      if (!(Date.parse(value.token.expiry) > Date.now())) throw new Error('AGY 登录已过期，请重新登录后刷新。');
    }
    this.identity = createHash('sha256').update(value.token.access_token).digest('hex');
    return value.token.access_token;
  }
}
