import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {oauthError} from '../shared/oauth-account.js';
import {LoopbackOAuthAccount} from '../shared/loopback-account.js';
import {verifyIdentity} from '../shared/oidc.js';
import {readJson,writeJson,serial} from '../shared/store.js';
const ISSUER='https://auth.openai.com',TOKEN=ISSUER+'/api/accounts/oauth/token',RESOURCE='https://api.openai.com/v1';
export class CodexAuth extends LoopbackOAuthAccount {
 constructor({dataDir,...options}={}){super({id:'codex',name:'ChatGPT',...options});this.hostFile=path.join(dataDir,'codex-proxy/host.json');this.host=serial();}
 refreshFields(){return{resource:RESOURCE};}
 async validateRefresh(next,saved){
  if(next.id_token&&next.id_token!==saved.id_token)await verifyIdentity(next.id_token,{issuer:ISSUER,clientId:saved.clientId,subject:saved.account.id,fetchImpl:this.fetchImpl,now:this.now()});
 }
 async hostIdentity(){return this.host(async()=>{let data=await readJson(this.hostFile,null);if(!data){data={hostId:'urn:uuid:'+randomUUID()};await writeJson(this.hostFile,data);}return data;});}
 async login(){
  const p=this.beginBrowserLogin();
  try{
   const host=await this.hostIdentity();let saved;
   try{saved=await this.readSession();}catch(error){if(error.status!==401)throw error;}
   if(p!==this.pending)return{status:'cancelled'};
   p.saved=saved;p.clientId=saved?.clientId||host.pendingClientId||'dynamic_agent_client';
   await this.openCallback(p);
   const params={client_id:p.clientId,ext_agent_host_id:host.hostId,response_type:'code',redirect_uri:p.redirectUri,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',resource:RESOURCE,state:p.state,nonce:p.nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(p.verifier).digest('base64url'),...(p.clientId==='dynamic_agent_client'?{agent_name_hint:'Daylight'}:{}),...(saved?.id_token?{id_token_hint:saved.id_token}:{})};
   p.url=ISSUER+'/api/accounts/authorize?'+new URLSearchParams(params);
   return this.publicLogin();
  }catch(error){if(p===this.pending)this.cancelPending();throw error;}
 }
 validCallback(q,p){const clientId=q.get('client_id')||p.clientId;return clientId!=='dynamic_agent_client'&&(p.clientId==='dynamic_agent_client'||clientId===p.clientId)&&(/^[a-zA-Z0-9._-]{1,256}$/).test(clientId);}
 async exchange(q,p){
  const clientId=q.get('client_id')||p.clientId;
  // Persist issued registration before exchanging a one-use code; no token is written here.
  await this.host(async()=>{const host=await readJson(this.hostFile,{});if(p!==this.pending)throw oauthError('登录已取消');await writeJson(this.hostFile,{...host,pendingClientId:clientId});});
  const data=await this.request(TOKEN,{form:{grant_type:'authorization_code',client_id:clientId,code:q.get('code'),code_verifier:p.verifier,redirect_uri:p.redirectUri,resource:RESOURCE},signal:p.controller.signal});
  if(data.error)throw oauthError('ChatGPT 授权码交换失败，请重新网页登录');
  const identity=await verifyIdentity(data.id_token,{issuer:ISSUER,clientId,nonce:p.nonce,subject:p.saved?.account.id,fetchImpl:this.fetchImpl,now:this.now()});
  const session=this.session(data,{clientId,tokenEndpoint:TOKEN,account:{id:identity.sub,login:identity.email||identity.name||identity.sub}});
  await this.validateRefresh(session,session);return session;
 }
 async read(force=false){const s=await this.getSession(force);if(!s.scope?.split(' ').includes('chatgpt.tokens.use.direct'))throw oauthError('ChatGPT 账号未授权套餐调用，请刷新登录并授权');return{token:s.access_token,account:s.account.id,exp:s.expiresAt,identity:s.identity};}
 async refresh(){const saved=await this.readSession();if(!saved.scope?.split(' ').includes('chatgpt.tokens.use.direct'))return this.login();return super.refresh();}
 async quota(){await this.read();return{buckets:[],checkedAt:new Date().toISOString()};}
 async logout(){const result=await super.logout();await this.host(async()=>{const host=await readJson(this.hostFile,null);if(host){delete host.pendingClientId;await writeJson(this.hostFile,host);}});return result;}
}
