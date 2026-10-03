import {updateModelSetting} from '../shared/model-settings.js';
import {decodeRequest} from '../shared/protocol.js';
import {CatalogCache} from '../shared/catalog-cache.js';
import {sourceSnapshot,modelCapabilities} from '../shared/contracts.js';
import path from 'node:path';
import {serial} from '../shared/store.js';
import {CreditsHistory} from './quota.js';
import {setTimeout as sleep} from 'node:timers/promises';
import {sessionFromAccount} from './transport.js';
import {refreshCredential,QoderAuth} from './auth.js';
import {fetchModels} from './models.js';
import {parseModelRef} from '../shared/llm/models.js';
import {fetchCredits} from './quota.js';
import {loadSettings, saveSettings, applyModelsCommand, applySettings, resolveQueueRetry, queueRetryDelay} from './models.js';
import {contextWindowRejection, effortRejection} from '../shared/llm/index.js';
import {SessionStore} from './protocol.js';
import {compileNativeBody, INFERENCE_PATH, INFERENCE_QUERY} from './protocol.js';
import {encodeBody} from './body-codec.js';
import {QoderDeframer, RETRYABLE_UPSTREAM_CODES} from './stream.js';

export class QoderProvider {
  async listModels(force=false){return modelCapabilities(await this.catalogModels(typeof force==='object'?force.refresh===true:force),['enabled', 'context', 'effort', 'fast']);}
  async execute({raw,protocol},context){const request=decodeRequest(raw,protocol);return{kind:'events',events:this.stream(request,context)};}
  snapshot(){return sourceSnapshot({id:'qoder',name:'Qoder',identityKey:this.accounts.current?.id,configured:!!this.accounts.current,connected:!!this.cache&&!this.lastError,error:this.lastError,checkedAt:this.cache?.at,catalogIdentityKey:this.cache?.identity,authentication:{mode:'browser',operations:['login', 'poll', 'cancel', 'logout'],requiresStoppedService:true},capabilities:{quota:true,editableSource:false},nativeProtocols:['chat']});}
  constructor(config, http, accounts) { Object.assign(this, { config, http, accounts });this.mutate=serial();this.catalogCache=new CatalogCache(); this.sessions = new SessionStore(); this.auth=new QoderAuth({accounts,http,config,fetchImpl:http.fetchImpl,onChange:()=>this.clear()});this.creditsHistory = new CreditsHistory(path.join(path.dirname(config.accountFile), "credits-history.json")); }
  get cache(){return this.catalogCache.value;}
  clear() { this.catalogCache.invalidate(); this.sessions = new SessionStore(); }
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
    const cache=await this.catalogCache.get({identity:account.id,refresh:force,load:async()=>{
      const models=await fetchModels(this.http,sessionFromAccount(this.config,account));
      if((await this.accounts.load())?.id!==account.id)throw Object.assign(new Error('Qoder 账号已切换，请重新请求'),{status:401});
      return {id:account.id,models};
    }});
    const settings = await loadSettings(this.config.accountFile);
    return { models: applySettings(cache.models, settings), settings };
  }
  async catalogModels(force=false) { return (await this.catalog(await this.ready(), force)).models; }
  async setModel(body){return this.mutate(async()=>{
    const fail=message=>{throw Object.assign(new Error(message),{status:400});};
    if(['contextWindow','maxOutputTokens'].includes(body.field)){
      const model=(await this.listModels()).find(m=>m.id===body.id);if(!model)fail('模型不存在');
      const settings=await loadSettings(this.config.accountFile);
      updateModelSetting(settings,model,body,{fields:['contextWindow','maxOutputTokens'],invalid:message=>Object.assign(new Error(message),{status:400})});
      if(body.field==='contextWindow')delete settings.context[body.id];
      await saveSettings(this.config.accountFile,settings);return this.listModels();
    }
    if(!['enabled','context','effort','fast'].includes(body.field)||typeof body.id!=='string')fail('模型设置字段无效');
    if(['enabled','fast'].includes(body.field)&&typeof body.value!=='boolean')fail('开关值无效');
    const models=await this.listModels();
    if(body.field==='fast'&&body.value&&!models.find(m=>m.id===body.id)?.supportsFast)fail('该模型不支持 Fast');
    const settings=await loadSettings(this.config.accountFile);
    const command=body.field==='enabled'?(body.value?'enable':'disable'):body.field;
    const value=body.field==='fast'?(body.value?'on':'off'):String(body.value);
    let next;try{next=applyModelsCommand(command,[body.id,value],settings,models).settings;}catch(error){fail(error.message);}
    await saveSettings(this.config.accountFile,next);return this.listModels();
  });}
  async quota(){const result=await this.credits();return {...result,checkedAt:result.updatedAt,buckets:result.buckets.map(b=>({id:b.id,name:b.label,unit:'credits',limit:b.total,used:b.used,remaining:b.remaining})),message:'账户额度包含其他客户端使用；每小时保留一个快照，展示近 30 天变化。'};}
  close(){this.clear();}
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
      const body = compileNativeBody(resolved, { model, session: state, clientVersion: this.config.clientVersion, fast: model.fast });
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

export function loadConfig(dataDir, env = process.env) {
  return {
    compatUrl: env.QODER_COMPAT_URL || 'https://api3.qoder.sh',
    openapiUrl: env.QODER_OPENAPI_URL || 'https://openapi.qoder.sh',
    loginUrl: env.QODER_LOGIN_URL || 'https://qoder.com/device/selectAccounts',
    clientId: env.QODER_CLIENT_ID || 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
    clientVersion: env.QODER_CLIENT_VERSION || '1.0.41',
    cosyVersion: env.QODER_COSY_VERSION || '1.0.41',
    accountFile: path.join(dataDir, 'qoder', 'account.json'),
  };
}
