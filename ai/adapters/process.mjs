import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export const exec = promisify(execFile);
export function executable(backend, custom = '') {
  const name = backend === 'codex' ? 'codex' : 'qodercli';
  const candidates = custom ? [custom] : [...(process.env.PATH || '').split(path.delimiter).map(p => path.join(p, name)), ...['.npm-global/bin', '.local/bin', '.volta/bin'].map(p => path.join(os.homedir(), p, name)), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`];
  for (const p of candidates) { if (!path.isAbsolute(p)) continue; try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {} }
  throw new Error(`未找到 ${name}，请在设置中指定本机 CLI 的绝对路径。`);
}
export function childEnv() {
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}` };
  for (const k of ['NODE_OPTIONS', 'NODE_PATH', 'DAYLIGHT_QODER_TOKEN', 'DAYLIGHT_AI_TOKEN']) delete env[k];
  return env;
}
export class RPC {
  constructor(bin, args, cwd) {
    this.requests = new Map(); this.nextId = 0; this.buffer = ''; this.stderr = '';
    this.child = spawn(bin, args, { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
      if (this.buffer.length > 8_000_000) return this.close();
      let at;
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1);
        try {
          const r = JSON.parse(line);
          if (r.method) Promise.resolve(this.onMessage?.(r)).catch(() => { if (r.id !== undefined) this.send({ id: r.id, error: { code: -32603, message: '客户端处理失败' } }); });
          else if (this.requests.has(r.id)) { const p = this.requests.get(r.id); this.requests.delete(r.id); clearTimeout(p.timer); r.error ? p.reject(new Error(r.error.message)) : p.resolve(r.result); }
        } catch {}
      }
    });
    this.child.stderr.on('data', b => { this.stderr = (this.stderr + b).slice(-2000); });
    this.child.on('error', e => this.fail(e));
    this.child.on('exit', () => this.fail(new Error('CLI 进程已退出')));
    this.child.stdin.on('error', () => {});
  }
  fail(e) { for (const p of this.requests.values()) { clearTimeout(p.timer); p.reject(e); } this.requests.clear(); this.onExit?.(e); }
  send(value) { if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(value) + '\n'); }
  call(method, params = {}, timeout = 30000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.requests.delete(id); reject(new Error(`${method} 超时`)); }, timeout); this.requests.set(id, { resolve, reject, timer }); this.send({ id, method, params }); });
  }
  async initialize() { await this.call('initialize', { clientInfo: { name: 'daylight', version: '0.3.0' }, capabilities: { experimentalApi: true } }); this.send({ method: 'initialized' }); }
  close() { this.child.stdin.end(); this.child.kill('SIGTERM'); const timer = setTimeout(() => { if (this.child.exitCode === null) this.child.kill('SIGKILL'); }, 2000); timer.unref(); }
}
