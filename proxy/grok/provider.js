import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GrokAuth, authError } from './auth.js';
import { compileRequest, decodeStream, invalid } from './responses.js';
import { readJson, writeJson, serial } from '../shared/store.js';

const ORIGIN = 'https://cli-chat-proxy.grok.com/v1';
export class GrokProvider {
  constructor({ dataDir, fetchImpl = fetch, auth = new GrokAuth() }) {
    Object.assign(this, { fetchImpl, auth });
    this.directory = path.join(dataDir, 'grok'); this.mutate = serial(); this.active = 0;
  }
  async call(endpoint, body, signal, credential, retried = false, observe = () => {}) {
    const a = credential || await this.auth.credential();
    const id = randomUUID();
    // Timeout waiting for headers; streamed bodies use an idle deadline instead.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Grok 连接超时')), 300000);
    let response;
    observe({stage:'upstream'});
    try { response = await this.fetchImpl(`${ORIGIN}/${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${a.token}`, 'X-XAI-Token-Auth': 'xai-grok-cli', 'x-grok-client-identifier': 'grok-shell', 'x-grok-client-version': a.version,
        'Content-Type': 'application/json', Accept: body ? 'text/event-stream' : 'application/json', 'x-grok-req-id': id, ...(body ? { 'x-grok-model-override': body.model } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: body ? AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]) : AbortSignal.timeout(30000),
    }); } finally { clearTimeout(timer); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) {
        if (retried) throw authError();
        observe({stage:'authentication',retries:1});
        const fresh = await this.auth.credential(true);
        if (fresh.token !== a.token && fresh.identity === a.identity) return this.call(endpoint, body, signal, fresh, true, observe);
        throw authError();
      }
      throw Object.assign(new Error(response.status === 429 ? 'Grok 额度或请求频率受限，请稍后重试' : `Grok 上游请求失败（${response.status}）`), { code: String(response.status) });
    }
    return response;
  }
  async catalog(force = false) {
    const a = await this.auth.credential();
    if (this.cache?.identity !== a.identity) this.cache = null;
    if (!this.cache) {
      const cached = await readJson(path.join(this.directory, 'catalog.json'), null);
      if (cached?.identity === a.identity && cached.schemaVersion === 1 && Array.isArray(cached.models)) this.cache = cached;
    }
    if (!force && this.cache && Date.now() - this.cache.at < 300000) return this.cache;
    if (!this.loading || this.loadingIdentity !== a.identity) {
      this.loadingIdentity = a.identity;
      const task = (async () => {
        const data = await (await this.call('models', undefined, undefined, a)).json();
        if (!Array.isArray(data.data)) throw new Error('invalid model catalog');
        const models = data.data.filter(m => m.api_backend === 'responses' && !m.hidden).map(m => ({
          id: m.id, provider: 'grok', source: 'grok', displayName: m.name || m.id, enabled: true,
          contextWindows: [], contextWindow: m.context_window, maxOutputTokens: m.max_completion_tokens ?? undefined,
          isVL: true, isReasoning: !!m.supports_reasoning_effort,
          reasoningEfforts: (m.reasoning_efforts || []).map(e => e.value ?? e.id), defaultEffort: m.reasoning_effort,
          capabilities: { tools: true, structuredOutput: true, parallelTools: true, nativeResponses: true, nativeSearch: !!m.supports_backend_search, vision: true, statefulResponses: false, output_limit_excludes_reasoning: true },
        }));
        const cache = { schemaVersion: 1, at: Date.now(), identity: a.identity, models };
        // A credential switch during discovery must not overwrite the new account's cache.
        if ((await this.auth.credential()).identity === a.identity) { this.cache = cache; await writeJson(path.join(this.directory, 'catalog.json'), cache); }
        return cache;
      })();
      this.loading = task;
      task.finally(() => { if (this.loading === task) this.loading = null; }).catch(() => {});
    }
    return this.loading;
  }
  async listModels(force = false) {
    const cache = await this.catalog(force), settings = await readJson(path.join(this.directory, 'settings.json'), { disabled: [] });
    return cache.models.map(m => ({ ...m, enabled: !settings.disabled.includes(m.id), effort: settings.efforts?.[m.id], defaultMaxTokens: settings.maxTokens?.[m.id] }));
  }
  async status(force = false) {
    try { await this.listModels(force); this.lastError = null; return { connected: true, discoveredAt: new Date(this.cache.at).toISOString(), authMode: 'cli_oauth' }; }
    catch (e) { this.lastError = e.code === 'source_auth_required' ? e.message : 'Grok 无法连接，请检查登录状态与网络'; return { connected: false, error: this.lastError }; }
  }
  async quota() {
    const a = await this.auth.credential();
    if (this.quotaCache?.identity === a.identity && Date.now() - this.quotaCache.at < 60000) return this.quotaCache.result;
    if (!this.quotaLoading || this.quotaIdentity !== a.identity) {
      this.quotaIdentity = a.identity;
      const task = (async () => {
      const { config } = await (await this.call('billing?format=credits', undefined, undefined, a)).json();
      const result = { available: !!config, updatedAt: new Date().toISOString(),
        usedPercent: Number.isFinite(config?.creditUsagePercent) ? config.creditUsagePercent : undefined,
        period: config?.currentPeriod, shared: config?.isUnifiedBillingUser,
        message: config ? '账户订阅额度 · 包含其他 Grok 客户端使用' : '上游暂未提供订阅额度',
      };
      if ((await this.auth.credential()).identity === a.identity) this.quotaCache = { identity: a.identity, at: Date.now(), result };
      return result;
      })();
      this.quotaLoading = task;
      task.finally(() => { if (this.quotaLoading === task) this.quotaLoading = null; }).catch(() => {});
    }
    return this.quotaLoading;
  }
  async setModel({ id, field, value }) {
    return this.mutate(async () => {
      const model = (await this.listModels()).find(m => m.id === id);
      if (!model) throw invalid('模型不存在');
      const file = path.join(this.directory, 'settings.json'), settings = await readJson(file, { disabled: [] });
      if (field === 'enabled' && typeof value === 'boolean') settings.disabled = value ? settings.disabled.filter(x => x !== id) : [...new Set([...settings.disabled, id])];
      else if (field === 'effort' && (value === 'auto' || model.reasoningEfforts.includes(value))) { settings.efforts ||= {}; if (value === 'auto') delete settings.efforts[id]; else settings.efforts[id] = value; }
      else if (field === 'maxTokens' && (value === null || Number.isInteger(value) && value > 0 && (!model.maxOutputTokens || value <= model.maxOutputTokens))) { settings.maxTokens ||= {}; if (value === null) delete settings.maxTokens[id]; else settings.maxTokens[id] = value; }
      else throw invalid('不支持的模型设置值');
      await writeJson(file, settings); return this.listModels();
    });
  }
  async *stream(request, { signal, observe = () => {} } = {}) {
    if (this.active >= 4) { yield { type: 'error', code: '429', message: 'Grok 已有 4 个请求进行中，请稍后重试' }; return; }
    this.active++;
    try {
      observe({stage:'authentication'});
      const identity = (await this.auth.credential()).identity;
      observe({stage:'discovery'});
      const model = (await this.listModels()).find(m => m.id === request.model && m.enabled);
      if (!model) throw Object.assign(new Error('模型不存在或已停用'), { code: 'model_not_found' });
      observe({stage:'conversion'});
      const body = compileRequest(request, model), credential = await this.auth.credential();
      if (credential.identity !== identity) throw authError();
      observe({stage:'upstream',upstreamModel:body.model,upstreamProtocol:'responses'});
      const response=await this.call('responses', body, signal, credential, false, observe);
      observe({stage:'response',upstreamStatus:response.status});
      yield* decodeStream(response, model.id, signal, undefined, observe);
    } catch (e) {
      if (signal?.aborted) throw e;
      yield { type: 'error', code: e.code || 'upstream_error', message: e.code ? e.message : 'Grok 响应读取失败，请检查连接后重试', param: e.param };
    } finally { this.active--; }
  }
}
