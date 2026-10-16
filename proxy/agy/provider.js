import {bindAccountCatalog,checkAccountCatalog} from '../shared/account-catalog.js';
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

export const sourceDescription = {id:'agy',name:'AGY',authentication:{mode:'browser',operations:['login','poll','cancel','refresh','logout'],instruction:'Google 网页登录 · 无需 CLI'},capabilities:{quota:true,editableSource:false},nativeProtocols:['messages']};

export class AgyProvider {
  async listModels(force=false){return modelCapabilities(await this.catalogModels(typeof force==='object'?force.refresh===true:force),['enabled', 'effort']);}
  close(){this.catalogCache.invalidate();this.signatures.clear();this.auth.close?.();}
  async execute({raw,protocol},context){const request=decodeRequest(raw,protocol);return{kind:'events',events:this.stream(request,context)};}
  snapshot(){return{...sourceSnapshot({...sourceDescription,identityKey:this.auth.identity,configured:!!this.auth.account,connected:!!this.cache&&this.cache.identity===this.auth.identity&&!this.lastError,error:this.lastError,checkedAt:this.cache?.at}),account:this.auth.account?{login:this.auth.account.login}:undefined};}
  constructor({ dataDir, fetchImpl = fetch, auth }) {
    Object.assign(this, { fetchImpl, auth:auth||new AgyAuth({dataDir,fetchImpl}) });
    this.file = path.join(dataDir, 'agy/settings.json'); this.catalogCache=new CatalogCache();this.signatures = new Map(); this.settings=modelSettings(this.file);bindAccountCatalog(this,{reset:()=>this.signatures.clear()});
  }
  get cache(){return this.catalogCache.value;}
  async call(method, body, signal, owner) {
    const token = await this.auth.token();
    if(owner&&(owner.identity!==this.auth.identity||owner.epoch!==this.auth.epoch))throw Object.assign(Error('AGY 账号已切换，请重新请求'),{status:401});
    // Catalog metadata and CLI generation use different services. The hub client
    // version selects the generation routing contract, including public preset IDs.
    const generating = method.startsWith('streamGenerateContent');
    const host = generating ? 'daily-cloudcode-pa.googleapis.com' : 'cloudcode-pa.googleapis.com';
    const response = await this.fetchImpl(`https://${host}/v1internal:${method}`, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'antigravity/hub/2.8.0' }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(45000) });
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(response.status===403?'AGY 账号权限或资格检查未通过，请在官方页面核验账号':`AGY 上游请求失败（${response.status}）`), { code: response.status===403?'EAGY_PERMISSION':String(response.status),status:response.status }); }
    return response;
  }
  async catalog(force = false) {
    await this.auth.token();const identity=this.auth.identity,epoch=this.auth.epoch;
    return this.catalogCache.get({identity,refresh:force,load:async()=>{
      const account = await (await this.call('loadCodeAssist', {},undefined,{identity,epoch})).json();
      const project = typeof account.cloudaicompanionProject === 'string' ? account.cloudaicompanionProject : account.cloudaicompanionProject?.id;
      if (!project) throw Object.assign(new Error('AGY 账号尚未完成开通，请在 Google 官方页面完成账号开通后刷新'),{code:'EAGY_ONBOARDING'});
      const catalog = await (await this.call('fetchAvailableModels', { project },undefined,{identity,epoch})).json();
      const discovered = await this.auth.models(catalog);
      const models=parseModels(discovered,catalog);
      await this.auth.token();if(this.auth.identity!==identity||this.auth.epoch!==epoch)throw Object.assign(new Error('AGY 账号已切换，请重新请求'),{status:401});
      return {project,models};
    }});
  }
  async catalogModels(force=false) {
    const { models } = await this.catalog(force), settings = await readJson(this.file, { disabled: [] });
    return applyCapacitySettings(models,settings).map(m => ({ ...m, enabled: !(settings.disabled||[]).includes(m.id) && !(m.variantIds?.every(id => (settings.disabled||[]).includes(id))), effort: settings.efforts?.[m.id] }));
  }
  async status(force=false){return checkAccountCatalog(this,force,{error:e=>e.code?.startsWith('EAGY_')||e.status===401?e.message:'无法连接 AGY，请检查登录状态、账号资格或网络'});}
  async quota() {
    const epoch=this.auth.epoch,{ project,identity } = await this.catalog();
    const data = await (await this.call('retrieveUserQuotaSummary', { project },undefined,{identity,epoch})).json();
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
      const epoch=this.auth.epoch;
      const model = (await this.listModels()).find(m => m.id === request.model && m.enabled);
      if (!model) throw invalid('模型不存在或已停用');
      const identity=this.cache?.identity;if(epoch!==this.auth.epoch)throw Object.assign(Error('AGY 账号已切换，请重新请求'),{status:401});
      observe({stage:'conversion'});
      const inner = compileRequest(request, this.signatures, model);
      const route = model.effortRoutes?.[request.options.reasoningEffort || model.effort || model.defaultEffort];
      observe({stage:'upstream',upstreamModel:route?.upstreamId || model.upstreamId});
      const response = await this.call('streamGenerateContent?alt=sse', { project: this.cache.project, model: route?.upstreamId || model.upstreamId, userAgent: 'antigravity', requestId: randomUUID(), request: inner }, signal,{identity,epoch});
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
