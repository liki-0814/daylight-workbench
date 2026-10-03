import {parseModels} from './models.js';
import {grokQuota} from './quota.js';
import {decodeRequest} from '../shared/protocol.js';
import {CatalogCache} from '../shared/catalog-cache.js';
import {sourceSnapshot,modelCapabilities} from '../shared/contracts.js';
import {modelSettings,applyModelSettings} from '../shared/model-settings.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GrokAuth, authError } from './auth.js';
import { compileRequest, decodeStream, invalid,renderNativeStream,renderNativeResponse } from './protocol.js';
import { readJson, writeJson } from '../shared/store.js';

const ORIGIN = 'https://cli-chat-proxy.grok.com/v1';
export class GrokProvider {
  async listModels(force=false){return modelCapabilities(await this.catalogModels(typeof force==='object'?force.refresh===true:force),['enabled', 'effort', 'maxTokens']);}
  close(){this.catalogCache.invalidate();this.quotaCatalogCache.invalidate();}
  async execute({raw,protocol},context){const request=decodeRequest(raw,protocol);return{kind:'events',renderers:{responses:[renderNativeStream,renderNativeResponse]},headerTimeoutOnly:true,events:this.stream(request,context)};}
  snapshot(){return sourceSnapshot({id:'grok',name:'Grok',identityKey:this.auth.identity,configured:true,connected:!!this.cache&&!this.lastError,error:this.lastError,checkedAt:this.cache?.at,authentication:{mode:'local',operations:['refresh']},capabilities:{quota:true,editableSource:false},nativeProtocols:['responses']});}
  constructor({ dataDir, fetchImpl = fetch, auth = new GrokAuth() }) {
    Object.assign(this, { fetchImpl, auth });
    this.directory = path.join(dataDir, 'grok'); this.active = 0;this.catalogCache=new CatalogCache();this.quotaCatalogCache=new CatalogCache(60000); this.settings=modelSettings(path.join(this.directory,'settings.json'));
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
  get cache(){return this.catalogCache.value;}
  async catalog(force = false) {
    const a = await this.auth.credential();
    if(!this.cache||this.cache.identity!==a.identity){
      const cached=await readJson(path.join(this.directory,'catalog.json'),null);
      if(cached?.schemaVersion===1&&Array.isArray(cached.models))this.catalogCache.seed(cached,a.identity);
    }
    return this.catalogCache.get({identity:a.identity,refresh:force,load:async()=>{
        const data = await (await this.call('models', undefined, undefined, a)).json();
        const models=parseModels(data);
        if((await this.auth.credential()).identity!==a.identity)throw authError();
        return {schemaVersion:1,models};
      },commit:async cache=>{
        if((await this.auth.credential()).identity!==a.identity)throw authError();
        await writeJson(path.join(this.directory,'catalog.json'),cache);
      }});
  }
  async catalogModels(force=false) {
    const cache = await this.catalog(force), settings = await readJson(path.join(this.directory, 'settings.json'), { disabled: [] });
    return applyModelSettings(cache.models, settings);
  }
  async status(force = false) {
    try { await this.listModels(force); this.lastError = null; return { connected: true, discoveredAt: new Date(this.cache.at).toISOString(), authMode: 'cli_oauth' }; }
    catch (e) { this.lastError = e.code === 'source_auth_required' ? e.message : 'Grok 无法连接，请检查登录状态与网络'; return { connected: false, error: this.lastError }; }
  }
  async quota() {
    const a=await this.auth.credential();
    const cached=await this.quotaCatalogCache.get({identity:a.identity,load:async()=>{
      const payload=await (await this.call('billing?format=credits',undefined,undefined,a)).json();
      if((await this.auth.credential()).identity!==a.identity)throw authError();
      return {result:grokQuota(payload)};
    }});
    return cached.result;
  }

  async setModel(input) {
    const model=(await this.listModels()).find(m=>m.id===input.id);if(!model)throw invalid('模型不存在');
    await this.settings.save(model,input,{fields:['contextWindow', 'maxOutputTokens', 'enabled', 'effort', 'maxTokens'],invalid,error:'不支持的模型设置值'});return this.listModels();
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
