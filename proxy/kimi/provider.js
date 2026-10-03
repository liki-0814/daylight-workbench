import {parseModels} from './models.js';
import {kimiQuota} from './quota.js';
import {CatalogCache} from '../shared/catalog-cache.js';
import {sourceSnapshot,modelCapabilities} from '../shared/contracts.js';
import {modelSettings,applyModelSettings} from '../shared/model-settings.js';
import {KimiAuth,authError} from './auth.js';
import {omitKimiTemperature} from '../shared/request-parameters.js';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {invalid,convertRequest} from '../shared/protocol.js';

const BASE='https://api.kimi.com/coding/v1';

export class KimiProvider {
  async listModels(force=false){return modelCapabilities(await this.catalogModels(typeof force==='object'?force.refresh===true:force),['enabled', 'effort']);}
  async execute({raw,protocol},context){return{kind:'response',...await this.forward(raw,protocol,context)};}
  snapshot(){return sourceSnapshot({id:'kimi',name:'Kimi Code',identityKey:this.identity,configured:true,connected:!!this.cache&&!this.lastError,error:this.lastError,checkedAt:this.cache?.at,authentication:{mode:'browser',operations:['login', 'poll', 'cancel', 'refresh']},capabilities:{quota:true,editableSource:false},nativeProtocols:['chat']});}
 constructor({dataDir,fetchImpl=fetch,auth=new KimiAuth({fetchImpl})}){Object.assign(this,{fetchImpl,auth});this.file=path.join(dataDir,'kimi-proxy/settings.json');this.catalogCache=new CatalogCache();this.settings=modelSettings(this.file);}
 get cache(){return this.catalogCache.value;}
 async credential(force=false){const token=await this.auth.credential(force);let account;try{const claims=JSON.parse(Buffer.from(token.access_token.split('.')[1],'base64url'));account=claims.user_id||claims.sub;}catch{}this.identity=createHash('sha256').update(String(account||token.access_token)).digest('hex');return token;}
 async quota(){
  const token=await this.credential();
  const response=await this.fetchImpl(BASE+'/usages',{redirect:'error',headers:{Authorization:`Bearer ${token.access_token}`},signal:AbortSignal.timeout(30000)});
  if(!response.ok){await response.body?.cancel();throw Object.assign(new Error(`Kimi 额度读取失败（${response.status}）`),{status:response.status});}
  return kimiQuota(await response.json());
 }
 async catalogModels(force=false){
  const token=await this.credential();
  const identity=this.identity;
  const cache=await this.catalogCache.get({identity,refresh:force,load:async()=>{
   const response=await this.fetchImpl(BASE+'/models',{redirect:'error',headers:{Authorization:`Bearer ${token.access_token}`},signal:AbortSignal.timeout(30000)});
   if(!response.ok){await response.body?.cancel();throw Object.assign(new Error(`Kimi 模型获取失败（${response.status}）`),{status:response.status});}
   const data=await response.json();
   await this.credential();if(this.identity!==identity)throw authError('Kimi 账号已切换，请重新请求');
   return {models:parseModels(data)};
  }});
  this.lastError=null;return applyModelSettings(cache.models,await this.settings.read());
 }
 async status(force=false){try{const models=await this.listModels(force);return{connected:true,authMode:'kimi_oauth',models};}catch(error){this.lastError=error.message;return{connected:false,error:this.lastError};}}
  async setModel(input) {
    const model=(await this.listModels()).find(m=>m.id===input.id);if(!model)throw invalid('模型不存在');
    await this.settings.save(model,input,{fields:['contextWindow', 'maxOutputTokens', 'enabled', 'effort'],invalid,error:'不支持的模型设置'});return this.listModels();
  }
 async forward(raw,protocol,{signal,observe=()=>{}}={}){
  observe({stage:'discovery'});const model=(await this.listModels()).find(m=>m.id===raw.model&&m.enabled);if(!model)throw invalid('Kimi 模型已停用或不存在');
  observe({stage:'authentication'});const token=await this.credential(),identity=this.identity;const input=structuredClone(raw);
  omitKimiTemperature(input,model.id,observe);
  const body=protocol==='chat'?input:convertRequest(input,protocol,'chat');
  const effort=body.reasoning_effort ?? model.effort;
  if(effort!==undefined){
   if(model.reasoningEfforts.length&&!model.reasoningEfforts.includes(effort)||model.thinkingType==='only'&&['none','off'].includes(effort))throw invalid('该 Kimi 模型不支持此思考强度','reasoning_effort');
   body.reasoning_effort=effort;
  }
  // Only confirmed official models omit temperature; other parameters pass through.
  observe({stage:'upstream'});const call=credential=>this.fetchImpl(BASE+'/chat/completions',{method:'POST',redirect:'error',signal,headers:{Authorization:`Bearer ${credential.access_token}`,'Content-Type':'application/json','User-Agent':'Daylight/0.3.0'},body:JSON.stringify(body)});
  let response=await call(token);if(response.status===401){await response.body?.cancel();observe({stage:'authentication',retries:1});const fresh=await this.credential(true);if(this.identity!==identity)throw authError('Kimi 账号已切换，请重新请求');observe({stage:'upstream'});response=await call(fresh);}
  return{response,protocol:'chat',streaming:body.stream===true,model:model.id,upstreamModel:model.id};
 }
 close(){this.catalogCache.invalidate();this.auth.close?.();}
}
