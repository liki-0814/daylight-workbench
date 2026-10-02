import {codexQuota} from '../shared/quota.js';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {RPC, executable} from '../../ai/adapters/process.mjs';
import {readJson,writeJson,serial} from '../shared/store.js';
import {invalid,convertRequest} from '../shared/protocol.js';

export class CodexProvider {
  constructor({dataDir,fetchImpl=fetch,home=process.env.CODEX_HOME || path.join(os.homedir(),'.codex'),rpcFactory=()=>new RPC(executable('codex'),['app-server','--listen','stdio://'],os.homedir())}) {
    Object.assign(this,{home,fetchImpl,rpcFactory});this.file=path.join(dataDir,'codex-proxy/settings.json');this.mutate=serial();
  }
  async quota() {
    await this.read();
    const rpc=this.rpcFactory();
    try {await rpc.initialize();await rpc.call('account/read',{refreshToken:true});return codexQuota(await rpc.call('account/rateLimits/read',{}));}
    finally {rpc.close();}
  }
  async read() {
    const a=await readJson(path.join(this.home,'auth.json'),null);
    if(a?.auth_mode!=='chatgpt'||!a.tokens?.access_token||!a.tokens?.account_id)throw Object.assign(new Error('请先在本机 Codex 登录 ChatGPT，再刷新登录'),{status:401});
    let exp=0;try{exp=JSON.parse(Buffer.from(a.tokens.access_token.split('.')[1],'base64url')).exp*1000;}catch{}
    this.identity=createHash('sha256').update(a.tokens.account_id).digest('hex');
    return {token:a.tokens.access_token,account:a.tokens.account_id,exp,identity:this.identity};
  }
  async discover(force=false) {
    let a=await this.read();
    if(!force&&this.cache?.identity===a.identity&&Date.now()-this.cache.at<300000&&a.exp>Date.now()+60000)return a;
    if(!this.loading){
      this.loading=(async()=>{
        const rpc=this.rpcFactory();
        try {await rpc.initialize();await rpc.call('account/read',{refreshToken:true});const all=[];let cursor;
          do {const r=await rpc.call('model/list',{limit:100,...(cursor?{cursor}:{})});all.push(...r.data);cursor=r.nextCursor;}while(cursor);
          const current=await this.read();const meta=await readJson(path.join(this.home,'models_cache.json'),{models:[]});
          this.cache={identity:current.identity,at:Date.now(),models:all.filter(m=>!m.hidden).map(m=>{
            const c=meta.models?.find(x=>x.slug===m.model)||{};
            return {id:m.model,provider:'codex',source:'codex',displayName:m.displayName||m.model,enabled:true,contextWindows:[],contextWindow:c.context_window,maxOutputTokens:c.max_output_tokens,
              isVL:m.inputModalities?.includes('image')||false,isReasoning:true,reasoningEfforts:(m.supportedReasoningEfforts||[]).map(e=>e.reasoningEffort).filter(e=>e!=='ultra'),defaultEffort:m.defaultReasoningEffort,
              serviceTiers:m.serviceTiers||[],capabilities:{nativeResponses:true,service_tiers:m.serviceTiers||[],tools:true}};
          })};return current;
        }finally{rpc.close();}
      })().finally(()=>{this.loading=null;});
    }
    a=await this.loading;return a;
  }
  async listModels(force=false){await this.discover(force);const s=await readJson(this.file,{});return this.cache.models.map(m=>({...m,enabled:!s.disabled?.includes(m.id),effort:s.efforts?.[m.id],serviceTier:s.tiers?.[m.id]}));}
  async status(force=false){try{await this.listModels(force);this.lastError=null;return{connected:true,authMode:'codex_oauth'};}catch{this.lastError='无法读取本机 Codex 登录，请在 Codex 登录后刷新';return{connected:false,error:this.lastError};}}
  async setModel({id,field,value}){return this.mutate(async()=>{const m=(await this.listModels()).find(m=>m.id===id);if(!m)throw invalid('模型不存在');const s=await readJson(this.file,{});
    if(field==='enabled'&&typeof value==='boolean')s.disabled=value?(s.disabled||[]).filter(x=>x!==id):[...new Set([...(s.disabled||[]),id])];
    else if(field==='effort'&&(value==='auto'||m.reasoningEfforts.includes(value))){s.efforts||={};if(value==='auto')delete s.efforts[id];else s.efforts[id]=value;}
    else if(field==='serviceTier'&&(['auto','default',...m.serviceTiers.map(t=>t.id)].includes(value))){s.tiers||={};if(value==='auto')delete s.tiers[id];else s.tiers[id]=value;}
    else throw invalid('不支持的模型设置');await writeJson(this.file,s);return this.listModels();});}
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
