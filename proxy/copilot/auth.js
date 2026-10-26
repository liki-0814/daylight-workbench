import {createHash,randomUUID} from 'node:crypto';
import {DeviceOAuthAccount} from '../shared/oauth-account.js';

// Public OAuth client used by copilot-api; no client secret or local CLI required.
const CLIENT_ID='Iv1.b507a08c87ecfe98';
export const authError=message=>Object.assign(new Error(message),{status:401,code:'authentication_error'});
export const githubHeaders=token=>({Accept:'application/json','Content-Type':'application/json','User-Agent':'GitHubCopilotChat/0.26.7','editor-version':'vscode/1.104.3','editor-plugin-version':'copilot-chat/0.26.7',...(token?{Authorization:`token ${token}`}:{})});
// Older API versions hide the extended-context tiers even for entitled accounts.
export const copilotHeaders=token=>({...githubHeaders(),Authorization:`Bearer ${token}`,'copilot-integration-id':'vscode-chat','openai-intent':'conversation-panel','x-github-api-version':'2026-08-01','x-request-id':randomUUID()});
export function copilotEndpoint(value='https://api.githubcopilot.com'){
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||url.pathname!=='/'||!(url.hostname==='api.githubcopilot.com'||/^api\.[a-z0-9-]+\.githubcopilot\.com$/.test(url.hostname)))throw Error('Copilot 返回了无效的 API 地址');
 return url.origin;
}

export class CopilotAuth extends DeviceOAuthAccount {
 constructor(options={}){super({id:'copilot',name:'GitHub Copilot',...options});}
 async request(url,{token,body,signal}={}){
  const response=await this.fetchImpl(url,{method:body?'POST':'GET',redirect:'error',headers:githubHeaders(token),...(body?{body:JSON.stringify(body)}:{}),signal:this.requestSignal(signal)});
  if(!response.ok){await response.body?.cancel();throw Object.assign(new Error(response.status===403?'GitHub Copilot 访问被拒绝，请检查订阅或组织授权':response.status===401?'GitHub 授权已失效，请重新网页登录':`GitHub 授权请求失败（${response.status}）`),{status:response.status});}
  return response.json();
 }
 // Keep the existing GitHub Keychain record and the separate Copilot-token exchange.
 accessToken(session){return session?.accessToken;}
 sessionIdentity(session){return createHash('sha256').update(String(session.account.id)).digest('hex');}
 accountChanged(){this.token=null;super.accountChanged();}
 async flow(){return{clientId:CLIENT_ID,scope:'read:user',deviceEndpoint:'https://github.com/login/device/code',tokenEndpoint:'https://github.com/login/oauth/access_token'};}
 deviceRequest(url,fields,signal){return this.request(url,{body:fields,signal});}
 verificationURL(data){if(data.verification_uri!=='https://github.com/login/device')throw Error('GitHub 返回了无效的授权信息');return data.verification_uri;}
 session(data){
  if(typeof data.access_token!=='string'||!data.access_token)throw Error('GitHub 未返回授权凭证');
  return{accessToken:data.access_token,...(data.expires_in?{expiresAt:this.now()+data.expires_in*1000}:{})};
 }
 async profile(data,config,signal){const user=await this.request('https://api.github.com/user',{token:data.access_token,signal});if(!user.id||typeof user.login!=='string')throw Error('GitHub 未返回有效账号');return{id:String(user.id),login:user.login};}
 async refresh(){await this.credential(true);return{ok:true};}
 async read(){const value=await this.readSession();if(value.expiresAt&&value.expiresAt<=this.now())throw authError('请通过 GitHub 网页登录 Copilot');return value;}
 async credential(force=false){
  const epoch=this.epoch,saved=await this.read(),identity=this.sessionIdentity(saved);
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
 close(){super.close();this.token=null;}
}
