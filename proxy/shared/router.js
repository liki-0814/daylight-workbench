import { parseModelRef } from '../qoder/models.js';
import { readJson, writeJson, serial } from './store.js';
import { createHash } from 'node:crypto';

export const retryableRouteError = error => [401,403,404,408,429].includes(Number(error.status || error.code)) || Number(error.status || error.code) >= 500 && Number(error.status || error.code) <= 599 || ['upstream_error','10605','ECONNRESET','ECONNREFUSED','ETIMEDOUT'].includes(error.code) || ['TypeError','TimeoutError'].includes(error.name);
const bad = message => Object.assign(new Error(message), {status:400,code:'invalid_request'});
const minimum = values => values.every(v => Number.isFinite(v) && v > 0) ? Math.min(...values) : undefined;
const common = lists => (lists[0] || []).filter(v => lists.every(list => (list || []).includes(v)));

export class ModelRouter {
  constructor(providers, { cacheRoutesMs = 0, onCatalog = () => {}, routesFile, getSourceHealth = async () => [], retrySource } = {}) {
    this.providers = providers; this.onCatalog = onCatalog; this.cacheRoutesMs = cacheRoutesMs; this.routesFile = routesFile;
    this.errors = {}; this.conflicts = []; this.available = new Set(); this.catalogs = new Map(); this.failedAt = new Map();
    this.run = serial(); this.preferences = null; this.cooldowns = new Map(); this.sessions = new Map();
    this.known = new Set(); this.discoveries = new Map(); this.catalogVersions = new Map(); this.catalogRevision = 0;
    this.getSourceHealth = getSourceHealth; this.retrySource = retrySource;
  }
  async preferencesFor(groups) {
    if (!this.preferences) {
      this.preferences = this.routesFile ? await readJson(this.routesFile, {}) : {};
      if (!this.preferences || typeof this.preferences !== 'object' || Array.isArray(this.preferences) || Object.values(this.preferences).some(p => !Array.isArray(p?.order) || !Array.isArray(p?.excluded))) throw new Error('模型路由配置无效，原文件已保留');
    }
    let changed = false;
    for (const [id, models] of groups) {
      if (!Object.hasOwn(this.preferences,id)) { Object.defineProperty(this.preferences,id,{value:{order:[],excluded:[]},enumerable:true,writable:true,configurable:true}); changed = true; }
      for (const model of models) if (!this.preferences[id].order.includes(model.provider)) { this.preferences[id].order.push(model.provider); changed = true; }
    }
    if (changed && this.routesFile) await writeJson(this.routesFile,this.preferences);
    return this.preferences;
  }
  setCatalog(source, models, error, provider = this.providers[source]) {
    this.catalogVersions.set(source, (this.catalogVersions.get(source) || 0) + 1);
    this.known.add(source); this.routeModels = null; this.catalogRevision++;
    this.discoveredAt ||= Date.now();
    this.onCatalog(source, models, error, provider);
    if (!error) { delete this.errors[source]; this.failedAt.delete(source); this.available.add(source); this.catalogs.set(source, models); }
    else { this.available.delete(source); this.failedAt.set(source, this.failedAt.get(source) || Date.now()); this.errors[source] = `${provider.source?.name || source} 不可用，请检查登录状态与网络`; }
  }
  invalidateSource(source) {
    this.catalogVersions.set(source, (this.catalogVersions.get(source) || 0) + 1);
    this.known.delete(source); this.catalogs.delete(source); this.available.delete(source);
    this.failedAt.delete(source); delete this.errors[source]; this.routeModels = null; this.catalogRevision++;
  }
  async refreshSource(source, force = false) {
    const provider = this.providers[source], pending = this.discoveries.get(source);
    if (pending?.provider === provider && pending.version === (this.catalogVersions.get(source) || 0)) {
      if (force && !pending.force) { await pending.promise.catch(() => {}); return this.refreshSource(source, true); }
      return pending.promise;
    }
    if (!force && Date.now() - (this.failedAt.get(source) || 0) < 30000) throw Object.assign(new Error('Source unavailable'), { backoff: true });
    const entry = { provider, force, version: this.catalogVersions.get(source) || 0 };
    const current = () => this.providers[source] === provider && (this.catalogVersions.get(source) || 0) === entry.version;
    entry.promise = Promise.resolve().then(() => provider.listModels(force)).then(models => {
      if (current()) this.setCatalog(source, models, undefined, provider);
      return models;
    }, error => { if (current()) this.setCatalog(source, undefined, error, provider); throw error; }).finally(() => {
      if (this.discoveries.get(source) === entry) this.discoveries.delete(source);
    });
    this.discoveries.set(source, entry);
    return entry.promise;
  }
  async listModels(force = false) {
    await Promise.allSettled(Object.keys(this.providers).map(source => this.refreshSource(source, force)));
    const models = await this.publishModels(); this.discoveredAt = Date.now(); return models;
  }
  async cachedModels() {
    // The CLI consumes the proxy catalog; only undiscovered/invalidated sources need I/O.
    const missing = Object.keys(this.providers).filter(source => !this.known.has(source));
    if (missing.length) await Promise.allSettled(missing.map(source => this.refreshSource(source)));
    return this.routeModels || this.publishModels();
  }
  async publishModels() {
    return this.run(async () => {
      if (this.routeModels) return this.routeModels;
      let groups, revision;
      do {
        revision = this.catalogRevision; groups = new Map();
        for (const source of Object.keys(this.providers)) for (const model of this.catalogs.get(source) || []) {
          if (!groups.has(model.id)) groups.set(model.id,[]);
          groups.get(model.id).push({...model,provider:source});
        }
        await this.preferencesFor(groups);
      } while (revision !== this.catalogRevision);
      this.groups = groups;
      this.routeModels = [...groups].map(([id,models]) => {
        const pref = this.preferences[id];
        const eligible = models.filter(m => m.enabled && this.available.has(m.provider) && !pref.excluded.includes(m.provider));
        eligible.sort((a,b) => pref.order.indexOf(a.provider) - pref.order.indexOf(b.provider));
        const base = eligible[0] || models[0];
        if (eligible.length < 2) return {...base,id,enabled:!!eligible.length,contextWindows:base.contextWindows || [],reasoningEfforts:base.reasoningEfforts || []};
        const merged = {...base,id,enabled:true,contextWindows:[],reasoningEfforts:common(eligible.map(m=>m.reasoningEfforts))};
        for (const field of ['contextWindow','maxInputTokens','maxOutputTokens']) merged[field] = minimum(eligible.map(m=>m[field]));
        for (const field of ['isVL','isReasoning','supportsFast']) merged[field] = eligible.some(m=>typeof m[field] !== 'boolean') ? undefined : eligible.every(m=>m[field] === true);
        merged.contextWindows = common(eligible.map(m=>(m.contextWindows || []).map(w=>w.length))).map(length=>({length,isDefault:length===merged.contextWindow}));
        merged.capabilities = Object.fromEntries(Object.keys(base.capabilities || {}).filter(k=>eligible.every(m=>m.capabilities?.[k] === base.capabilities[k])).map(k=>[k,base.capabilities[k]]));
        for (const field of ['defaultEffort','effort','fast']) if (!eligible.every(m=>m[field] === base[field])) delete merged[field];
        return merged;
      });
      return this.routeModels;
    });
  }
  async routes({ refresh = false, retry } = {}) {
    if (retry !== undefined) {
      await this.cachedModels();
      const models = this.groups.get(retry), pref = this.preferences[retry];
      if (!models || !models.some(m => m.enabled && !pref.excluded.includes(m.provider))) throw bad('模型未启用或已移除，请刷新后重试');
      // An explicit retry bypasses failure backoff, without rediscovering healthy sources.
      const health = new Map((await this.getSourceHealth()).map(s => [s.id, s]));
      const failed = models.filter(m => m.enabled && !pref.excluded.includes(m.provider) && (!this.available.has(m.provider) || health.get(m.provider)?.state === 'unavailable'));
      await Promise.allSettled(failed.map(async m => {
        // Configured catalogs can succeed even when inference cannot connect.
        // The service supplies the appropriate connection check per source.
        await this.retrySource?.(m.provider, retry);
        return this.refreshSource(m.provider, true);
      }));
      await this.publishModels();
    } else await this.listModels(refresh);
    const health = new Map((await this.getSourceHealth()).map(s => [s.id, s]));
    return [...this.groups].map(([id,models]) => {
      const pref = this.preferences[id], primary = pref.order.find(p=>!pref.excluded.includes(p));
      const sources = pref.order.map(provider => {
        const model = models.find(m=>m.provider===provider), p = this.providers[provider];
        const failure = health.get(provider);
        const reason = !p ? '来源已移除或停用' : !model?.enabled ? '模型已停用或移除' : !this.available.has(provider) || failure?.state === 'unavailable' ? failure?.error?.message || '来源不可用' : '';
        return {id:provider,name:p?.source?.name || ({qoder:'Qoder',agy:'AGY',grok:'Grok',codex:'Codex',kimi:'Kimi'}[provider] || provider),enabled:!!p&&!!model?.enabled,available:!reason,reason,participating:!pref.excluded.includes(provider)};
      });
      return {id,enabled:sources.some(s=>s.enabled&&s.participating),primary,needsAttention:!sources.find(s=>s.id===primary)?.available,sources,order:pref.order,excluded:pref.excluded};
    });
  }
  async saveRoute({id,order,excluded=[]}) {
    if (typeof id !== 'string' || !this.groups?.has(id) || !Array.isArray(order) || !Array.isArray(excluded)) throw bad('模型路由无效，请刷新后重试');
    return this.run(async()=>{
      const prior = this.preferences[id];
      if (order.length !== prior.order.length || new Set(order).size !== order.length || order.some(p=>!prior.order.includes(p)) || new Set(excluded).size !== excluded.length || excluded.some(p=>!order.includes(p))) throw bad('来源列表已变化，请刷新后重试');
      const primary = order.find(p=>!excluded.includes(p));
      if (!primary) throw bad('至少保留一个来源');
      const model = this.groups.get(id).find(m=>m.provider===primary);
      if (!model?.enabled || !this.available.has(primary)) throw bad('主用来源不可用，请选择其他来源');
      const next = {...this.preferences,[id]:{order:[...order],excluded:[...excluded]}};
      if (this.routesFile) await writeJson(this.routesFile,next);
      this.preferences = next; this.routeModels = null; for(const [key,pin] of this.sessions)if(pin.model===id)this.sessions.delete(key);for(const provider of order)this.cooldowns.delete(id+'\0'+provider); return {id,order,excluded};
    });
  }
  async forgetSource(provider) {
    await this.run(async()=>{
      const preferences=this.preferences || (this.routesFile ? await readJson(this.routesFile,{}) : {}),next={};
      for(const [id,pref] of Object.entries(preferences)){
        const order=pref.order.filter(id=>id!==provider),excluded=pref.excluded.filter(id=>id!==provider);
        if(order.length)Object.defineProperty(next,id,{value:{order,excluded},enumerable:true});
      }
      if(this.routesFile)await writeJson(this.routesFile,next);this.preferences=next;
      this.invalidateSource(provider);
      for(const [key,pin] of this.sessions)if(pin.provider===provider)this.sessions.delete(key);
      for(const key of this.cooldowns.keys())if(key.endsWith('\0'+provider))this.cooldowns.delete(key);
      this.discoveredAt=0;this.routeModels=null;
    });
  }
  sessionKey(model,conversationId) { return conversationId ? createHash('sha256').update(model+'\0'+conversationId).digest('hex') : null; }
  async candidates(request, {conversationId,stateful=false}={}) {
    const hadCatalog = !!this.routeModels;
    if (!hadCatalog) await this.cachedModels();
    const cached = this.routeModels?.some(m=>m.id===request.model || m.provider==='qoder' && m.id===parseModelRef(request.model).id);
    if (!cached || hadCatalog && Date.now()-this.discoveredAt >= this.cacheRoutesMs) await this.listModels();
    const id = this.groups.has(request.model) ? request.model : parseModelRef(request.model).id;
    const pref = this.preferences[id], models = this.groups.get(id);
    if (!pref || !models) throw Object.assign(new Error('模型不存在、已停用或来源不可用'),{code:'model_not_found',status:400});
    let candidates = pref.order.map(p=>models.find(m=>m.provider===p)).filter(m=>m?.enabled && this.available.has(m.provider) && !pref.excluded.includes(m.provider) && (request.model===m.id || m.provider==='qoder'));
    const key = this.sessionKey(id,conversationId), pin = key && this.sessions.get(key);
    if (pin && Date.now()-pin.at >= 86400000) this.sessions.delete(key);
    const pinned = key && this.sessions.get(key)?.provider;
    if (stateful) {
      if (pinned) candidates = candidates.filter(m=>m.provider===pinned);
      else if (pref.order.filter(p=>!pref.excluded.includes(p)).length > 1) throw bad('带上游会话状态的请求需要已绑定的 x-daylight-conversation-id，不能跨来源回退');
    } else {
      if (pinned) candidates.sort((a,b)=>Number(b.provider===pinned)-Number(a.provider===pinned));
      const ready = candidates.filter(m=>(this.cooldowns.get(id+'\0'+m.provider) || 0) <= Date.now());
      if (ready.length) candidates = ready;
    }
    if (!candidates.length) throw Object.assign(new Error('模型不存在、已停用或来源不可用'),{code:'model_not_found',status:400});
    return candidates;
  }
  success(model,conversationId) {
    const key = this.sessionKey(model.id,conversationId);
    if (key) { this.sessions.delete(key); this.sessions.set(key,{model:model.id,provider:model.provider,at:Date.now()}); if(this.sessions.size>10000)this.sessions.delete(this.sessions.keys().next().value); }
    this.cooldowns.delete(model.id+'\0'+model.provider);
  }
  failed(model) { this.cooldowns.set(model.id+'\0'+model.provider,Date.now()+30000); }
  async resolve(request) { return (await this.candidates(request))[0]; }
  async *stream(request, options={}) {
    let candidates;
    try { candidates = await this.candidates(request,options); } catch(e) { yield {type:'error',code:e.code || 'upstream_error',message:e.message}; return; }
    for (const [i,model] of candidates.entries()) {
      options.onRoute?.(model.provider);
      const iterator = this.providers[model.provider].stream(request,options)[Symbol.asyncIterator]();
      let started=false;
      try {
        const first = await iterator.next();
        if (first.value?.type==='error' && i<candidates.length-1 && !options.stateful && retryableRouteError(first.value)) { this.failed(model); continue; }
        if (first.value?.type!=='error') this.success(model,options.conversationId);
        if (!first.done) {started=true;yield first.value;}
        for (;;) { const step=await iterator.next(); if(step.done)return;yield step.value; }
      } catch(e) { if(started || i===candidates.length-1 || options.stateful || options.signal?.aborted || !retryableRouteError(e))throw e;this.failed(model); }
      finally { await iterator.return?.(); }
    }
  }
}
