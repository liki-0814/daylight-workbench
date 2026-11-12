import {randomUUID} from 'node:crypto';
import {OAuthAccount,oauthError} from '../shared/oauth-account.js';

const BASE='https://www.workbuddy.cn';
const headers={'X-Product':'SaaS','User-Agent':'CLI/2.63.2 CodeBuddy/2.63.2',Accept:'application/json'};
const fail=()=>oauthError('WorkBuddy 授权无效或已过期，请重新登录');
function identity(token){
 try {const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url'));const id=claims.sub||claims.user_id||claims.uid;if(typeof id==='string'&&id.length>0&&id.length<256)return id;}catch{}
 throw fail();
}
export class WorkBuddyAuth extends OAuthAccount {
 constructor(options={}){super({id:'workbuddy',name:'WorkBuddy',...options});}
 async call(path,{method='GET',body,extra={},signal}={}){
  const response=await this.fetchImpl(BASE+path,{method,redirect:'error',headers:{...headers,...extra,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:this.requestSignal(signal)});
  let data;try{data=await response.json();}catch{throw Error('WorkBuddy 授权响应无效');}
  if(!response.ok)throw Object.assign(new Error(`WorkBuddy 授权请求失败（${response.status}）`),{status:response.status});
  return data;
 }
 publicLogin(p=this.pending){return p?{status:'pending',url:p.url,expiresAt:p.expiresAt,interval:3}:null;}
 async login(){
  const p=this.beginLogin();
  try{
   const nonce=randomUUID(),data=await this.call('/v2/plugin/auth/state?platform=CLI&nonce='+encodeURIComponent(nonce),{method:'POST',body:{nonce},signal:p.controller.signal});
   if(p!==this.pending)return{status:'cancelled'};
   const state=data?.data?.state,url=new URL(data?.data?.authUrl);
   if(data.code!==0||typeof state!=='string'||!state||state.length>1024||url.origin!==BASE||url.pathname!=='/login'||url.username||url.password||url.hash||url.searchParams.get('state')!==state)throw fail();
   Object.assign(p,{state,url:url.href,expiresAt:this.now()+300000,nextPoll:0});return this.publicLogin(p);
  }catch(error){if(p!==this.pending)return{status:'cancelled'};this.cancelPending();throw error;}
 }
 async poll(){
  const p=this.pending;if(!p)return null;if(!p.state)return{status:'pending'};
  if(this.now()>=p.expiresAt){this.cancelPending();return{status:'expired'};}
  if(this.polling)return this.polling;if(this.now()<p.nextPoll)return this.publicLogin(p);
  const task=(async()=>{
   p.nextPoll=this.now()+3000;
   const result=await this.call('/v2/plugin/auth/token?state='+encodeURIComponent(p.state),{signal:p.controller.signal});
   if(p!==this.pending)return{status:'cancelled'};
   if(result.code===11217)return this.publicLogin(p);
   if(result.code!==0)throw fail();
   const d=result.data||{},id=identity(d.accessToken);
   const session=this.session({access_token:d.accessToken,refresh_token:d.refreshToken,expires_in:d.expiresIn});
   session.account={id,login:'WorkBuddy 用户'};session.clientId='workbuddy-cn';session.domain=typeof d.domain==='string'&&/^[a-z0-9.-]{1,253}$/i.test(d.domain)?d.domain:'';
   await this.commit(session,p.epoch);if(p!==this.pending)return{status:'cancelled'};this.pending=null;this.accountChanged();return{status:'authenticated',authorized:true};
  })();this.polling=task;try{return await task;}catch(error){if(p!==this.pending)return{status:'cancelled'};throw error;}finally{if(this.polling===task)this.polling=null;}
 }
 async getSession(force=false){
  const epoch=this.epoch,saved=await this.readSession();if(!force&&saved.expiresAt>this.now()+60000)return saved;
  if(this.refreshing?.epoch===epoch&&this.refreshing.identity===saved.identity)return this.refreshing.task;
  const task=(async()=>{
   if(!saved.refresh_token)throw fail();
   const result=await this.call('/v2/plugin/auth/token/refresh',{method:'POST',extra:{'X-Refresh-Token':saved.refresh_token,'X-Auth-Refresh-Source':'workbuddy'}});
   if(result.code!==0||identity(result.data?.accessToken)!==saved.account.id)throw fail();
   const d=result.data,next=this.session({access_token:d.accessToken,refresh_token:d.refreshToken,expires_in:d.expiresIn},saved);
   await this.commit(next,epoch);return next;
  })();this.refreshing={epoch,identity:saved.identity,task};try{return await task;}finally{if(this.refreshing?.task===task)this.refreshing=null;}
 }
}
