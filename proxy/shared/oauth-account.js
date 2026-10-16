import {createHash} from 'node:crypto';
import {Secrets} from './secrets.js';
import {serial} from './store.js';

export const oauthError=message=>Object.assign(new Error(message),{status:401,code:'source_auth_required'});
export function trustedURL(value,domains){
 let url;try{url=new URL(value);}catch{throw Error('授权服务返回了无效地址');}
 if(url.protocol!=='https:'||url.username||url.password||url.port||!domains.some(host=>url.hostname===host||url.hostname.endsWith('.'+host)))throw Error('授权服务返回了不可信地址');
 return url.href;
}
// Daylight owns these credentials. Never read, rotate or delete a CLI's token file.
export class OAuthAccount {
 constructor({id,name,fetchImpl=fetch,secrets=new Secrets(),now=Date.now}){Object.assign(this,{id,name,fetchImpl,secrets,now});this.key=id+'-oauth';this.epoch=0;this.mutate=serial();}
 async request(url,{form,token,headers={},signal}={}){
  const response=await this.fetchImpl(url,{method:form?'POST':'GET',redirect:'error',headers:{Accept:'application/json','User-Agent':'Daylight/0.4.0',...(form?{'Content-Type':'application/x-www-form-urlencoded'}:{}),...(token?{Authorization:`Bearer ${token}`} :{}),...headers},...(form?{body:new URLSearchParams(form).toString()}:{}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
  let data;try{data=await response.json();}catch{throw Error(`${this.name} 授权服务返回无效响应`);}
  if(!response.ok&&!data.error)throw Object.assign(Error(`${this.name} 授权请求失败（${response.status}）`),{status:response.status});
  return data;
 }
 async readSession(){
  if(this.closed)throw oauthError(`${this.name} 来源已关闭`);
  const epoch=this.epoch,raw=await this.secrets.get(this.key);if(epoch!==this.epoch)throw oauthError('登录状态已变化，请重新请求');
  let session;try{session=JSON.parse(raw);}catch{}
  this.account=session?.account;this.identity=session?.identity;
  if(!session?.access_token||!session.account?.id)throw oauthError(`请在 Daylight 中网页登录 ${this.name}`);
  return session;
 }
 session(data,previous={}){
  if(typeof data.access_token!=='string'||!data.access_token||!Number.isFinite(data.expires_in)||data.expires_in<=0)throw oauthError(`${this.name} 未返回有效令牌`);
  return{...previous,access_token:data.access_token,refresh_token:data.refresh_token||previous.refresh_token,id_token:data.id_token||previous.id_token,expiresAt:this.now()+data.expires_in*1000,scope:data.scope??previous.scope};
 }
 async commit(session,epoch){return this.mutate(async()=>{
  if(epoch!==this.epoch)throw oauthError('登录状态已变化，请重新请求');
  session.identity=createHash('sha256').update(JSON.stringify([this.id,session.account.id,session.clientId])).digest('hex');
  const old=await this.secrets.get(this.key);if(epoch!==this.epoch)throw oauthError('登录状态已变化，请重新请求');
  await this.secrets.set(this.key,JSON.stringify(session));
  if(epoch!==this.epoch){if(old)await this.secrets.set(this.key,old);else await this.secrets.delete(this.key);throw oauthError('登录已取消');}
  this.account=session.account;this.identity=session.identity;return session;
 });}
 async getSession(force=false){
  const epoch=this.epoch,saved=await this.readSession();
  if(!force&&saved.expiresAt>this.now()+60000)return saved;
  if(this.refreshing?.epoch===epoch&&this.refreshing.identity===saved.identity)return this.refreshing.task;
  const task=(async()=>{
   if(!saved.refresh_token)throw oauthError(`${this.name} 登录已过期，请重新网页登录`);
   const data=await this.request(saved.tokenEndpoint,{form:{client_id:saved.clientId,grant_type:'refresh_token',refresh_token:saved.refresh_token,...this.refreshFields?.(saved)},headers:await this.headers?.()});
   if(data.error)throw oauthError(`${this.name} 续期失败，请重新网页登录`);
   const next=this.session(data,saved);await this.validateRefresh?.(next,saved);
   return this.commit(next,epoch);
  })();this.refreshing={epoch,identity:saved.identity,task};
  try{return await task;}finally{if(this.refreshing?.task===task)this.refreshing=null;}
 }
 cancelPending(){this.epoch++;this.pending?.controller.abort();this.pending=null;this.polling=null;this.stopListener?.();}
 async cancel(){this.cancelPending();return{status:'cancelled'};}
 async refresh(){await this.getSession(true);return{ok:true};}
 async logout(){this.cancelPending();return this.mutate(async()=>{await this.secrets.delete(this.key);this.account=null;this.identity=null;this.onChange?.();return{status:'logged_out'};});}
 close(){this.closed=true;this.cancelPending();}
}

export class DeviceOAuthAccount extends OAuthAccount {
 publicLogin(p=this.pending){return p?{status:p.status||'pending',url:p.url,userCode:p.userCode,expiresAt:p.expiresAt,interval:p.interval,...(p.error?{error:p.error}:{})}:null;}
 async login(){
  this.cancelPending();const p={epoch:this.epoch,controller:new AbortController()};this.pending=p;
  try{
   const config=await this.flow();if(p!==this.pending)return{status:'cancelled'};
   const data=await this.request(config.deviceEndpoint,{form:{client_id:config.clientId,...(config.scope?{scope:config.scope}:{})},headers:await this.headers?.(),signal:p.controller.signal});
   if(p!==this.pending)return{status:'cancelled'};
   if(data.error||typeof data.device_code!=='string'||typeof data.user_code!=='string'||!Number.isFinite(data.expires_in)||data.expires_in<=0)throw Error(`${this.name} 未返回有效授权信息`);
   const interval=Math.max(5,Number(data.interval)||5),url=trustedURL(data.verification_uri_complete||data.verification_uri,config.domains);
   Object.assign(p,{config,deviceCode:data.device_code,userCode:data.user_code,url,expiresAt:this.now()+data.expires_in*1000,interval,nextPoll:this.now()+interval*1000});return this.publicLogin(p);
  }catch(error){if(this.pending===p)this.cancelPending();throw error;}
 }
 async poll(){
  const p=this.pending;if(!p)return null;if(!p.config)return{status:'pending'};
  if(this.now()>=p.expiresAt){this.cancelPending();return{status:'expired'};}
  if(this.polling)return this.polling;if(this.now()<p.nextPoll)return this.publicLogin(p);
  const task=(async()=>{
   p.nextPoll=this.now()+p.interval*1000;
   const data=await this.request(p.config.tokenEndpoint,{form:{client_id:p.config.clientId,device_code:p.deviceCode,grant_type:'urn:ietf:params:oauth:grant-type:device_code'},headers:await this.headers?.(),signal:p.controller.signal});
   if(p!==this.pending)return{status:'cancelled'};
   if(data.error==='authorization_pending')return this.publicLogin(p);
   if(data.error==='slow_down'){p.interval+=5;p.nextPoll=this.now()+p.interval*1000;return this.publicLogin(p);}
   if(data.error){this.cancelPending();return{status:({access_denied:'denied',expired_token:'expired'})[data.error]||'failed'};}
   const session=this.session(data);session.account=await this.profile(data,p.config,p.controller.signal);session.clientId=p.config.clientId;session.tokenEndpoint=p.config.tokenEndpoint;
   if(!session.account?.id)throw oauthError(`${this.name} 未返回有效账号`);
   await this.commit(session,p.epoch);if(p!==this.pending)return{status:'cancelled'};this.pending=null;this.onChange?.();return{status:'authenticated',authorized:true};
  })();this.polling=task;try{return await task;}finally{if(this.polling===task)this.polling=null;}
 }
}
