import {parseModels} from './models.js';
import {codexQuota} from './quota.js';
import {sourceSnapshot,modelCapabilities} from '../shared/contracts.js';
import {CodexAuth} from './auth.js';
import {modelSettings,applyModelSettings} from '../shared/model-settings.js';
import path from 'node:path';
import {invalid,convertRequest} from '../shared/protocol.js';

export class CodexProvider {
  async listModels(force=false){return modelCapabilities(await this.catalogModels(typeof force==='object'?force.refresh===true:force),['enabled', 'effort', 'serviceTier']);}
  async execute({raw,protocol},context){return{kind:'response',...await this.forward(raw,protocol,context)};}
  snapshot(){return sourceSnapshot({id:'codex',name:'Codex',identityKey:this.auth.identity,configured:true,connected:!!this.cache&&!this.lastError,error:this.lastError,checkedAt:this.cache?.at,authentication:{mode:'local',operations:['refresh']},capabilities:{quota:true,editableSource:false,requestOutputBudget:false},nativeProtocols:['responses']});}
  constructor({dataDir,fetchImpl=fetch,auth,...options}) {
    this.fetchImpl=fetchImpl;this.auth=auth||new CodexAuth(options);this.file=path.join(dataDir,'codex-proxy/settings.json');this.settings=modelSettings(this.file);
  }
  async read(){return this.auth.read();}
  async quota(){return codexQuota(await this.auth.quota());}
  async discover(force=false){
    const catalog=await this.auth.discover(force);
    this.identity=catalog.identity;
    this.cache={identity:catalog.identity,at:catalog.at,models:parseModels(catalog)};return this.auth.read();
  }
  close(){this.auth.close();}
  async catalogModels(force=false){await this.discover(force);return applyModelSettings(this.cache.models,await this.settings.read());}
  async status(force=false){try{await this.listModels(force);this.lastError=null;return{connected:true,authMode:'codex_oauth'};}catch{this.lastError='无法读取本机 Codex 登录，请在 Codex 登录后刷新';return{connected:false,error:this.lastError};}}
  async setModel(input) {
    const model=(await this.listModels()).find(m=>m.id===input.id);if(!model)throw invalid('模型不存在');
    await this.settings.save(model,input,{fields:['contextWindow', 'maxOutputTokens', 'enabled', 'effort', 'serviceTier'],invalid,error:'不支持的模型设置'});return this.listModels();
  }
  async forward(raw,protocol,{signal,observe=()=>{}}) {
    observe({stage:'discovery'});
    const model=(await this.listModels()).find(m=>m.id===raw.model&&m.enabled);if(!model)throw invalid('模型已停用或不存在');
    observe({stage:'authentication'});
    const a=await this.discover();observe({stage:'conversion'});const body=protocol==='responses'?structuredClone(raw):convertRequest(raw,protocol,'responses');
    for(const k of ['previous_response_id','conversation','max_output_tokens','temperature','top_p','truncation','background'])if(body[k]!=null)throw invalid(`Codex 通道暂不支持 ${k}`,k);
    if(body.store===true)throw invalid('Codex 使用无状态历史，不支持 store=true','store');
    body.model=model.id;body.store=false;body.stream=true;body.instructions??='You are a helpful assistant.';
    if(typeof body.input==='string')body.input=[{role:'user',content:[{type:'input_text',text:body.input}]}];
    body.include=[...new Set([...(body.include||[]),'reasoning.encrypted_content'])];
    const effort=body.reasoning?.effort??model.effort;
    if(effort!==undefined){if(!model.reasoningEfforts.includes(effort))throw invalid('该 Codex 模型不支持此思考强度','reasoning.effort');body.reasoning={...body.reasoning,effort};}
    let tier=body.service_tier??model.serviceTier;if(tier==='fast')tier='priority';
    if(tier!==undefined){if(!['auto','default',...model.serviceTiers.map(t=>t.id)].includes(tier))throw invalid('该模型未提供此速度档位','service_tier');body.service_tier=tier;}
    const call = credential => this.fetchImpl('https://chatgpt.com/backend-api/codex/responses',{method:'POST',redirect:'error',signal,headers:{Authorization:`Bearer ${credential.token}`,'chatgpt-account-id':credential.account,'Content-Type':'application/json',Accept:'text/event-stream',originator:'daylight','OpenAI-Beta':'responses=experimental'},body:JSON.stringify(body)});
    observe({stage:'upstream'});
    let response=await call(a);
    if(response.status===401){observe({stage:'authentication',retries:1});await response.body?.cancel();const fresh=await this.discover(true);if(fresh.identity!==a.identity)throw Object.assign(new Error('Codex 账号已切换，请重新请求'),{status:401});observe({stage:'upstream'});response=await call(fresh);}
    return{response,streaming:true,protocol:'responses',model:model.id,upstreamModel:model.id,requestedTier:tier};
  }
}
