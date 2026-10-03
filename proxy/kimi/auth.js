import os from 'node:os';
import path from 'node:path';
import {readFile,readdir,access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {spawn} from 'node:child_process';
import {readJson} from '../shared/store.js';
export const authError=message=>Object.assign(new Error(message),{status:401,code:'authentication_error'});

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
