import http from 'node:http';
import {operationError} from './operation-error.js';
import {randomBytes} from 'node:crypto';
import {OAuthAccount,oauthError} from './oauth-account.js';

// Browser OAuth providers share callback validation, expiry and cancellation ownership.
export class LoopbackOAuthAccount extends OAuthAccount {
 beginBrowserLogin(){return Object.assign(this.beginLogin(),{state:randomBytes(32).toString('base64url'),nonce:randomBytes(32).toString('base64url'),verifier:randomBytes(32).toString('base64url'),expiresAt:this.now()+300000});}
 publicLogin(){const p=this.pending;return p?{status:p.result?.status||'pending',url:p.url,expiresAt:p.expiresAt,interval:3,...(p.result||{})}:null;}
 stopListener(owner){if(owner&&owner!==this.listenerOwner)return;clearTimeout(this.listenerTimer);this.listener?.close();this.listener?.closeAllConnections();this.listener=null;}
 async openCallback(p,{port=0,pathname='/auth/callback',hostname='127.0.0.1'}={}){
  const server=http.createServer((req,res)=>{void this.callback(req,res,p).catch(()=>{if(!res.headersSent){res.writeHead(400,{'Content-Type':'text/plain; charset=utf-8'});res.end('登录未完成，请返回 Daylight 重试。');}});});this.listener=server;this.listenerOwner=p;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});server.unref();
  if(p!==this.pending){server.close();throw oauthError('登录已取消');}
  p.redirectUri=`http://${hostname}:${server.address().port}${pathname}`;
  this.listenerTimer=setTimeout(()=>{if(this.pending===p){p.result={status:'expired'};p.controller.abort();this.stopListener(p);}},Math.max(1,p.expiresAt-this.now()));this.listenerTimer.unref();
 }
 async callback(req,res,p){
  const reply=(status,message)=>{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'",'X-Content-Type-Options':'nosniff'});res.end(message);};
  const redirect=new URL(p.redirectUri),url=new URL(req.url,redirect),q=url.searchParams;
  if(req.method!=='GET'||url.pathname!==redirect.pathname||req.headers.host!==redirect.host||p!==this.pending||p.result||p.completing||this.now()>=p.expiresAt)return reply(400,'登录链接已失效。');
  if(q.getAll('state').length!==1||q.get('state')!==p.state||['code','client_id','error'].some(k=>q.getAll(k).length>1))return reply(400,'授权校验失败。');
  if(q.has('error')){p.result={status:q.get('error')==='access_denied'?'denied':'failed'};reply(400,'授权未完成，请返回 Daylight。');this.stopListener(p);return;}
  if(!q.get('code')||this.validCallback&&!this.validCallback(q,p))return reply(400,'授权注册信息不完整。');
  p.completing=true;
  try{
   const session=await this.exchange(q,p);await this.commit(session,p.epoch);
   if(p!==this.pending)throw oauthError('登录已取消');
   p.result={status:'authenticated',authorized:true};this.accountChanged();reply(200,'登录成功，请返回 Daylight。');
  }catch(error){const message=operationError(error,`${this.name} 登录未完成，请检查授权后重试`);if(p===this.pending)p.result={status:'failed',error:message};reply(400,message+'。请返回 Daylight 重试。');}
  finally{p.completing=false;this.stopListener(p);}
 }
 async poll(){const result=this.publicLogin();if(['authenticated','failed','denied','expired'].includes(result?.status))this.pending=null;return result;}
}
