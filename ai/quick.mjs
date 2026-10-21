import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { httpError } from './http.mjs';
import { aiBackends } from '../core/ai-backends.js';
import { validateImages } from './images.mjs';

export const quickInstructions = '这是一次临时单轮问答。直接回答当前问题，不要求用户继续回复；信息不足时说明假设。只提供答案，不调用工具、不读写文件、不执行命令。';

// Deliberately separate from AIStore: neither prompts nor replies are persisted.
export function createQuickAnswers({ store, providers }) {
  const jobs = new Map(), tasks = new Set();
  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return;
    jobs.delete(id); job.controller.abort(); job.text = ''; job.error = '';
  }
  const reap = setInterval(() => {
    for (const [id, job] of jobs) if (Date.now() - job.seen > 30_000 || Date.now() - job.started > 300_000) cancel(id);
  }, 5000);
  reap.unref();
  function start(input) {
    if (input.backend !== undefined || input.model !== undefined) throw httpError('请在设置中统一选择 AI 后端和默认模型');
    const images = validateImages(input.images);
    if (typeof input.text !== 'string' || !input.text.trim() && !images.length || input.text.length > 30000) throw httpError('请输入 1–30000 字的问题，或粘贴图片');
    const text = input.text.trim() || '请描述并分析这些图片。';
    if (jobs.size) throw httpError('请先关闭当前临时问答', 409);
    const backend = store.settings.backend;
    if (!aiBackends.some(item => item.id === backend) || !providers[backend] || !store.settings[backend]) throw httpError('不支持的 AI 后端');
    const config = structuredClone(store.settings[backend]);
    if (!providers[backend] || !config?.model) throw httpError('请先在设置中选择 AI 后端和默认模型');
    const cwd = mkdtempSync(path.join(tmpdir(), 'daylight-quick-'));
    const id = randomUUID(), controller = new AbortController();
    const job = { controller, backend, model: config.model, text: '', error: '', status: 'running', started: Date.now(), seen: Date.now() };
    jobs.set(id, job);
    job.done = (async () => {
      try {
        await providers[backend].run({
          conversation: { id, backend, config, sessionId: null }, cwd, text, images, ephemeral: true,
          signal: controller.signal, setSession() {},
          ask: async () => { throw new Error('临时问答不支持追问，请重新提出完整问题'); }, approve: async () => false,
          emit: event => { if (!controller.signal.aborted && event.type === 'delta') job.text = (job.text + event.text).slice(0, 500000); },
        });
      } catch (error) { if (!controller.signal.aborted) job.error = error.message; }
      finally {
        try { await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
        catch { job.error ||= '临时工作目录清理失败'; }
        job.status = job.error ? 'error' : 'done';
      }
    })();
    tasks.add(job.done); void job.done.finally(() => tasks.delete(job.done));
    return { id, backend, model: config.model };
  }
  function get(id) {
    const job = jobs.get(id);
    if (!job) throw httpError('临时问答已结束', 404);
    job.seen = Date.now();
    const result = { status: job.status, text: job.text, error: job.error };
    // Once delivered, the answer belongs only to the visible palette.
    if (job.status !== 'running') { jobs.delete(id); job.text = ''; job.error = ''; }
    return result;
  }
  return { start, get, cancel, async close() { clearInterval(reap); for (const id of jobs.keys()) cancel(id); await Promise.allSettled([...tasks]); } };
}
