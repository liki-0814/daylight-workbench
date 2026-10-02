import { generationConfig, toolConfig, reasoningEfforts, agyUsage } from './generation.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgyAuth } from './auth.js';
import { readJson, writeJson, serial } from '../shared/store.js';
import { SseParser } from '../shared/llm/sse.js';
const invalid = message => Object.assign(new Error(message), { status: 400, code: 'invalid_request' });

export function compileRequest(request, signatures = new Map(), model = {}) {
  const calls = new Map();
  const contents = request.messages.map(message => {
    const parts = [];
    if (message.role === 'assistant') for (const thought of message.thinkingBlocks || []) {
      if (!thought.signature) throw invalid('AGY 思考块回传需要原始 signature');
      parts.push({ text: thought.text, thought: true, thoughtSignature: thought.signature });
    }
    if (message.role === 'tool') {
      const call = calls.get(message.toolCallId);
      if (!call) throw invalid('工具结果缺少对应的 assistant tool_call');
      parts.push({ functionResponse: { id: message.toolCallId, name: call.name, response: { result: message.content } } });
    } else {
      for (const part of typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content || []) {
        if (part.type === 'text' && part.text) parts.push({ text: part.text });
        else if (part.type === 'image') {
          const match = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(part.url);
          if (!match) throw invalid('AGY 图片需使用 base64 data URL');
          parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
        }
      }
      for (const call of message.toolCalls || []) {
        calls.set(call.id, call);
        let args; try { args = JSON.parse(call.arguments || '{}'); } catch { throw invalid('工具参数必须是 JSON'); }
        const saved = signatures.get(call.id);
        if (saved && (saved.name !== call.name || saved.args !== JSON.stringify(args))) throw invalid('工具调用内容与原始签名不匹配');
        parts.push({ functionCall: { id: call.id, name: call.name, args }, ...(saved?.signature ? { thoughtSignature: saved.signature } : {}) });
      }
    }
    return { role: message.role === 'assistant' ? 'model' : 'user', parts };
  }).filter(message => message.parts.length);
  if (!contents.length) throw invalid('需要非空消息');
  const body = { contents, generationConfig: generationConfig(request, model) };
  if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };
  if (request.tools?.length) body.tools = [{ functionDeclarations: request.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
  const config = toolConfig(request);
  if (config) body.toolConfig = config;
  return body;
}

export class AgyProvider {
  constructor({ dataDir, fetchImpl = fetch, auth = new AgyAuth() }) {
    Object.assign(this, { fetchImpl, auth });
    this.file = path.join(dataDir, 'agy/settings.json'); this.signatures = new Map(); this.mutate = serial();
  }
  async call(method, body, signal) {
    const token = await this.auth.token();
    const response = await this.fetchImpl(`https://daily-cloudcode-pa.googleapis.com/v1internal:${method}`, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'antigravity' }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(45000) });
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`AGY 上游请求失败（${response.status}）`), { code: String(response.status) }); }
    return response;
  }
  async catalog(force = false) {
    if (!force && this.cache && Date.now() - this.cache.at < 300000) return this.cache;
    if (!this.loading) this.loading = (async () => {
      const account = await (await this.call('loadCodeAssist', {})).json();
      const project = typeof account.cloudaicompanionProject === 'string' ? account.cloudaicompanionProject : account.cloudaicompanionProject?.id;
      if (!project) throw new Error('AGY 账号尚未完成开通，请先在 agy 中完成登录');
      const catalog = await (await this.call('fetchAvailableModels', { project })).json();
      // The CLI expands tiered models and applies local model aliases. Its live catalog
      // is authoritative for public IDs; the upstream catalog supplies capabilities.
      const discovered = await this.auth.models();
      let models = discovered.map(({ id, displayName }) => {
        const tiered = id.replace(/-(low|medium|high)$/, '-tiered');
        const upstreamId = tiered !== id && catalog.models?.[tiered] ? tiered : id === 'gemini-3.1-pro-high' && catalog.models?.['gemini-pro-agent'] ? 'gemini-pro-agent' : id;
        const m = catalog.models?.[upstreamId] || catalog.models?.[id] || {};
        const model = { id, provider: 'agy', displayName, enabled: true, source: 'agy', isVL: !!m.supportsImages, isReasoning: !!m.supportsThinking, reasoningEfforts: [], contextWindows: [], maxInputTokens: m.maxTokens, maxOutputTokens: m.maxOutputTokens, quota: m.quotaInfo, thinkingBudget: m.thinkingBudget, upstreamId };
        model.reasoningEfforts = reasoningEfforts(model);
        return model;
      });
      // Merge Gemini presets by base ID, independent of model version.
      const groups = new Map();
      for (const model of models) {
        const match = /^(gemini-.+)-(low|medium|high|xhigh|max)$/.exec(model.id);
        if (!match || !model.isReasoning) continue;
        const group = groups.get(match[1]) || [];
        group.push({ ...model, level: match[2] }); groups.set(match[1], group);
      }
      for (const [id, variants] of groups) {
        if (variants.length < 2) continue;
        const levels = ['low', 'medium', 'high', 'xhigh', 'max'].filter(level => variants.some(m => m.level === level));
        const defaultEffort = levels.includes('medium') ? 'medium' : levels.includes('high') ? 'high' : levels[0];
        const template = variants.find(m => m.level === defaultEffort);
        const variantIds = variants.map(m => m.id);
        const effortRoutes = Object.fromEntries(variants.map(m => [m.level, { upstreamId: m.upstreamId, thinkingBudget: m.thinkingBudget }]));
        const unified = { ...template, id, displayName: template.displayName.replace(/\s*\((?:low|medium|high|xhigh|max)\)\s*$/i, ''), defaultEffort, variantIds, effortRoutes, reasoningEfforts: levels };
        const first = models.findIndex(m => variantIds.includes(m.id));
        models = models.filter(m => !variantIds.includes(m.id)); models.splice(first, 0, unified);
      }
      this.cache = { at: Date.now(), project, models }; return this.cache;
    })().finally(() => { this.loading = null; });
    return this.loading;
  }
  async listModels(force = false) {
    const { models } = await this.catalog(force), settings = await readJson(this.file, { disabled: [] });
    return models.map(m => ({ ...m, enabled: !settings.disabled.includes(m.id) && !(m.variantIds?.every(id => settings.disabled.includes(id))), effort: settings.efforts?.[m.id] }));
  }
  async quota() {
    const { project } = await this.catalog();
    const data = await (await this.call('retrieveUserQuotaSummary', { project })).json();
    return { groups: data.groups || [], updatedAt: new Date().toISOString() };
  }
  async setModel({ id, field, value }) {
    if (!['enabled', 'effort'].includes(field)) throw invalid('不支持的模型设置');
    return this.mutate(async () => {
      const model = (await this.listModels()).find(m => m.id === id);
      if (!model) throw invalid('模型不存在');
      if (field === 'enabled' && typeof value !== 'boolean') throw invalid('enabled 必须为布尔值');
      if (field === 'effort' && value !== 'auto' && !model.reasoningEfforts.includes(value)) throw invalid('不支持的推理强度');
      const settings = await readJson(this.file, { disabled: [] });
      if (field === 'enabled') {
        const disabled = new Set(settings.disabled);
        if (value) { disabled.delete(id); for (const variant of model.variantIds || []) disabled.delete(variant); } else disabled.add(id);
        settings.disabled = [...disabled];
      } else {
        settings.efforts ||= {};
        if (value === 'auto') delete settings.efforts[id]; else settings.efforts[id] = value;
      }
      await writeJson(this.file, settings); return this.listModels();
    });
  }
  async *stream(request, { signal, observe = () => {} } = {}) {
    try {
      observe({stage:'discovery'});
      const model = (await this.listModels()).find(m => m.id === request.model && m.enabled);
      if (!model) throw invalid('模型不存在或已停用');
      observe({stage:'conversion'});
      const inner = compileRequest(request, this.signatures, model);
      const route = model.effortRoutes?.[request.options.reasoningEffort || model.effort || model.defaultEffort];
      observe({stage:'upstream',upstreamModel:route?.upstreamId || model.upstreamId});
      const response = await this.call('streamGenerateContent?alt=sse', { project: this.cache.project, model: route?.upstreamId || model.upstreamId, userAgent: 'antigravity', requestId: randomUUID(), request: inner }, signal);
      observe({stage:'response',upstreamStatus:response.status});
      const parser = new SseParser(), decoder = new TextDecoder(), reader = response.body.getReader();
      let finished = false, index = 0, usageMetadata = {};
      try {
        for (;;) {
          const chunk = await reader.read();
          const frames = chunk.done ? [...parser.push(decoder.decode()), ...parser.flush()] : parser.push(decoder.decode(chunk.value, { stream: true }));
          for (const frame of frames) {
            if (!frame.data || frame.data === '[DONE]') continue;
            const envelope = JSON.parse(frame.data), data = envelope.response || envelope;
            if (data.error || envelope.error) throw new Error('AGY 上游返回流错误');
            for (const candidate of data.candidates || []) {
              for (const part of candidate.content?.parts || []) {
                if (part.text) yield { type: part.thought ? 'reasoning' : 'text', delta: part.text };
                if (part.thoughtSignature && !part.functionCall) yield { type: 'reasoning_signature', signature: part.thoughtSignature };
                if (part.functionCall) {
                  const call = part.functionCall, id = call.id || `call_${randomUUID()}`;
                  this.signatures.set(id, { name: call.name, args: JSON.stringify(call.args || {}), signature: part.thoughtSignature });
                  while (this.signatures.size > 1000) this.signatures.delete(this.signatures.keys().next().value);
                  yield { type: 'tool_call', index: index++, id, name: call.name, argumentsDelta: JSON.stringify(call.args || {}) };
                }
              }
              if (candidate.finishReason) { finished = true; yield { type: 'finish', reason: candidate.finishReason === 'MAX_TOKENS' ? 'length' : candidate.finishReason === 'STOP' ? 'stop' : 'content_filter' }; }
            }
            const u = data.usageMetadata;
            if (u) {
              usageMetadata = { ...usageMetadata, ...Object.fromEntries(Object.entries(u).filter(([, value]) => Number.isFinite(value) && value >= 0)) };
              yield { type: 'usage', usage: agyUsage(usageMetadata) };
            }
          }
          if (chunk.done) break;
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (!finished) yield { type: 'error', code: 'incomplete_stream', message: 'AGY 上游连接提前结束' };
    } catch (error) {
      if (signal?.aborted) throw error;
      yield { type: 'error', code: error.code || 'upstream_error', message: error.status ? error.message : 'AGY 请求失败，请检查本机登录状态与网络' };
    }
  }
}
