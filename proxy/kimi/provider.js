import {kimiQuota} from '../shared/quota.js';
import {omitKimiTemperature} from './parameters.js';
import os from 'node:os';
import path from 'node:path';
import {readFile,readdir,access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readJson,writeJson,serial} from '../shared/store.js';
import {invalid,convertRequest} from '../shared/protocol.js';

const BASE='https://api.kimi.com/coding/v1';
const authError=message=>Object.assign(new Error(message),{status:401,code:'authentication_error'});

// The official local server owns OAuth refresh and its cross-process token lock.
// Daylight reads only access tokens and never rotates or copies refresh tokens.
export class KimiAuth {
 constructor({home=path.join(os.homedir(),'.kimi-code'),fetchImpl=fetch}={}){Object.assign(this,{home,fetchImpl});}
 async read(){const token=await readJson(path.join(this.home,'credentials/kimi-code.json'),null);if(!token?.access_token)throw authError('请先通过网页登录 Kimi Code');return token;}
 async server(){
  let files=[];try{files=await readdir(path.join(this.home,'server/instances'));}catch{}
  let token;try{token=(await readFile(path.join(this.home,'server.token'),'utf8')).trim();}catch{return null;}
  if(!token)return null;
  for(const file of files.filter(f=>f.endsWith('.json')).reverse()){
   const instance=await readJson(path.join(this.home,'server/instances',file),null).catch(()=>null);
   if(!instance||!['127.0.0.1','localhost'].includes(instance.host)||!Number.isInteger(instance.port)||instance.port<1024||instance.port>65535)continue;
   const url=`http://127.0.0.1:${instance.port}`;
   try{const response=await this.fetchImpl(url+'/api/v1/auth',{redirect:'error',headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(1500)});if(response.ok)return{url,token};await response.body?.cancel();}catch{}
  }
  return null;
 }
 async ensureServer(){
  const existing=await this.server();if(existing)return existing;
  if(!this.starting)this.starting=(async()=>{
   const candidates=[path.join(this.home,'bin/kimi'),...['/opt/homebrew/bin/kimi','/usr/local/bin/kimi'],...(process.env.PATH||'').split(path.delimiter).filter(path.isAbsolute).map(p=>path.join(p,'kimi'))];
   let binary;for(const p of candidates){try{await access(p,constants.X_OK);binary=p;break;}catch{}}
   if(!binary)throw Error('未找到本机 Kimi Code，请先安装官方客户端');
   const child=spawn(binary,['web','--no-open'],{cwd:os.homedir(),stdio:'ignore'});this.child=child;let failed=false;child.on('error',()=>{failed=true;});child.on('exit',()=>{failed=true;});
   for(let i=0;i<30;i++){if(failed)break;await new Promise(r=>setTimeout(r,300));const server=await this.server();if(server)return server;}
   child.kill();throw Error('Kimi 本机授权服务启动失败，请打开官方客户端后重试');
  })().finally(()=>{this.starting=null;});
  return this.starting;
 }
 async request(endpoint,{method='GET',body}={}){
  const {url,token}=await this.ensureServer();let response;
  try{response=await this.fetchImpl(url+'/api/v1/'+endpoint,{method,redirect:'error',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});}catch{throw Error('Kimi 本机授权服务无法连接');}
  if(!response.ok){await response.body?.cancel();throw Error(`Kimi 授权操作失败（${response.status}）`);}
  const result=await response.json();if(result.error)throw Error('Kimi 授权操作失败，请在官方客户端检查登录状态');return result.data;
 }
 async credential(force=false){
  let token=await this.read();
  if(force||token.expires_at*1000<Date.now()+60000){
   const result=await this.request('oauth/userinfo');
   if(result?.kind!=='ok')throw authError('Kimi 授权已失效，请重新网页登录');
   token=await this.read();if(token.expires_at*1000<=Date.now())throw authError('Kimi 授权已过期，请重新网页登录');
  }
  return token;
 }
 async login(){const result=await this.request('oauth/login',{method:'POST',body:{provider:'managed:kimi-code'}});return this.safeLogin(result);}
 async poll(){return this.safeLogin(await this.request('oauth/login'));}
 async cancel(){await this.request('oauth/login',{method:'DELETE'});return{status:'cancelled'};}
 safeLogin(result){if(!result)return null;const url=result.verification_uri_complete||result.verification_uri;let verificationUrl;
  if(url){const parsed=new URL(url);if(parsed.protocol!=='https:'||!['kimi.com','kimi.ai'].some(d=>parsed.hostname===d||parsed.hostname.endsWith('.'+d)))throw Error('Kimi 返回了无效的授权地址');verificationUrl=url;}
  return{status:result.status,url:verificationUrl,userCode:result.user_code,expiresAt:result.expires_at,interval:result.interval};
 }
 close(){this.child?.kill();}
}

export class KimiProvider {
 constructor({dataDir,fetchImpl=fetch,auth=new KimiAuth({fetchImpl})}){Object.assign(this,{fetchImpl,auth});this.file=path.join(dataDir,'kimi-proxy/settings.json');this.mutate=serial();}
 async credential(force=false){const token=await this.auth.credential(force);let account;try{const claims=JSON.parse(Buffer.from(token.access_token.split('.')[1],'base64url'));account=claims.user_id||claims.sub;}catch{}this.identity=createHash('sha256').update(String(account||token.access_token)).digest('hex');return token;}
 async quota(){
  const token=await this.credential();
  const response=await this.fetchImpl(BASE+'/usages',{redirect:'error',headers:{Authorization:`Bearer ${token.access_token}`},signal:AbortSignal.timeout(30000)});
  if(!response.ok){await response.body?.cancel();throw Object.assign(new Error(`Kimi 额度读取失败（${response.status}）`),{status:response.status});}
  return kimiQuota(await response.json());
 }
 async listModels(force=false){
  const token=await this.credential();
  if(force||!this.cache||this.cache.identity!==this.identity||Date.now()-this.cache.at>300000){
   const response=await this.fetchImpl(BASE+'/models',{redirect:'error',headers:{Authorization:`Bearer ${token.access_token}`},signal:AbortSignal.timeout(30000)});
   if(!response.ok){await response.body?.cancel();throw Object.assign(new Error(`Kimi 模型获取失败（${response.status}）`),{status:response.status});}
   const data=await response.json();if(!Array.isArray(data.data))throw Error('Kimi 未返回有效模型列表');
   this.cache={at:Date.now(),identity:this.identity,models:data.data.filter(m=>typeof m.id==='string'&&m.id).map(m=>{
    const efforts=m.reasoning?.effort?.valid || m.think_efforts?.valid_efforts || [];
    const reasoningEfforts=Array.isArray(efforts)?[...new Set(efforts.filter(e=>typeof e==='string'))]:[];
    const thinkingType=m.reasoning?.type || m.supports_thinking_type;
    return {id:m.id,displayName:m.display_name||m.id,provider:'kimi',source:'kimi',enabled:true,contextWindow:m.context_length||m.limit?.context||undefined,maxOutputTokens:m.max_output_tokens||m.limit?.max_output_tokens||undefined,contextWindows:[],reasoningEfforts,defaultEffort:m.reasoning?.effort?.default||m.think_efforts?.default_effort,thinkingType,...(thinkingType==='only'?{thinkingLevelMap:{off:null}}:{}),isVL:!!m.supports_image_in,isReasoning:!!m.supports_reasoning,capabilities:{nativeChat:true,tools:true}};
   })};
  }
  const settings=await readJson(this.file,{});this.lastError=null;return this.cache.models.map(m=>({...m,enabled:!settings.disabled?.includes(m.id),effort:settings.efforts?.[m.id]}));
 }
 async status(force=false){try{const models=await this.listModels(force);return{connected:true,authMode:'kimi_oauth',models};}catch(error){this.lastError=error.message;return{connected:false,error:this.lastError};}}
 async setModel({id,field,value}){return this.mutate(async()=>{
  const model=(await this.listModels()).find(m=>m.id===id);if(!model)throw invalid('模型不存在');
  const s=await readJson(this.file,{});
  if(field==='enabled'&&typeof value==='boolean')s.disabled=value?(s.disabled||[]).filter(m=>m!==id):[...new Set([...(s.disabled||[]),id])];
  else if(field==='effort'&&(value==='auto'||model.reasoningEfforts.includes(value))){s.efforts||={};if(value==='auto')delete s.efforts[id];else s.efforts[id]=value;}
  else throw invalid('不支持的模型设置');
  await writeJson(this.file,s);return this.listModels();
 });}
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
 close(){this.auth.close?.();}
}
