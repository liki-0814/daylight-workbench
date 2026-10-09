import fs from 'node:fs';
import path from 'node:path';
import { AIStore } from './store.mjs';
import { body, send, httpError } from './http.mjs';
import { createConversations } from './conversations.mjs';
import { createRunManager } from './run-manager.mjs';
import { createDrafts } from './drafts.mjs';
import { createToolDispatch } from './tools/dispatch.mjs';
import { createFocusSubmissions } from './focus-submissions.mjs';
export { validateSettings } from './conversations.mjs';
export { validateAction } from './drafts.mjs';
export { referenceSnapshots } from './context.mjs';

export async function createAIService({ dataDir, endpoint, adapters } = {}) {
  const store = new AIStore(dataDir);
  const providers = adapters || { codex: await import('./adapters/codex.mjs'), qoder: await import('./adapters/qoder.mjs') };
  let closed = false, runtime, tool, focusSubmissions;
  async function api(route, input, params) {
    const token = fs.readFileSync(path.join(dataDir, 'agent-token'), 'utf8').trim();
    const url = new URL((typeof endpoint === 'function' ? endpoint() : endpoint) + '/api/v1/' + route);
    if (params) for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, value === true ? '1' : String(value));
    const res = await fetch(url, { method: input ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(route.startsWith('proxy/') ? 65000 : 15000) });
    const data = await res.json(); if (!res.ok) throw httpError(data.error || '工作台请求失败', res.status, { ...(data.code ? { code: data.code } : {}), ...(data.version !== undefined ? { version: data.version } : {}), ...(data.details ? { details: data.details } : {}) }); return data;
  }
  const conversations = createConversations({ store, providers, api, isRunning: id => runtime?.has(id), isFocusApplying: c => focusSubmissions?.isApplying(c) });
  focusSubmissions = createFocusSubmissions({ api, save: conversations.save, onResolved: (...args) => runtime?.resolveFocusSubmission(...args) });
  const drafts = createDrafts({ api, applyAI: conversations.applyAI, save: conversations.save, focusSubmissions });
  runtime = await createRunManager({ store, providers, api, discover: conversations.discover,
    getConversation: conversations.get, tool: (...args) => tool(...args), applyDraft: drafts.apply, isFocusApplying: focusSubmissions.isApplying });
  tool = createToolDispatch({ api, get: conversations.get, aiState: conversations.aiState, prepareAI: conversations.prepareAI, pending: runtime.pending });
  async function handle(req, res) {
    try {
      if (closed) throw httpError('AI 服务已停止', 503);
      const url = new URL(req.url, 'http://localhost'), route = url.pathname.replace('/api/ai', '');
      const input = req.method === 'POST' ? await body(req) : {};
      if(route==='/state'&&req.method==='GET')return send(res,200,conversations.aiState());
      if(route==='/actions'&&req.method==='POST') {
        if(typeof input.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestId)||typeof input.expectedVersion!=='string')throw httpError('需要合法的 requestId 和 expectedVersion');
        if(input.action?.type!=='ai.conversation.delete')throw httpError('此接口仅支持删除对话');
        return send(res,200,await conversations.applyAI({requestId:input.requestId,version:input.expectedVersion,action:input.action}));
      }
      if (route === '/settings') return send(res, 200, conversations.settings(req.method === 'POST' ? input : undefined));
      if (route === '/discover' && req.method === 'POST') {
        if (!providers[input.backend]) throw httpError('不支持的后端');
        return send(res, 200, await conversations.discover(input.backend, { ...store.settings[input.backend], path: input.path || '' }, input.force === true));
      }
      if (route === '/conversations') {
        if (req.method === 'POST') { const c = await conversations.newConversation(input); conversations.save(c); return send(res, 200, { conversation: c }); }
        return send(res, 200, await conversations.list(url));
      }
      const match = route.match(/^\/conversations\/([a-f0-9-]+)(?:\/(message|cancel|answer|model|scope|focus-submission))?$/);
      if (!match) throw httpError('接口不存在', 404);
      const c = conversations.get(match[1]);
      if (req.method === 'GET' && !match[2]) return send(res, 200, { conversation: await conversations.detail(c) });
      if (req.method !== 'POST') throw httpError('请求方法不支持', 405);
      if (match[2] === 'focus-submission') { await focusSubmissions.recover(c, input); }
      else if (match[2] === 'scope') await conversations.setScope(c, input);
      else if (match[2] === 'model') await conversations.setModel(c, input);
      else if (match[2] === 'message') await runtime.sendMessage(c, input);
      else if (match[2] === 'cancel') runtime.stop(c);
      else if (match[2] === 'answer') await runtime.answer(c, input);
      return send(res, 200, { conversation: c });
    } catch (e) { send(res, e.status || 400, { error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.version !== undefined ? { version: e.version } : {}), ...(e.details ? { details: e.details } : {}) }); }
  }
  return { handle, store, tool, async close() { closed = true; runtime.close(); } };
}
