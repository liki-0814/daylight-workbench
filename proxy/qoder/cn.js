import path from 'node:path';
import {serial} from '../shared/store.js';
import {CredentialSessions} from '../shared/credential-sessions.js';
import {Secrets} from '../shared/secrets.js';
import {sourceSnapshot} from '../shared/contracts.js';
import {checkAccountCatalog} from '../shared/account-catalog.js';
import {operationError} from '../shared/operation-error.js';
import {QoderProvider, loadConfig} from './provider.js';
import {QoderAuth, pollLogin, refreshCredential} from './auth.js';

export const sourceDescription = {id:'qoder-cn',name:'Qoder CN',authentication:{mode:'browser',operations:['login','poll','cancel','logout','refresh'],requiresStoppedService:true,instruction:'Qoder CN 网页登录'},capabilities:{quota:false,editableSource:false},nativeProtocols:['chat']};
export function loadCNConfig(dataDir) {
 const base=loadConfig(dataDir, {});
 return {...base,compatUrl:'https://gateway.qoder.com.cn',openapiUrl:'https://openapi.qoder.com.cn',loginUrl:'https://qoder.cn/device/selectAccounts',challengeMethodInPoll:true,accountFile:path.join(dataDir,'qoder-cn','account.json')};
}

// The account JSON exists only in Keychain; the data directory holds references.
export class CNAccountStore {
 constructor({dataDir,secrets=new Secrets()}={}) {this.sessions=new CredentialSessions({secrets,key:'qoder-cn-oauth',dataDir});this.run=serial();this.loaded=false;this.current=null;}
 async load() {
  if(this.loaded)return this.current;
  let raw;try{raw=await this.sessions.get();}catch(error){if(error.code?.startsWith('EKEYCHAIN'))this.recovery={code:error.code,message:operationError(error),stage:'storage'};throw error;}let value=null;
  if(raw){try{value=JSON.parse(raw);}catch{throw new Error('Qoder CN 凭证无效，请重新登录');}if(!value?.credential?.access||!value.credential.uid)throw new Error('Qoder CN 凭证无效，请重新登录');}
  this.current=value;this.loaded=true;this.recovery=null;return value;
 }
 async require(){const value=await this.load();if(!value)throw Object.assign(new Error('请先登录 Qoder CN'),{status:401});return value;}
 async save(account,options={}) {await this.sessions.replace(JSON.stringify(account),{...options,committed:()=>{this.current=account;this.loaded=true;this.recovery=null;}});}
 async logout(){return this.run(async()=>{const remaining=await this.sessions.logout();this.current=null;this.loaded=true;this.recovery=null;return remaining;});}
}

class CNAuth extends QoderAuth {
 constructor(options){super(options);this.epoch=0;this.lifetime=new AbortController();}
 get recovery(){return this.accounts.recovery;}
 async login(){await this.cancel();const result=await super.login();this.pending.controller=new AbortController();this.pending.epoch=this.epoch;return result;}
 async poll(){
  const pending=this.pending;if(!pending||Date.now()>pending.expiresAt){await this.cancel();throw Object.assign(new Error('登录链接已过期，请重新登录'),{status:400});}
  if(this.polling)return this.polling;
  const task=(async()=>{
   const fetchImpl=(url,options)=>this.fetchImpl(url,{...options,signal:AbortSignal.any([pending.controller.signal,this.lifetime.signal,AbortSignal.timeout(30000)])});
   const account=await pollLogin(this.http,this.config,pending,fetchImpl);
   if(!account)return {authorized:false};
   return this.accounts.run(async()=>{
    if(this.pending!==pending||pending.epoch!==this.epoch)return {authorized:false,status:'cancelled'};
    await this.accounts.save(account,{interactive:true,verifyInteractive:false,signal:AbortSignal.any([pending.controller.signal,this.lifetime.signal,AbortSignal.timeout(180000)]),valid:()=>this.pending===pending&&pending.epoch===this.epoch});
    this.pending=null;this.epoch++;this.onChange();return {authorized:true};
   });
  })();this.polling=task;try{return await task;}finally{if(this.polling===task)this.polling=null;}
 }
 async cancel(){this.epoch++;this.pending?.controller?.abort();this.repairController?.abort();this.pending=null;return {ok:true,status:'cancelled'};}
 async refresh(){await this.accounts.run(async()=>{
  const epoch=this.epoch,account=await this.accounts.require();
  const credential=await refreshCredential(this.http,account.credential);
  await this.accounts.save({...account,credential},{signal:AbortSignal.any([this.lifetime.signal,AbortSignal.timeout(30000)]),valid:()=>epoch===this.epoch});
 });return {ok:true};}
 async repair(){
  if(this.repairing)return this.repairing;
  const epoch=this.epoch,controller=new AbortController();this.repairController=controller;
  const signal=AbortSignal.any([controller.signal,this.lifetime.signal,AbortSignal.timeout(180000)]),valid=()=>epoch===this.epoch&&!signal.aborted;
  const task=this.accounts.run(async()=>{
   const raw=await this.accounts.sessions.get({interactive:true,signal});let account;
   try{account=JSON.parse(raw);}catch{}
   if(!account?.credential?.access||!account.credential.uid)throw new Error('没有可恢复的有效凭证，请重新登录');
   if(!valid())throw Object.assign(new Error('凭证修复已取消'),{code:'AUTH_CANCELLED'});
   await this.accounts.save(account,{interactive:true,verifyInteractive:false,signal,valid});this.onChange();return {ok:true,credentialRepaired:true};
  });this.repairing=task;
  try{return await task;}catch(error){if(valid()&&error.code?.startsWith('EKEYCHAIN'))this.accounts.recovery={code:error.code,message:operationError(error),stage:'storage'};throw error;}
  finally{if(this.repairing===task)this.repairing=null;if(this.repairController===controller)this.repairController=null;}
 }
 async logout(){await this.cancel();const remaining=await this.accounts.logout();this.onChange();return {ok:true,...(remaining?{warning:'已退出账号，部分旧凭证暂无法删除。'}:{})};}
 close(){this.lifetime.abort();void this.cancel();}
}

export class QoderCNProvider extends QoderProvider {
 constructor(config,http,accounts){
  super(config,http,accounts);this.auth=new CNAuth({accounts,http,config,fetchImpl:http.fetchImpl,onChange:()=>this.clear()});
  for(const key of ['mediaOwns','mediaLoginError','mediaModels','setMediaModel','executeMedia'])delete this[key];
 }
 snapshot(){const c=this.accounts.current?.credential;const requiresStoppedService=!!c||!this.accounts.loaded||!!this.accounts.recovery;return {...sourceSnapshot({...sourceDescription,authentication:{...sourceDescription.authentication,requiresStoppedService},identityKey:this.accounts.current?.id,configured:!!c,connected:!!this.cache&&!this.lastError,error:this.lastError,checkedAt:this.cache?.at,catalogIdentityKey:this.cache?.identity}),account:c?{login:[c.organizationName,c.uid].filter(Boolean).join(' · ')}:undefined};}
 async status(force=false){return checkAccountCatalog(this,force);}
 async catalog(account,force=false){const epoch=this.auth.epoch;const result=await super.catalog(account,force);if(epoch!==this.auth.epoch)throw Object.assign(new Error('Qoder CN 账号已切换，请重新请求'),{status:401});return result;}
 async ready(){
  let account=await this.accounts.require();
  if(account.credential.expires<Date.now()+60000){await this.auth.refresh();account=await this.accounts.require();}
  return account;
 }
 close(){this.auth.close();super.close();}
}
