import {parseModels} from './models.js';
import {agyQuota} from './quota.js';
import {decodeRequest} from '../shared/protocol.js';
import {CatalogCache} from '../shared/catalog-cache.js';
import {sourceSnapshot,modelCapabilities} from '../shared/contracts.js';
import {modelSettings,applyCapacitySettings} from '../shared/model-settings.js';
import { compileRequest, agyUsage } from './protocol.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgyAuth } from './auth.js';
import { readJson } from '../shared/store.js';
import { SseParser } from '../shared/llm/sse.js';
const invalid = message => Object.assign(new Error(message), { status: 400, code: 'invalid_request' });

export class AgyProvider {
  async listModels(force=false){return modelCapabilities(await this.catalogModels(typeof force==='object'?force.refresh===true:force),['enabled', 'effort']);}
  close(){this.catalogCache.invalidate();this.signatures.clear();}
  async execute({raw,protocol},context){const request=decodeRequest(raw,protocol);return{kind:'events',events:this.stream(request,context)};}
  snapshot(){return sourceSnapshot({id:'agy',name:'AGY',identityKey:this.auth.identity,configured:true,connected:!!this.cache&&!this.lastError,error:this.lastError,checkedAt:this.cache?.at,authentication:{mode:'local',operations:['refresh']},capabilities:{quota:true,editableSource:false},nativeProtocols:['messages']});}
  constructor({ dataDir, fetchImpl = fetch, auth = new AgyAuth() }) {
    Object.assign(this, { fetchImpl, auth });
    this.file = path.join(dataDir, 'agy/settings.json'); this.catalogCache=new CatalogCache();this.signatures = new Map(); this.settings=modelSettings(this.file);
  }
  get cache(){return this.catalogCache.value;}
  async call(method, body, signal) {
    const token = await this.auth.token();
    const response = await this.fetchImpl(`https://daily-cloudcode-pa.googleapis.com/v1internal:${method}`, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'antigravity' }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(45000) });
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`AGY 上游请求失败（${response.status}）`), { code: String(response.status) }); }
    return response;
  }
  async catalog(force = false) {
    await this.auth.token();const identity=this.auth.identity;
    return this.catalogCache.get({identity,refresh:force,load:async()=>{
      const account = await (await this.call('loadCodeAssist', {})).json();
      const project = typeof account.cloudaicompanionProject === 'string' ? account.cloudaicompanionProject : account.cloudaicompanionProject?.id;
      if (!project) throw new Error('AGY 账号尚未完成开通，请先在 agy 中完成登录');
      const catalog = await (await this.call('fetchAvailableModels', { project })).json();
      // The CLI expands tiered models and applies local model aliases. Its live catalog
      // is authoritative for public IDs; the upstream catalog supplies capabilities.
      const discovered = await this.auth.models();
      const models=parseModels(discovered,catalog);
      await this.auth.token();if(this.auth.identity!==identity)throw Object.assign(new Error('AGY 账号已切换，请重新请求'),{status:401});
      return {project,models};
    }});
  }
  async catalogModels(force=false) {
    const { models } = await this.catalog(force), settings = await readJson(this.file, { disabled: [] });
    return applyCapacitySettings(models,settings).map(m => ({ ...m, enabled: !(settings.disabled||[]).includes(m.id) && !(m.variantIds?.every(id => (settings.disabled||[]).includes(id))), effort: settings.efforts?.[m.id] }));
  }
  async status(){try{await this.listModels(true);this.lastError=null;return{connected:true};}catch{this.lastError='无法连接 AGY，请在终端运行 agy 登录后刷新';return{connected:false,error:this.lastError};}}
  async quota() {
    const { project } = await this.catalog();
    const data = await (await this.call('retrieveUserQuotaSummary', { project })).json();
    return agyQuota(data);
  }
  async setModel(input) {
    const model=(await this.listModels()).find(m=>m.id===input.id);if(!model)throw invalid('模型不存在');
    if(input.field==='enabled'&&typeof input.value!=='boolean')throw invalid('enabled 必须为布尔值');
    if(input.field==='effort'&&input.value!=='auto'&&!model.reasoningEfforts.includes(input.value))throw invalid('不支持的推理强度');
    await this.settings.save(model,input,{fields:['contextWindow', 'maxOutputTokens', 'enabled', 'effort'],invalid,error:'不支持的模型设置',enableIds:model.variantIds||[]});return this.listModels();
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
