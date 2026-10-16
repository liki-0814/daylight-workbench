import {createHash,randomUUID} from 'node:crypto';
import {Secrets} from '../shared/secrets.js';
import {serial} from '../shared/store.js';

// Public OAuth client used by copilot-api; no client secret or local CLI required.
const CLIENT_ID='Iv1.b507a08c87ecfe98',KEY='copilot-oauth';
export const authError=message=>Object.assign(new Error(message),{status:401,code:'authentication_error'});
export const githubHeaders=token=>({Accept:'application/json','Content-Type':'application/json','User-Agent':'GitHubCopilotChat/0.26.7','editor-version':'vscode/1.104.3','editor-plugin-version':'copilot-chat/0.26.7',...(token?{Authorization:`token ${token}`}:{})});
export const copilotHeaders=token=>({...githubHeaders(),Authorization:`Bearer ${token}`,'copilot-integration-id':'vscode-chat','openai-intent':'conversation-panel','x-github-api-version':'2025-04-01','x-request-id':randomUUID()});
export function copilotEndpoint(value='https://api.githubcopilot.com'){
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||url.pathname!=='/'||!(url.hostname==='api.githubcopilot.com'||/^api\.[a-z0-9-]+\.githubcopilot\.com$/.test(url.hostname)))throw Error('Copilot 返回了无效的 API 地址');
 return url.origin;
}

export class CopilotAuth {
 constructor({fetchImpl=fetch,secrets=new Secrets(),now=Date.now}={}){Object.assign(this,{fetchImpl,secrets,now});this.mutate=serial();this.epoch=0;}
 async request(url,{token,body,signal}={}){
  const response=await this.fetchImpl(url,{method:body?'POST':'GET',redirect:'error',headers:githubHeaders(token),...(body?{body:JSON.stringify(body)}:{}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
  if(!response.ok){await response.body?.cancel();throw Object.assign(new Error(response.status===403?'GitHub Copilot 访问被拒绝，请检查订阅或组织授权':response.status===401?'GitHub 授权已失效，请重新网页登录':`GitHub 授权请求失败（${response.status}）`),{status:response.status});}
  return response.json();
 }
 publicLogin(p=this.pending){return p?{status:'pending',url:p.url,userCode:p.userCode,expiresAt:p.expiresAt,interval:p.interval}:null;}
 async login(){
  this.cancelPending();const epoch=this.epoch,controller=new AbortController();this.controller=controller;
  const data=await this.request('https://github.com/login/device/code',{body:{client_id:CLIENT_ID,scope:'read:user'},signal:controller.signal});
  if(epoch!==this.epoch)return{status:'cancelled'};
  if(data.verification_uri!=='https://github.com/login/device'||!data.device_code||!data.user_code||!Number.isFinite(data.expires_in)||data.expires_in<=0)throw Error('GitHub 返回了无效的授权信息');
  const interval=Math.max(5,Number(data.interval)||5);
  this.pending={deviceCode:data.device_code,url:data.verification_uri,userCode:data.user_code,expiresAt:this.now()+data.expires_in*1000,interval,nextPoll:this.now()+interval*1000,controller,epoch};
  return this.publicLogin();
 }
 async poll(){
  const p=this.pending;if(!p)return null;
  if(this.now()>=p.expiresAt){this.cancelPending();return{status:'expired'};}
  if(this.polling)return this.polling;
  if(this.now()<p.nextPoll)return this.publicLogin(p);
  const task=(async()=>{
   p.nextPoll=this.now()+p.interval*1000;
   const data=await this.request('https://github.com/login/oauth/access_token',{body:{client_id:CLIENT_ID,device_code:p.deviceCode,grant_type:'urn:ietf:params:oauth:grant-type:device_code'},signal:p.controller.signal});
   if(p!==this.pending)return{status:'cancelled'};
   if(data.error==='slow_down'){p.interval+=5;p.nextPoll=this.now()+p.interval*1000;return this.publicLogin(p);}
   if(data.error==='authorization_pending')return this.publicLogin(p);
   if(data.error){this.cancelPending();return{status:({access_denied:'denied',expired_token:'expired'})[data.error]||'failed'};}
   if(typeof data.access_token!=='string'||!data.access_token)throw Error('GitHub 未返回授权凭证');
   const user=await this.request('https://api.github.com/user',{token:data.access_token,signal:p.controller.signal});
   if(!user.id||typeof user.login!=='string')throw Error('GitHub 未返回有效账号');
   return this.mutate(async()=>{
    if(p!==this.pending)return{status:'cancelled'};
    const account={id:String(user.id),login:user.login};
    const previous=await this.secrets.get(KEY);
    if(p!==this.pending)return{status:'cancelled'};
    await this.secrets.set(KEY,JSON.stringify({accessToken:data.access_token,account,...(data.expires_in?{expiresAt:this.now()+data.expires_in*1000}:{})}));
    if(p!==this.pending){if(previous)await this.secrets.set(KEY,previous);else await this.secrets.delete(KEY);return{status:'cancelled'};}
    this.account=account;this.token=null;this.pending=null;
    return{status:'authenticated',authorized:true};
   });
  })();this.polling=task;
  try{return await task;}finally{if(this.polling===task)this.polling=null;}
 }
 cancelPending(){this.epoch++;this.controller?.abort();this.pending=null;this.polling=null;}
 async cancel(){this.cancelPending();return{status:'cancelled'};}
 async refresh(){await this.credential(true);return{ok:true};}
 async logout(){this.cancelPending();return this.mutate(async()=>{await this.secrets.delete(KEY);this.account=null;this.token=null;return{status:'logged_out'};});}
 async read(){
  const epoch=this.epoch,raw=await this.secrets.get(KEY);if(epoch!==this.epoch)throw authError('Copilot 登录状态已变化，请重新请求');let value;try{value=JSON.parse(raw);}catch{}
  this.account=value?.account;
  if(!value?.accessToken||!value.account?.id||value.expiresAt&&value.expiresAt<=this.now())throw authError('请通过 GitHub 网页登录 Copilot');
  return value;
 }
 async credential(force=false){
  const epoch=this.epoch,saved=await this.read(),identity=createHash('sha256').update(saved.account.id).digest('hex');
  if(epoch!==this.epoch)throw authError('Copilot 登录状态已变化，请重新请求');
  if(!force&&this.token?.identity===identity&&this.token.expiresAt>this.now()+60000)return this.token;
  if(this.refreshing?.identity===identity&&this.refreshing.epoch===epoch)return this.refreshing.task;
  const task=(async()=>{
   const data=await this.request('https://api.github.com/copilot_internal/v2/token',{token:saved.accessToken});
   if(epoch!==this.epoch)throw authError('Copilot 登录状态已变化，请重新请求');
   if(typeof data.token!=='string'||!data.token||!Number.isFinite(data.expires_at)||data.expires_at*1000<=this.now())throw authError('Copilot 未返回有效凭证，请检查订阅后重新登录');
   const proxy=data.token.match(/(?:^|;)proxy-ep=([^;]+)/)?.[1];
   return this.token={token:data.token,identity,expiresAt:data.expires_at*1000,baseUrl:copilotEndpoint(data.endpoints?.api||(proxy?'https://'+proxy.replace(/^proxy\./,'api.'):undefined))};
  })();this.refreshing={identity,epoch,task};
  try{return await task;}finally{if(this.refreshing?.task===task)this.refreshing=null;}
 }
 close(){this.cancelPending();this.token=null;}
}
