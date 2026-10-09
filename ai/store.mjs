import { finishEvents } from './events.mjs';
import fs from 'node:fs';
import path from 'node:path';
export class AIStore {
  constructor(dataDir) {
    this.root = path.join(dataDir, 'ai');
    fs.mkdirSync(path.join(this.root, 'conversations'), { recursive: true, mode: 0o700 });
    this.settings = this.read('settings.json', { backend: 'codex', codex: { path: '', model: '', effort: '', contextWindow: null }, qoder: { path: '', model: '', effort: '', contextWindow: null, maxOutputTokens: null } });
    this.conversations = new Map();
    for (const file of fs.readdirSync(path.join(this.root, 'conversations'))) {
      if (!/^[a-f0-9-]+\.json$/.test(file)) continue;
      const c = this.read(`conversations/${file}`);
      if (['running', 'waiting'].includes(c.status)) { finishEvents(c); c.status = 'interrupted'; c.pending = null; c.error = '上次运行已中断，可以继续发送消息。'; }
      if (c.focusSubmission) {
        if (c.focusSubmission.status === 'submitted') c.focusSubmission.status = 'unknown';
        delete c.focusSubmission.applying;
        // A submission is durable; an unapproved pending card is only run-local.
        if (c.pending?.type === 'focusChanges') c.pending = null;
      }
      this.conversations.set(c.id, c);
    }
  }
  read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(path.join(this.root, file), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
  }
  write(file, value) {
    const target = path.join(this.root, file), tmp = target + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(tmp, target);
  }
  save(c) { c.updatedAt = new Date(Math.max(Date.now(), (Date.parse(c.updatedAt) || 0) + 1)).toISOString(); this.conversations.set(c.id, c); this.write(`conversations/${c.id}.json`, c); }
  remove(id) { fs.unlinkSync(path.join(this.root, 'conversations', `${id}.json`)); this.conversations.delete(id); }
  workspace(backend) { const dir = path.join(this.root, 'workspaces', backend); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; }
}
