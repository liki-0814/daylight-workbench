import path from 'node:path';
import { CreditsHistory } from './credits-history.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { sessionFromAccount } from './http.js';
import { refreshCredential } from './oauth.js';
import { fetchModels, parseModelRef } from './models.js';
import { fetchCredits } from './credits.js';
import { loadSettings, applySettings, resolveQueueRetry, queueRetryDelay } from './settings.js';
import { contextWindowRejection, effortRejection } from './llm/index.js';
import { SessionStore } from './session-lifecycle.js';
import { compileNativeBody, INFERENCE_PATH, INFERENCE_QUERY } from './native-body.js';
import { encodeBody } from './body-codec.js';
import { QoderDeframer, RETRYABLE_UPSTREAM_CODES } from './deframe.js';

export class QoderProvider {
  constructor(config, http, accounts) { Object.assign(this, { config, http, accounts }); this.sessions = new SessionStore(); this.creditsHistory = new CreditsHistory(path.join(path.dirname(config.accountFile), "credits-history.json")); }
  clear() { this.cache = null; this.sessions = new SessionStore(); }
  async ready() {
    return this.accounts.run(async () => {
      const account = await this.accounts.require();
      if (account.credential.expires < Date.now() + 60_000) {
        account.credential = await refreshCredential(this.http, account.credential);
        await this.accounts.save(account);
      }
      return account;
    });
  }
  async catalog(account, force = false) {
    if (force || !this.cache || this.cache.id !== account.id || Date.now() - this.cache.at > 300_000) {
      const models = await fetchModels(this.http, sessionFromAccount(this.config, account));
      this.cache = { id: account.id, at: Date.now(), models };
    }
    const settings = await loadSettings(this.config.accountFile);
    return { models: applySettings(this.cache.models, settings), settings };
  }
  async listModels(force = false) { return (await this.catalog(await this.ready(), force)).models; }
  async credits() {
    const account = await this.ready();
    const snapshot = await fetchCredits(this.http, sessionFromAccount(this.config, account));
    const identity = JSON.stringify([account.credential.uid, account.credential.organizationId, account.credential.organizationName]);
    try { return await this.creditsHistory.record(identity, snapshot); }
    catch { return { ...snapshot, history: [], historyError: '历史记录保存失败，当前额度仍可查看。' }; }
  }
  async *stream(request, { signal, observe = () => {} } = {}) {
    observe({stage:'authentication'});
    const account = await this.ready();
    observe({stage:'discovery'});
    const { models, settings } = await this.catalog(account);
    const ref = parseModelRef(request.model), model = models.find(m => m.id === ref.id);
    if (!model || !model.enabled) { yield { type: 'error', code: 'model_not_found', message: '模型不存在或已停用' }; return; }
    const contextLength = request.options.contextLength ?? ref.window ?? settings.context[ref.id];
    const reasoningEffort = request.options.reasoningEffort ?? model.effort;
    const issue = ref.invalidWindow ? '上下文窗口格式无效' : contextLength !== undefined && contextWindowRejection(model, contextLength) || reasoningEffort && effortRejection(model, reasoningEffort);
    if (issue) { yield { type: 'error', code: 'invalid_request', message: issue }; return; }
    observe({stage:'conversion',upstreamModel:model.id});
    const resolved = { ...request, options: { ...request.options, contextLength, reasoningEffort } };
    const session = sessionFromAccount(this.config, account);
    this.sessions.sweep();
    const state = this.sessions.derive(resolved, undefined, `${account.id}\0`);
    const retry = resolveQueueRetry(settings);
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      const body = compileNativeBody(resolved, { model, session: state, clientVersion: this.config.clientVersion, fast: model.fast, profile: session.profile });
      observe({stage:'upstream'});
      const response = await this.http.signedInference(new URL(`${INFERENCE_PATH}?${INFERENCE_QUERY}`, this.config.compatUrl).href, { session, encodedBody: encodeBody(body), modelKey: model.id, signal });
      observe({stage:'response',upstreamStatus:response.status});
      if (!response.ok) { await response.body?.cancel(); yield { type: 'error', code: String(response.status), message: `上游请求失败（${response.status}）`, retries: attempt }; return; }
      const deframer = new QoderDeframer(), decoder = new TextDecoder();
      let queued = false, produced = false, finished = false;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          const events = chunk.done ? [...deframer.push(decoder.decode()), ...deframer.flush()] : deframer.push(decoder.decode(chunk.value, { stream: true }));
          for (const event of events) {
            if (!produced && event.type === 'error' && RETRYABLE_UPSTREAM_CODES.has(event.code) && retry.enabled && attempt < retry.maxRetries) { queued = true; break; }
            produced = true;
            if (event.type === 'finish' || event.type === 'error') finished = true;
            // Do not relay raw upstream error strings: they can echo request bodies.
            yield event.type === 'error' ? { ...event, message: `Qoder 返回错误（${event.code || 'unknown'}）`, retries: attempt } : { ...event, retries: attempt };
            if (event.type === 'error') return;
          }
          if (queued || chunk.done) break;
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (!queued) {
        if (!finished) yield { type: 'error', code: 'incomplete_stream', message: '上游连接提前结束', retries: attempt };
        return;
      }
      observe({stage:'retry'});
      await sleep(queueRetryDelay(attempt + 1, retry), undefined, { signal });
    }
  }
}
