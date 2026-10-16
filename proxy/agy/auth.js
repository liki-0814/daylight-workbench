import {readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {LoopbackOAuthAccount} from '../shared/loopback-account.js';
import {oauthError} from '../shared/oauth-account.js';
import {Secrets} from '../shared/secrets.js';
import {readJson,writeJson} from '../shared/store.js';
import {discoverModels} from './models.js';
import {loadOAuthClient} from './oauth-client.js';

const AUTH='https://accounts.google.com/o/oauth2/v2/auth',TOKEN='https://oauth2.googleapis.com/token',USER='https://www.googleapis.com/oauth2/v2/userinfo?alt=json';
const SCOPES=['https://www.googleapis.com/auth/cloud-platform','https://www.googleapis.com/auth/userinfo.email','https://www.googleapis.com/auth/userinfo.profile','https://www.googleapis.com/auth/cclog','https://www.googleapis.com/auth/experimentsandconfigs'];
export class AgyAuth extends LoopbackOAuthAccount {
 constructor({dataDir,callbackPort=51121,getOAuthClientImpl=loadOAuthClient,tokenFile=path.join(os.homedir(),'.gemini/antigravity-cli/antigravity-oauth-token'),readFileImpl=readFile,credentials=new Secrets({helperName:'DaylightAgyCredentials',timeoutMs:15000}),...options}={}){
  super({id:'agy',name:'AGY',...options});Object.assign(this,{callbackPort,getOAuthClientImpl,tokenFile,readFileImpl,credentials});this.migrationFile=path.join(dataDir,'agy/auth.json');
 }
 async models(catalog){return discoverModels(catalog);}
 async client(method='consumer',clientId){const client=await this.getOAuthClientImpl(method);if(!client||clientId&&client.client_id!==clientId)throw oauthError('AGY OAuth 客户端已变化，请重新网页登录');return client;}
 async refreshFields(saved){return{client_secret:(await this.client(saved.method,saved.clientId)).client_secret};}
 async profile(token,signal){const user=await this.request(USER,{token,signal});if(!user.id)throw oauthError('AGY 未返回有效账号');return{id:String(user.id),login:user.email||user.name||String(user.id)};}
 async validateRefresh(next,saved){if((await this.profile(next.access_token)).id!==saved.account.id)throw oauthError('AGY 账号身份已变化，请重新网页登录');}
 async login(){
  const p=this.beginBrowserLogin();
  try{
   p.client=await this.client();if(p!==this.pending)return{status:'cancelled'};
   await this.openCallback(p,{port:this.callbackPort,hostname:'localhost',pathname:'/oauth-callback'});
   p.url=AUTH+'?'+new URLSearchParams({client_id:p.client.client_id,response_type:'code',redirect_uri:p.redirectUri,scope:SCOPES.join(' '),access_type:'offline',prompt:'consent',state:p.state,code_challenge_method:'S256',code_challenge:createHash('sha256').update(p.verifier).digest('base64url')});return this.publicLogin();
  }catch(error){if(p===this.pending)this.cancelPending();throw error.code==='EADDRINUSE'?oauthError('AGY 登录回调端口被占用，请结束其他授权后重试'):error;}
 }
 async exchange(q,p){
  const data=await this.request(TOKEN,{form:{grant_type:'authorization_code',client_id:p.client.client_id,client_secret:p.client.client_secret,code:q.get('code'),redirect_uri:p.redirectUri,code_verifier:p.verifier},signal:p.controller.signal});
  if(data.error)throw oauthError('AGY 授权码交换失败，请重新网页登录');
  return this.session(data,{clientId:p.client.client_id,method:'consumer',tokenEndpoint:TOKEN,account:await this.profile(data.access_token,p.controller.signal)});
 }
 // One-time compatibility import. Never rotate, modify or delete the CLI's original record.
 async importLegacy(){
  if(this.pending||await this.secrets.get(this.key)||((await readJson(this.migrationFile,{})).disabled))return;
  const epoch=this.epoch;let text;
  if(this.tokenFile)try{text=await this.readFileImpl(this.tokenFile,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  text=(text??await this.credentials.get('antigravity')??'').trim();if(!text)return;
  const value=JSON.parse(text.startsWith('go-keyring-base64:')?Buffer.from(text.slice(18),'base64').toString():text),method=value.auth_method||'consumer',client=await this.client(method);
  if(!value.token?.access_token)throw oauthError('原 AGY 登录不可读取，请网页登录');
  let session={access_token:value.token.access_token,refresh_token:value.token.refresh_token,expiresAt:Date.parse(value.token.expiry),clientId:client.client_id,method,tokenEndpoint:TOKEN};
  if(!(session.expiresAt>this.now()+60000)){
   const data=await this.request(TOKEN,{form:{grant_type:'refresh_token',client_id:client.client_id,client_secret:client.client_secret,refresh_token:session.refresh_token}});
   if(data.error)throw oauthError('原 AGY 登录已失效，请网页登录');session=this.session(data,session);
  }
  session.account=await this.profile(session.access_token);await this.commit(session,epoch);this.accountChanged();
 }
 async token(force=false){
  if(!this.migration)this.migration=this.importLegacy().catch(()=>{});
  await this.migration;return(await this.getSession(force)).access_token;
 }
 async refresh(){await this.token(true);return{ok:true};}
 async logout(){await writeJson(this.migrationFile,{disabled:true});return super.logout();}
}
