import http from 'node:http';
import path from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {OAuthAccount,oauthError} from '../shared/oauth-account.js';
import {verifyIdentity} from '../shared/oidc.js';
import {readJson,writeJson,serial} from '../shared/store.js';
const ISSUER='https://auth.openai.com',TOKEN=ISSUER+'/api/accounts/oauth/token',RESOURCE='https://api.openai.com/v1';
export class CodexAuth extends OAuthAccount {
 constructor({dataDir,...options}={}){super({id:'codex',name:'ChatGPT',...options});this.hostFile=path.join(dataDir,'codex-proxy/host.json');this.host=serial();}
 refreshFields(){return{resource:RESOURCE};}
 async validateRefresh(next,saved){
  if(next.id_token&&next.id_token!==saved.id_token)await verifyIdentity(next.id_token,{issuer:ISSUER,clientId:saved.clientId,subject:saved.account.id,fetchImpl:this.fetchImpl,now:this.now()});
 }
 async hostIdentity(){return this.host(async()=>{let data=await readJson(this.hostFile,null);if(!data){data={hostId:'urn:uuid:'+randomUUID()};await writeJson(this.hostFile,data);}return data;});}
 publicLogin(){const p=this.pending;return p?{status:p.result?.status||'pending',url:p.url,expiresAt:p.expiresAt,interval:3,...(p.result||{})}:null;}
 stopListener(owner){if(owner&&owner!==this.listenerOwner)return;clearTimeout(this.listenerTimer);this.listener?.close();this.listener?.closeAllConnections();this.listener=null;}
 async login(){
  this.cancelPending();const p={epoch:this.epoch,controller:new AbortController(),state:randomBytes(32).toString('base64url'),nonce:randomBytes(32).toString('base64url'),verifier:randomBytes(32).toString('base64url'),expiresAt:this.now()+300000};this.pending=p;
  try{
   const host=await this.hostIdentity();let saved;
   try{saved=await this.readSession();}catch(error){if(error.status!==401)throw error;}
   if(p!==this.pending)return{status:'cancelled'};
   p.saved=saved;p.clientId=saved?.clientId||host.pendingClientId||'dynamic_agent_client';
   const server=http.createServer((req,res)=>{void this.callback(req,res,p).catch(()=>{if(!res.headersSent){res.writeHead(400,{'Content-Type':'text/plain; charset=utf-8'});res.end('登录未完成，请返回 Daylight 重试。');}});});this.listener=server;this.listenerOwner=p;
   await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});server.unref();
   if(p!==this.pending){server.close();return{status:'cancelled'};}
   p.redirectUri=`http://127.0.0.1:${server.address().port}/auth/callback`;
   const params={client_id:p.clientId,ext_agent_host_id:host.hostId,response_type:'code',redirect_uri:p.redirectUri,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',resource:RESOURCE,state:p.state,nonce:p.nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(p.verifier).digest('base64url'),...(p.clientId==='dynamic_agent_client'?{agent_name_hint:'Daylight'}:{}),...(saved?.id_token?{id_token_hint:saved.id_token}:{})};
   p.url=ISSUER+'/api/accounts/authorize?'+new URLSearchParams(params);
   this.listenerTimer=setTimeout(()=>{if(this.pending===p){p.result={status:'expired'};p.controller.abort();this.stopListener(p);}},300000);this.listenerTimer.unref();
   return this.publicLogin();
  }catch(error){if(p===this.pending)this.cancelPending();throw error;}
 }
 async callback(req,res,p){
  const reply=(status,message)=>{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'",'X-Content-Type-Options':'nosniff'});res.end(message);};
  const url=new URL(req.url,'http://127.0.0.1'),q=url.searchParams;
  if(req.method!=='GET'||url.pathname!=='/auth/callback'||req.headers.host!==new URL(p.redirectUri).host||p!==this.pending||p.result||p.completing||this.now()>=p.expiresAt)return reply(400,'登录链接已失效。');
  if(q.getAll('state').length!==1||q.get('state')!==p.state||['code','client_id','error'].some(k=>q.getAll(k).length>1))return reply(400,'授权校验失败。');
  if(q.has('error')){p.result={status:q.get('error')==='access_denied'?'denied':'failed'};reply(400,'授权未完成，请返回 Daylight。');this.stopListener(p);return;}
  const clientId=q.get('client_id')||p.clientId;
  if(!q.get('code')||clientId==='dynamic_agent_client'||p.clientId!=='dynamic_agent_client'&&clientId!==p.clientId||!(/^[a-zA-Z0-9._-]{1,256}$/).test(clientId))return reply(400,'授权注册信息不完整。');
  p.completing=true;
  try{
   // Persist issued registration before exchanging a one-use code; no token is written here.
   await this.host(async()=>{const host=await readJson(this.hostFile,{});if(p!==this.pending)throw oauthError('登录已取消');await writeJson(this.hostFile,{...host,pendingClientId:clientId});});
   const data=await this.request(TOKEN,{form:{grant_type:'authorization_code',client_id:clientId,code:q.get('code'),code_verifier:p.verifier,redirect_uri:p.redirectUri,resource:RESOURCE},signal:p.controller.signal});
   if(data.error)throw oauthError('ChatGPT 授权码交换失败，请重新网页登录');
   const identity=await verifyIdentity(data.id_token,{issuer:ISSUER,clientId,nonce:p.nonce,subject:p.saved?.account.id,fetchImpl:this.fetchImpl,now:this.now()});
   const session=this.session(data,{clientId,tokenEndpoint:TOKEN,account:{id:identity.sub,login:identity.email||identity.name||identity.sub}});
   await this.validateRefresh(session,session);await this.commit(session,p.epoch);
   if(p!==this.pending)throw oauthError('登录已取消');
   p.result={status:'authenticated',authorized:true};this.onChange?.();reply(200,'登录成功，请返回 Daylight。');
  }catch{if(p===this.pending)p.result={status:'failed',error:'ChatGPT 登录未完成，请检查授权后重试'};reply(400,'登录未完成，请返回 Daylight 重试。');}
  finally{p.completing=false;this.stopListener(p);}
 }
 async poll(){const result=this.publicLogin();if(result?.status==='authenticated'||result?.status==='failed'||result?.status==='denied'||result?.status==='expired')this.pending=null;return result;}
 async read(force=false){const s=await this.getSession(force);if(!s.scope?.split(' ').includes('chatgpt.tokens.use.direct'))throw oauthError('ChatGPT 账号未授权套餐调用，请刷新登录并授权');return{token:s.access_token,account:s.account.id,exp:s.expiresAt,identity:s.identity};}
 async refresh(){const saved=await this.readSession();if(!saved.scope?.split(' ').includes('chatgpt.tokens.use.direct'))return this.login();return super.refresh();}
 async quota(){await this.read();return{buckets:[],checkedAt:new Date().toISOString(),message:'ChatGPT 独立授权接口暂未提供可读取的额度；实际调用以账户套餐及上游返回为准。'};}
 async logout(){const result=await super.logout();await this.host(async()=>{const host=await readJson(this.hostFile,null);if(host){delete host.pendingClientId;await writeJson(this.hostFile,host);}});return result;}
}
