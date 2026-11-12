import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readJson,writeJson,serial} from './store.js';

const cancelled=()=>Object.assign(new Error('凭证操作已取消'),{code:'EKEYCHAIN_CANCELLED'});
const migrationRead={interactive:false,timeoutMs:4000};

// Only references live on disk. Tokens remain in the system keychain. A null
// current reference is a durable logout tombstone, never a legacy fallback.
// serial() is not reentrant: a queued transition must call *Body methods, never replace/logout/cleanup.
export class CredentialSessions {
 constructor({secrets,key,dataDir,legacySecrets}){Object.assign(this,{secrets,key,legacySecrets:legacySecrets??secrets.previous?.(dataDir)});this.file=dataDir&&path.join(dataDir,'proxy/credentials',key+'.json');this.mutate=serial();}
 async state(){
  const state=this.file?await readJson(this.file,{current:this.key,retired:[]}):this.memory||{current:this.key,retired:[]};
  const owned=id=>typeof id==='string'&&(id===this.key||id.startsWith(this.key+'-')&&/^[a-f0-9-]{36}$/.test(id.slice(this.key.length+1)));
  if(!state||!(state.current===null||owned(state.current))||!Array.isArray(state.retired)||!state.retired.every(owned))throw Error('凭证引用文件无效，原文件已保留');
  return state;
 }
 async publish(state){if(this.file)await writeJson(this.file,state);else this.memory=state;}
 async get(options){
  if(options?.signal?.aborted)throw cancelled();
  const state=await this.state();if(!state.current)return undefined;
  // A readable previous helper must run before any interactive prompt. Without one, preserve the caller's interactive flag exactly.
  try{return await this.secrets.get(state.current,this.legacySecrets?{...options,interactive:false}:options);}
  catch(error){
   if(!this.legacySecrets||!['EKEYCHAIN_AUTH_FAILED','EKEYCHAIN_INTERACTION_REQUIRED'].includes(error.code))throw error;
   const result=await this.migrateLegacy(state.current,options);
   if(result.ok)return result.value;
   if(result.cancelled)throw result.error||cancelled();
   if(result.superseded){if(!(await this.state()).current)return undefined;if(result.error)throw result.error;return undefined;}
   if(result.attempted||!options?.interactive)throw result.error||error;
   return this.secrets.get(state.current,options);
  }
 }
 flightActive(flight){return [...flight.waiters].some(waiter=>!waiter.signal?.aborted);}
 migrateLegacy(currentId,options){
  let flight=this.migrations?.get(currentId);const created=!flight;
  if(!flight){flight={waiters:new Set(),onChange(){}};(this.migrations??=new Map()).set(currentId,flight);}
  const waiter={signal:options?.signal};flight.waiters.add(waiter);
  // One waiter aborting must not abort siblings. The shared signal flips only when nobody remains.
  if(waiter.signal?.aborted)flight.onChange();else waiter.signal?.addEventListener('abort',()=>flight.onChange(),{once:true});
  if(created){flight.promise=this.finishLegacyMigration(currentId,flight);flight.promise.finally(()=>{if(this.migrations?.get(currentId)===flight)this.migrations.delete(currentId);});}
  return flight.promise.then(result=>{
   if(waiter.signal?.aborted)throw cancelled();
   if(result?.cancelled)return this.migrateLegacy(currentId,options);
   return result;
  });
 }
 async finishLegacyMigration(currentId,flight){
  const controller=new AbortController(),signal=controller.signal;
  flight.onChange=()=>{if(!this.flightActive(flight))controller.abort();};flight.onChange();
  if(signal.aborted)return{ok:false,cancelled:true,error:cancelled()};
  const state=await this.state();
  if(state.current!==currentId)return this.readReplacement(state,signal);
  let value;try{value=await this.legacySecrets.get(currentId,{...migrationRead,signal});}
  catch(error){if(signal.aborted||error.code==='EKEYCHAIN_CANCELLED')return{ok:false,cancelled:true,error};return{ok:false};}
  if(value===undefined||!this.flightActive(flight)||signal.aborted)return value===undefined?{ok:false}:{ok:false,cancelled:true,error:cancelled()};
  try{
   // Legacy read stays outside the queue so logout or a newer login can commit first.
   await this.mutate(()=>this.replaceBody(value,{interactive:false,verifyInteractive:false,signal,timeoutMs:migrationRead.timeoutMs,expectedCurrent:currentId,valid:()=>this.flightActive(flight)&&!signal.aborted}));
   return{ok:true,value};
  }catch(error){
   if(error.code==='AUTH_SUPERSEDED')return this.readReplacement(await this.state(),signal);
   if(error.code==='AUTH_CANCELLED'||error.code==='EKEYCHAIN_CANCELLED')return{ok:false,cancelled:true,error};
   return{ok:false,attempted:true,error};
  }
 }
 async readReplacement(state,signal){
  if(!state?.current)return{ok:false,superseded:true};
  try{return{ok:true,value:await this.secrets.get(state.current,{...migrationRead,signal})};}
  catch(error){return{ok:false,superseded:true,error};}
 }
 replace(value,options){return this.mutate(()=>this.replaceBody(value,options));}
 async replaceBody(value,{interactive=false,verifyInteractive=interactive,valid=()=>true,signal,committed=()=>{},timeoutMs,expectedCurrent}={}){
  const state=await this.state(),next=this.key+'-'+randomUUID();
  if(expectedCurrent!==undefined&&state.current!==expectedCurrent)throw Object.assign(new Error('凭证状态已变化'),{code:'AUTH_SUPERSEDED'});
  const io=timeoutMs===undefined?{interactive,signal}:{interactive,signal,timeoutMs},read=timeoutMs===undefined?{interactive:verifyInteractive,signal}:{interactive:verifyInteractive,signal,timeoutMs};
  // Record pending keys before writing, so a crash never loses cleanup ownership.
  await this.publish({...state,retired:[...new Set([...state.retired,next])]});
  try{
   await this.secrets.set(next,value,io);
   if(await this.secrets.get(next,read)!==value)throw Object.assign(new Error('凭证保存校验失败，请重试登录'),{code:'EKEYCHAIN_VERIFY'});
   if(!valid())throw Object.assign(new Error('登录已取消'),{code:'AUTH_CANCELLED'});
   const latest=await this.state();
   // Do not publish over a logout or newer login that won before this item was released.
   if(expectedCurrent!==undefined&&latest.current!==expectedCurrent)throw Object.assign(new Error('凭证状态已变化'),{code:'AUTH_SUPERSEDED'});
   await this.publish({current:next,retired:[...new Set([...latest.retired,...(latest.current?[latest.current]:[])])].filter(id=>id!==next)});
   if(!valid()){await this.publish({...latest,retired:[...new Set([...latest.retired,next])]});throw Object.assign(new Error('登录已取消'),{code:'AUTH_CANCELLED'});}
   committed();
  }catch(error){await this.cleanupBody().catch(()=>{});throw error;}
  // Cleanup is separate from login success and must never request system UI.
  await this.cleanupBody().catch(()=>{});
 }
 cleanup(){return this.mutate(()=>this.cleanupBody());}
 async cleanupBody(){
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
 logout(){return this.mutate(()=>this.logoutBody());}
 async logoutBody(){
  const state=await this.state();
  const retired=[...new Set([...state.retired,...(state.current?[state.current]:[])])];
  await this.publish({current:null,retired});
  try{return await this.cleanupBody();}catch{return retired.length;}
 }
}
