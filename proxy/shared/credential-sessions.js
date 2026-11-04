import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readJson,writeJson} from './store.js';

// Only references live on disk. Tokens remain in the system keychain. A null
// current reference is a durable logout tombstone, never a legacy fallback.
export class CredentialSessions {
 constructor({secrets,key,dataDir}){Object.assign(this,{secrets,key});this.file=dataDir&&path.join(dataDir,'proxy/credentials',key+'.json');}
 async state(){
  const state=this.file?await readJson(this.file,{current:this.key,retired:[]}):this.memory||{current:this.key,retired:[]};
  const owned=id=>typeof id==='string'&&(id===this.key||id.startsWith(this.key+'-')&&/^[a-f0-9-]{36}$/.test(id.slice(this.key.length+1)));
  if(!state||!(state.current===null||owned(state.current))||!Array.isArray(state.retired)||!state.retired.every(owned))throw Error('凭证引用文件无效，原文件已保留');
  return state;
 }
 async publish(state){if(this.file)await writeJson(this.file,state);else this.memory=state;}
 async get(options){const state=await this.state();return state.current?this.secrets.get(state.current,options):undefined;}
 async replace(value,{interactive=false,verifyInteractive=interactive,valid=()=>true,signal,committed=()=>{}}={}){
  const state=await this.state(),next=this.key+'-'+randomUUID();
  // Record pending keys before writing, so a crash never loses cleanup ownership.
  await this.publish({...state,retired:[...new Set([...state.retired,next])]});
  try{
   await this.secrets.set(next,value,{interactive,signal});
   if(await this.secrets.get(next,{interactive:verifyInteractive,signal})!==value)throw Object.assign(new Error('凭证保存校验失败，请重试登录'),{code:'EKEYCHAIN_VERIFY'});
   if(!valid())throw Object.assign(new Error('登录已取消'),{code:'AUTH_CANCELLED'});
   await this.publish({current:next,retired:[...new Set([...state.retired,...(state.current?[state.current]:[])])].filter(id=>id!==next)});
   if(!valid()){await this.publish({...state,retired:[...new Set([...state.retired,next])]});throw Object.assign(new Error('登录已取消'),{code:'AUTH_CANCELLED'});}
   committed();
  }catch(error){await this.cleanup().catch(()=>{});throw error;}
  // Cleanup is separate from login success and must never request system UI.
  await this.cleanup().catch(()=>{});
 }
 async cleanup(){
  const state=await this.state();
  const pending=state.retired.filter(id=>id!==state.current);
  const selected=pending.splice(0,4),retired=[...pending];
  // Rotate refused items behind unattempted ones. Four inaccessible legacy
  // items must not permanently starve cleanup of every later credential.
  for(const id of selected){
   try{await this.secrets.delete(id,{timeoutMs:1000});}
   catch{retired.push(id);}
  }
  if(JSON.stringify(retired)!==JSON.stringify(state.retired))await this.publish({...state,retired});
  return retired.length;
 }
 async logout(){
  const state=await this.state();
  const retired=[...new Set([...state.retired,...(state.current?[state.current]:[])])];
  await this.publish({current:null,retired});
  try{return await this.cleanup();}catch{return retired.length;}
 }
}
