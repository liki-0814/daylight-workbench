import {parseModels} from './models.js';
import {CatalogCache} from '../shared/catalog-cache.js';
import {sourceSnapshot,modelCapabilities} from '../shared/contracts.js';
import {CodexAuth} from './auth.js';
import {modelSettings,applyModelSettings} from '../shared/model-settings.js';
import path from 'node:path';
import {invalid,convertRequest} from '../shared/protocol.js';

export const sourceDescription = {id:'codex',name:'Codex',authentication:{mode:'browser',operations:['login','poll','cancel','refresh','logout'],instruction:'ChatGPT 网页登录 · 无需 CLI',loginLabel:'Continue with ChatGPT'},capabilities:{quota:true,editableSource:false,requestOutputBudget:false,pi:{'openai-completions':'Codex 通道需用 Responses，不能接收 Pi 的输出预算','anthropic-messages':'Codex 通道需用 Responses，不能接收 Pi 的输出预算'}},nativeProtocols:['responses']};

export class CodexProvider {
  async listModels(force=false){return modelCapabilities(await this.catalogModels(typeof force==='object'?force.refresh===true:force),['enabled', 'effort', 'serviceTier']);}
  async execute({raw,protocol},context){return{kind:'response',...await this.forward(raw,protocol,context)};}
  snapshot(){return{...sourceSnapshot({...sourceDescription,identityKey:this.auth.identity,configured:!!this.auth.account,connected:!!this.cache&&this.cache.identity===this.auth.identity&&!this.lastError,error:this.lastError,checkedAt:this.cache?.at}),account:this.auth.account?{login:this.auth.account.login}:undefined};}
  constructor({dataDir,fetchImpl=fetch,auth,...options}) {
    this.fetchImpl=fetchImpl;this.auth=auth||new CodexAuth({dataDir,fetchImpl,...options});this.settings=modelSettings(path.join(dataDir,'codex-proxy/settings.json'));this.catalogCache=new CatalogCache();this.auth.onChange=()=>this.catalogCache.invalidate();
  }
  get cache(){return this.catalogCache.value;}
  async read(){return this.auth.read();}
  async quota(){return this.auth.quota();}
  async discover(force=false){return this.auth.read(force);}
  close(){this.catalogCache.invalidate();this.auth.close();}
  async catalogModels(force=false){
    const a=await this.auth.read(),epoch=this.auth.epoch;
    const cached=await this.catalogCache.get({identity:a.identity,refresh:force,load:async()=>{
      const response=await this.fetchImpl('https://api.openai.com/v1/models',{redirect:'error',headers:{Authorization:`Bearer ${a.token}`},signal:AbortSignal.timeout(30000)});
      if(!response.ok){await response.body?.cancel();throw Object.assign(Error(`ChatGPT 模型读取失败（${response.status}）`),{status:response.status});}
      const models=parseModels(await response.json());if(epoch!==this.auth.epoch)throw Object.assign(Error('ChatGPT 账号已切换，请重试'),{status:401});return{models};
    }});this.lastError=null;return applyModelSettings(cached.models,await this.settings.read());
  }
  async status(force=false){try{await this.listModels(force);return{connected:true,authMode:'chatgpt_oauth'};}catch(error){this.lastError=error.status?error.message:'ChatGPT 检测失败，请检查网络或钥匙串后重试';return{connected:false,error:this.lastError};}}
  async setModel(input) {
    const model=(await this.listModels()).find(m=>m.id===input.id);if(!model)throw invalid('模型不存在');
    await this.settings.save(model,input,{fields:['contextWindow', 'maxOutputTokens', 'enabled', 'effort', 'serviceTier'],invalid,error:'不支持的模型设置'});return this.listModels();
  }
  async forward(raw,protocol,{signal,observe=()=>{}}) {
    observe({stage:'discovery'});
    const model=(await this.listModels()).find(m=>m.id===raw.model&&m.enabled);if(!model)throw invalid('模型已停用或不存在');
    observe({stage:'authentication'});
    const a=await this.discover(),epoch=this.auth.epoch;if(a.identity!==this.cache?.identity)throw Object.assign(Error('ChatGPT 账号已切换，请重试'),{status:401});observe({stage:'conversion'});const body=protocol==='responses'?structuredClone(raw):convertRequest(raw,protocol,'responses');
    for(const k of ['previous_response_id','conversation','max_output_tokens','temperature','top_p','truncation','background','max_tool_calls','metadata','moderation','multi_agent','prompt','prompt_cache_retention','safety_identifier','top_logprobs','user'])if(body[k]!=null)throw invalid(`Codex 通道暂不支持 ${k}`,k);
    if(body.store===true)throw invalid('Codex 使用无状态历史，不支持 store=true','store');
    body.model=model.id;body.store=false;body.stream=true;body.instructions??='You are a helpful assistant.';
    if(typeof body.input==='string')body.input=[{role:'user',content:[{type:'input_text',text:body.input}]}];
    for(const item of body.input||[])if(item.role==='system')item.role='developer';
    if(body.tools?.some(t=>['image_generation','file_search','code_interpreter','computer','computer_use_preview','mcp','tool_search'].includes(t.type)))throw invalid('ChatGPT 套餐授权不支持此托管工具','tools');
    if(body.tools?.some(t=>['function','custom'].includes(t.type))){const direct=body.tools.filter(t=>['function','custom'].includes(t.type));body.tools=[...body.tools.filter(t=>!direct.includes(t)),{type:'namespace',name:'daylight',description:'Client tools',tools:direct}];}
    body.include=[...new Set([...(body.include||[]),'reasoning.encrypted_content'])];
    const effort=body.reasoning?.effort??model.effort;
    if(effort!==undefined){if(!model.reasoningEfforts.includes(effort))throw invalid('该 Codex 模型不支持此思考强度','reasoning.effort');body.reasoning={...body.reasoning,effort};}
    let tier=body.service_tier??model.serviceTier;if(tier==='fast')tier='priority';
    if(tier!==undefined){if(!['auto','default',...model.serviceTiers.map(t=>t.id)].includes(tier))throw invalid('该模型未提供此速度档位','service_tier');body.service_tier=tier;}
    const call = credential => this.fetchImpl('https://api.openai.com/v1/responses',{method:'POST',redirect:'error',signal,headers:{Authorization:`Bearer ${credential.token}`,'Content-Type':'application/json',Accept:'text/event-stream'},body:JSON.stringify(body)});
    observe({stage:'upstream'});
    let response=await call(a);
    if(response.status===401){observe({stage:'authentication',retries:1});await response.body?.cancel();const fresh=await this.discover(true);if(fresh.identity!==a.identity||epoch!==this.auth.epoch)throw Object.assign(new Error('Codex 账号已切换，请重新请求'),{status:401});observe({stage:'upstream'});response=await call(fresh);}
    return{response,streaming:true,protocol:'responses',model:model.id,upstreamModel:model.id,requestedTier:tier};
  }
}
