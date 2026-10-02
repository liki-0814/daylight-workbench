import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execute = promisify(execFile);
export const authError = () => Object.assign(new Error('请在终端运行 grok login --oauth，完成后刷新登录'), { code: 'source_auth_required' });
export class GrokAuth {
  constructor({ home = path.join(os.homedir(), '.grok'), run = execute } = {}) { this.home = home; this.run = run; }
  async read() {
    let store;
    try { store = JSON.parse(await readFile(path.join(this.home, 'auth.json'), 'utf8')); } catch { throw authError(); }
    const candidates = Object.entries(store).filter(([scope, a]) => scope.startsWith('https://auth.x.ai::') && a.auth_mode === 'oidc' && typeof a.key === 'string' && a.key);
    // Never guess which account owns the subscription when multiple scopes exist.
    if (candidates.length !== 1) throw authError();
    const [scope, a] = candidates[0];
    return { token: a.key, expires: Date.parse(a.expires_at), identity: createHash('sha256').update(JSON.stringify([scope, a.user_id, a.principal_id, a.team_id])).digest('hex') };
  }
  async version() {
    if (!this.clientVersion) {
      const { stdout } = await this.run(path.join(this.home, 'bin/grok'), ['--version'], { timeout: 10000, maxBuffer: 65536 });
      this.clientVersion = /^grok\s+(\d+\.\d+\.\d+)/.exec(stdout)?.[1];
      if (!this.clientVersion) throw authError();
    }
    return this.clientVersion;
  }
  async credential(force = false) {
    let a = await this.read();
    if (force || !Number.isFinite(a.expires) || a.expires < Date.now() + 60000) {
      if (!this.refreshing && Date.now() - (this.refreshedAt || 0) > 30000) {
        this.refreshedAt = Date.now();
        // Official CLI owns its flock, rotating refresh token and atomic persistence.
        // models performs no agent turn and executes no tools.
        this.refreshing = this.run(path.join(this.home, 'bin/grok'), ['models'], { cwd: this.home, timeout: 45000, maxBuffer: 1_000_000, env: { ...process.env, XAI_API_KEY: '', GROK_API_KEY: '' } }).catch(() => {}).finally(() => { this.refreshing = null; });
      }
      await this.refreshing;
      a = await this.read();
    }
    if (!Number.isFinite(a.expires) || a.expires <= Date.now()) throw authError();
    return { ...a, version: await this.version() };
  }
}
