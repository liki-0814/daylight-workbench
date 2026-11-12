import path from 'node:path';
import {WorkBuddyAuth} from './auth.js';
import {parseModels} from './models.js';
import {CatalogCache} from '../shared/catalog-cache.js';
import {bindAccountCatalog,checkAccountCatalog} from '../shared/account-catalog.js';
import {modelSettings,applyModelSettings} from '../shared/model-settings.js';
import {sourceSnapshot,modelCapabilities} from '../shared/contracts.js';
import {invalid,prepareUpstreamRequest} from '../shared/protocol.js';
import {headerDeadline} from '../shared/header-deadline.js';
const BASE='https://copilot.tencent.com';
const common={Accept:'application/json','User-Agent':'CLI/2.63.2 CodeBuddy/2.63.2',Origin:'https://www.codebuddy.cn',Referer:'https://www.codebuddy.cn/','X-Product':'SaaS'};
export const sourceDescription={id:'workbuddy',name:'WorkBuddy',authentication:{mode:'browser',operations:['login','poll','cancel','refresh','logout'],instruction:'WorkBuddy 国内版网页登录 · 非官方接口'},capabilities:{quota:false,editableSource:false,startupDiscovery:true},nativeProtocols:['chat']};
export class WorkBuddyProvider {
 constructor({dataDir,fetchImpl=fetch,auth=new WorkBuddyAuth({dataDir,fetchImpl})}){Object.assign(this,{fetchImpl,auth});this.catalogCache=new CatalogCache();this.settings=modelSettings(path.join(dataDir,'workbuddy/settings.json'));bindAccountCatalog(this);}
 get cache(){return this.catalogCache.value;}
 snapshot(){return {...sourceSnapshot({...sourceDescription,identityKey:this.auth.identity,configured:!!this.auth.account,connected:!!this.cache&&this.cache.identity===this.auth.identity&&!this.lastError,error:this.lastError,checkedAt:this.cache?.at}),account:this.auth.account?{login:this.auth.account.login}:undefined};}
 async listModels(force=false){
  const session=await this.auth.getSession(),epoch=this.auth.epoch,identity=this.auth.identity;
  const cache=await this.catalogCache.get({identity,refresh:typeof force==='object'?force.refresh===true:force,load:async()=>{
   const response=await this.fetchImpl(BASE+'/console/enterprises/personal/models',{headers:{...common,Authorization:`Bearer ${session.access_token}`},redirect:'error',signal:AbortSignal.timeout(30000)});
   if(!response.ok){await response.body?.cancel();throw Object.assign(Error(`WorkBuddy 模型目录获取失败（${response.status}）`),{status:response.status});}
   const models=parseModels(await response.json());if(epoch!==this.auth.epoch||identity!==this.auth.identity)throw invalid('WorkBuddy 账号已变化，请重新请求');return {models};
  }});this.lastError=null;return modelCapabilities(applyModelSettings(cache.models,await this.settings.read()),['enabled','effort']);
 }
 async status(force=false){return checkAccountCatalog(this,force);}
 async setModel(input){const model=(await this.listModels()).find(m=>m.id===input.id);if(!model)throw invalid('模型不存在');await this.settings.save(model,input,{fields:['enabled','effort','contextWindow','maxOutputTokens'],invalid,error:'不支持的模型设置'});return this.listModels();}
 async execute({raw,protocol},context={}){
  const observe=context.observe||(()=>{});observe({stage:'discovery'});
  const model=(await this.listModels()).find(m=>m.id===raw.model&&m.enabled);if(!model)throw invalid('WorkBuddy 模型已停用或不存在');
  const epoch=this.auth.epoch,session=await this.auth.getSession();if(epoch!==this.auth.epoch)throw invalid('WorkBuddy 账号已变化，请重新请求');
  const body=prepareUpstreamRequest(raw,protocol,'chat');body.model=model.id;body.stream=true;
  if(body.messages?.some(m=>m.role==='developer'))throw invalid('WorkBuddy 不支持 developer 消息，请改用 system');
  if(typeof body.tool_choice==='object')throw invalid('WorkBuddy 暂不支持指定工具');
  if(body.reasoning_effort!==undefined&&(!model.reasoningEfforts?.includes(body.reasoning_effort)))throw invalid('该 WorkBuddy 模型未声明此思考强度');
  if(model.effort&&!body.reasoning_effort)body.reasoning_effort=model.effort;
  observe({stage:'upstream'});
  const deadline=headerDeadline(context.signal,300000);
  const response=await this.fetchImpl(BASE+'/v2/chat/completions',{method:'POST',redirect:'error',headers:{...common,'Content-Type':'application/json',Authorization:`Bearer ${session.access_token}`,...(session.account.id?{'X-User-Id':session.account.id}:{'X-No-User-Id':'1'}),...(session.domain?{'X-Domain':session.domain}:{'X-No-Department-Info':'1'})},body:JSON.stringify(body),signal:deadline.signal}).finally(()=>deadline.settle());
  return {kind:'response',response,protocol:'chat',streaming:true,model:model.id,upstreamModel:model.id};
 }
 close(){this.catalogCache.invalidate();this.auth.close();}
}
