import {bindAccountCatalog,checkAccountCatalog} from '../shared/account-catalog.js';
import path from 'node:path';
import {CopilotAuth,copilotHeaders,authError} from './auth.js';
import {parseModels} from './models.js';
import {copilotQuota} from './quota.js';
import {CatalogCache} from '../shared/catalog-cache.js';
import {sourceSnapshot,modelCapabilities} from '../shared/contracts.js';
import {modelSettings,applyModelSettings} from '../shared/model-settings.js';
import {invalid,convertRequest} from '../shared/protocol.js';

export const sourceDescription={id:'copilot',name:'GitHub Copilot',authentication:{mode:'browser',operations:['login','poll','cancel','logout','refresh'],instruction:'GitHub 网页登录 · 无需 CLI'},capabilities:{quota:true,editableSource:false},nativeProtocols:['chat','responses','messages']};
export class CopilotProvider {
 constructor({dataDir,fetchImpl=fetch,auth=new CopilotAuth({fetchImpl})}){Object.assign(this,{fetchImpl,auth});this.catalogCache=new CatalogCache();this.settings=modelSettings(path.join(dataDir,'copilot-proxy/settings.json'));bindAccountCatalog(this);}
 get cache(){return this.catalogCache.value;}
 snapshot(){return{...sourceSnapshot({...sourceDescription,configured:!!this.auth.account,identityKey:this.auth.token?.identity,connected:!!this.cache&&this.cache.identity===this.auth.token?.identity&&!this.lastError,error:this.lastError,checkedAt:this.cache?.at}),account:this.auth.account?{login:this.auth.account.login}:undefined};}
 async request(endpoint,options={},credential){
  const a=credential||await this.auth.credential(),epoch=this.auth.epoch;
  const call=token=>this.fetchImpl(token.baseUrl+endpoint,{...options,redirect:'error',headers:{...copilotHeaders(token.token),...options.headers},signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(300000)]):AbortSignal.timeout(30000)});
  let response=await call(a);
  if(response.status===401){await response.body?.cancel();const fresh=await this.auth.credential(true);if(fresh.identity!==a.identity||epoch!==this.auth.epoch)throw authError('Copilot 账号已切换，请重新请求');response=await call(fresh);}
  return response;
 }
 async listModels(force=false){
  const a=await this.auth.credential(),epoch=this.auth.epoch;
  const cache=await this.catalogCache.get({identity:a.identity,refresh:typeof force==='object'?force.refresh===true:force,load:async()=>{
   const response=await this.request('/models',{},a);
   if(!response.ok){await response.body?.cancel();throw Object.assign(new Error(`Copilot 模型获取失败（${response.status}）`),{status:response.status});}
   const models=parseModels(await response.json());if(epoch!==this.auth.epoch)throw authError('Copilot 登录状态已变化，请重新请求');return{models};
  }});
  this.lastError=null;return modelCapabilities(applyModelSettings(cache.models,await this.settings.read()),['enabled','effort']);
 }
 async status(force=false){return checkAccountCatalog(this,force,{error:e=>e.status?e.message:'Copilot 检测失败，请检查网络或钥匙串后重试'});}
 async quota(){const saved=await this.auth.read();return copilotQuota(await this.auth.request('https://api.github.com/copilot_internal/user',{token:saved.accessToken}));}
 async setModel(input){const model=(await this.listModels()).find(m=>m.id===input.id);if(!model)throw invalid('模型不存在');await this.settings.save(model,input,{fields:['enabled','effort','contextWindow','maxOutputTokens'],invalid,error:'不支持的 Copilot 模型设置'});return this.listModels();}
 async execute({raw,protocol},context){return{kind:'response',...await this.forward(raw,protocol,context)};}
 async forward(raw,protocol,{signal,observe=()=>{}}={}){
  const epoch=this.auth.epoch;
  observe({stage:'discovery'});const model=(await this.listModels()).find(m=>m.id===raw.model&&m.enabled),identity=this.cache?.identity;if(!model)throw invalid('Copilot 模型已停用或不存在');
  const target=model.nativeProtocols.includes(protocol)?protocol:model.nativeProtocols[0];
  observe({stage:'conversion'});const body=protocol===target?structuredClone(raw):convertRequest(raw,protocol,target);
  const effort=(target==='responses'?body.reasoning?.effort:target==='messages'?body.output_config?.effort:body.reasoning_effort)??model.effort;
  if(effort!==undefined){if(!model.reasoningEfforts.includes(effort))throw invalid('该 Copilot 模型未提供此思考强度');if(target==='responses')body.reasoning={...body.reasoning,effort};else if(target==='messages')body.output_config={...body.output_config,effort};else body.reasoning_effort=effort;}
  const messages=target!=='responses'?body.messages:Array.isArray(body.input)?body.input:[];
  const last=messages?.at(-1),agent=last&&(last.role!==undefined?last.role!=='user'||Array.isArray(last.content)&&last.content.some(c=>c.type==='tool_result'):['function_call','function_call_output'].includes(last.type));
  const vision=messages?.some(m=>Array.isArray(m.content)&&m.content.some(c=>['image_url','input_image','image'].includes(c.type)));
  observe({stage:'authentication'});const credential=await this.auth.credential();if(credential.identity!==identity||epoch!==this.auth.epoch)throw authError('Copilot 账号已切换，请重新请求');
  observe({stage:'upstream'});const response=await this.request(({chat:'/chat/completions',responses:'/responses',messages:'/v1/messages'})[target],{method:'POST',signal,headers:{'X-Initiator':agent?'agent':'user',...(target==='messages'?{'anthropic-version':'2023-06-01'}:{}),...(vision?{'copilot-vision-request':'true'}:{})},body:JSON.stringify(body)},credential);
  return{response,protocol:target,streaming:body.stream===true,model:model.id,upstreamModel:model.id};
 }
 close(){this.catalogCache.invalidate();this.auth.close?.();}
}
