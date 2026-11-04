import { finishEvents } from './events.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export class AIStore {
  constructor(dataDir, prepareWorkspace = () => {}) {
    this.prepareWorkspace = prepareWorkspace;
    this.root = path.join(dataDir, 'ai');
    fs.mkdirSync(path.join(this.root, 'conversations'), { recursive: true, mode: 0o700 });
    this.settings = this.read('settings.json', { backend: 'codex', codex: { path: '', model: '', effort: '', contextWindow: null }, qoder: { path: '', model: '', effort: '', contextWindow: null, maxOutputTokens: null } });
    this.settings.pi ||= { path: '', model: '', effort: '', contextWindow: null, accessMode: 'standard' };
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
      if (c.extensionSubmission) {
        if (c.extensionSubmission.status === 'submitted') c.extensionSubmission.status = 'unknown';
        delete c.extensionSubmission.applying;
        if (c.pending?.type === 'extensionChanges') c.pending = null;
      }
    }
  }
  read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(path.join(this.root, file), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
  }
  write(file, value) {
    const target = path.join(this.root, file), tmp = target + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, target);
    } finally { fs.rmSync(tmp, { force: true }); }
  }
  save(c) {
    const file = `conversations/${c.id}.json`, previousTime = c.updatedAt;
    c.updatedAt = new Date(Math.max(Date.now(), (Date.parse(previousTime) || 0) + 1)).toISOString();
    try { this.write(file, c); }
    catch (cause) {
      // Existing callers hold the same mutable object as the map. Restore it in
      // place on failure so a rejected write cannot remain a successful edit.
      try {
        const saved = this.read(file);
        for (const key of Object.keys(c)) delete c[key];
        Object.assign(c, saved);
      } catch (readError) {
        c.updatedAt = previousTime;
        if (readError.code === 'ENOENT') this.conversations.delete(c.id);
      }
      throw Object.assign(new Error('对话保存失败，原文件已保留，请检查磁盘空间和目录权限', {cause}), {code:'EAI_STORAGE',status:503});
    }
    this.conversations.set(c.id, c);
  }
  remove(id) { fs.unlinkSync(path.join(this.root, 'conversations', `${id}.json`)); this.conversations.delete(id); }
  workspace(backend) { const dir = path.join(this.root, 'workspaces', backend); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); this.prepareWorkspace(backend, dir); return dir; }
}
