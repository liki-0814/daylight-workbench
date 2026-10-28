import {createHash} from 'node:crypto';
import {readJson,writeJson,serial} from './store.js';
import {applyMessageCachePolicy} from './prompt-cache.js';

const minute=60000, cooldown=24*60*minute, limit=1000;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unmarked=block=>{const {cache_control,...rest}=block;return rest;};
const parts=value=>typeof value==='string'?[{type:'text',text:value}]:value?.map(unmarked);
const userTurns=body=>(body.messages||[]).filter(m=>m.role==='user'&&
  (typeof m.content==='string'||m.content?.some(b=>['text','image','document'].includes(b.type))));

// Only hashed identities, timestamps and cadence are retained. No prompts or IDs.
// One long reuse gap promotes; three short NEW user turns demote. Tool loops keep
// the learned TTL. We cannot recover an entry that expired before the first gap.
export class AdaptivePromptCache {
  constructor({file,now=Date.now}={}){Object.assign(this,{file,now});this.write=serial();this.rows=new Map();}
  async load(){
    if(!this.loading)this.loading=(async()=>{
      if(!this.file)return;
      try{
        const saved=await readJson(this.file,{schema:2,rows:[]});
        if(saved.schema===1)return; // Reset the superseded content-inferred learning format.
        if(saved.schema!==2||!Array.isArray(saved.rows))throw Error('Invalid cadence history');
        for(const row of saved.rows.slice(-limit))if(/^[a-f0-9]{64}$/.test(row.key)&&
          Number.isFinite(row.at)&&row.at>=0&&row.at<=this.now()&&['5m','1h'].includes(row.ttl)&&
          /^[a-f0-9]{64}$/.test(row.turn)&&Number.isInteger(row.shortTurns)&&row.shortTurns>=0&&row.shortTurns<=3&&
          (row.disabledUntil===undefined||Number.isFinite(row.disabledUntil))){
          const {key,at,turn,ttl,shortTurns,disabledUntil}=row;
          this.rows.set(key,{key,at,turn,ttl,shortTurns,...(disabledUntil?{disabledUntil}:{})});
        }
      }catch{this.persistenceFailed=true;} // Preserve damaged files; inference stays available.
    })();
    await this.loading;
  }
  async prepare(body,{scope,conversationId,promptCacheKey,explicit=false}={}){
    if(explicit)return {ttl:'caller',reason:'caller',commit:async()=>{}};
    const sessionId=conversationId||promptCacheKey;
    if(!sessionId){
      applyMessageCachePolicy(body);
      return {ttl:'5m',reason:'no-session-id',commit:async()=>{}};
    }
    await this.load();
    const at=this.now(),turns=userTurns(body),key=hash([scope,sessionId]);
    const previous=this.rows.get(key),turn=hash([turns.length,parts(turns.at(-1)?.content)]);
    const gap=previous?at-previous.at:Infinity;
    let ttl=previous?.ttl||'5m',shortTurns=previous?.shortTurns||0,disabledUntil=previous?.disabledUntil,reason='learned-long';
    if(!previous||gap<0){ttl='5m';shortTurns=0;reason='cold';}
    else if(previous.disabledUntil>at){ttl='5m';shortTurns=0;reason='upstream-unsupported';}
    else if(gap>5*minute){ttl='1h';shortTurns=0;reason='long-gap';}
    else if(ttl==='1h'){
      if(turn!==previous.turn&&++shortTurns>=3){ttl='5m';shortTurns=0;reason='frequent-user-turns';}
    }else reason='frequent';
    applyMessageCachePolicy(body,ttl);
    const decision={ttl,reason,commit:()=>this.write(async()=>{
      // An earlier slow/concurrent request must not overwrite a newer sample.
      if((this.rows.get(key)?.at??-Infinity)>at)return;
      this.rows.delete(key);this.rows.set(key,{key,at,turn,ttl:decision.ttl,shortTurns,
        ...(disabledUntil>at?{disabledUntil}:{})});
      while(this.rows.size>limit)this.rows.delete(this.rows.keys().next().value);
      if(this.file&&!this.persistenceFailed)try{await writeJson(this.file,{schema:2,rows:[...this.rows.values()]});}catch{this.persistenceFailed=true;}
    }),fallback:()=>{decision.ttl='5m';decision.reason='upstream-unsupported';shortTurns=0;disabledUntil=at+cooldown;applyMessageCachePolicy(body,'5m');}};
    return decision;
  }
  async request(body,options,send,observe=()=>{}){
    const decision=await this.prepare(body,options);
    const report=()=>observe({promptCacheTtl:decision.ttl,promptCacheReason:decision.reason});
    report();let response=await send();
    if(decision.ttl==='1h'&&await isCacheTtlRejection(response)){
      await response.body?.cancel();decision.fallback();report();response=await send();
    }
    if(response.ok)await decision.commit();
    return response;
  }
}

async function isCacheTtlRejection(response){
  if(response.status!==400)return false;
  const error=await response.clone().json().catch(()=>null),message=error?.error?.message||'';
  return /(?:ttl|cache)/i.test(message)&&/(?:1h|1.hour|unsupported|not supported|not allowed)/i.test(message);
}
