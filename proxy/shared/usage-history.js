import {referenceCostRange,tierRules} from './reference-cost.js';
import {tierEdges,requestShape,addTierBin,validBins} from './usage-tiers.js';
import {parseModelRef} from './llm/models.js';
import {createHash} from 'node:crypto';
import {readJson,writeJson,writeJsonSync,serial} from './store.js';
import {addCivilDays,validateDateRange,isCivilDate} from '../../core/date.js';

const fields=['requests','succeeded','failed','timedOut','cancelled','unknown','tokenRequests','inputTokens','outputTokens','cacheRequests','cacheInputTokens','cacheReadTokens','cacheWriteRequests','cacheWriteTokens','reasoningRequests','reasoningTokens'];
const empty=()=>Object.fromEntries(fields.map(key=>[key,0]));
const valid=value=>Number.isFinite(value)&&value>=0;
const snapshotHash=rows=>createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const identity=row=>row.id?String(row.id):createHash('sha256').update(JSON.stringify(row)).digest('hex');
export function usageDay(time,timeZone){
 const date=new Date(time);if(!Number.isFinite(date.getTime()))return undefined;
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date).map(p=>[p.type,p.value]));
 return `${parts.year}-${parts.month}-${parts.day}`;
}
export const usageModel=row=>String(row.sourceModel||row.upstreamModel||row.model||'unknown');
const add=(target,row)=>{for(const key of fields)target[key]+=row[key];return target;};
// Reference amounts are bounds: equal when every covered request has a known tier, otherwise a range.
// Short fingerprints keep the replay guard small. A collision only leaves one request in the estimated remainder.
const tag=id=>createHash('sha256').update(id).digest('hex').slice(0,12);
const summarize=rows=>rows.reduce((sum,row)=>{add(sum,row);sum.referenceCostMinUsd+=row.referenceCostMinUsd??0;sum.referenceCostMaxUsd+=row.referenceCostMaxUsd??0;sum.pricedRequests+=row.pricedRequests||0;sum.estimatedRequests+=row.estimatedRequests||0;return sum;},{...empty(),referenceCostMinUsd:0,referenceCostMaxUsd:0,pricedRequests:0,estimatedRequests:0});
const decorate=row=>({...row,referenceCostMinUsd:row.pricedRequests?row.referenceCostMinUsd:null,referenceCostMaxUsd:row.pricedRequests?row.referenceCostMaxUsd:null,referenceCostUsd:row.pricedRequests&&!row.estimatedRequests?row.referenceCostMinUsd:null,totalTokens:row.tokenRequests?row.inputTokens+row.outputTokens:null,successRate:row.succeeded+row.failed+row.timedOut?row.succeeded/(row.succeeded+row.failed+row.timedOut):null,cacheHitRate:row.cacheInputTokens>0?row.cacheReadTokens/row.cacheInputTokens:null});

// Daily numeric aggregates have a separate lifetime from the bounded diagnostic log.
// The last 2000 IDs make replay of the latest 1000 records idempotent after a crash.
// State is mutated in place: buckets are indexed by day/source/model so a request touches one bucket and the ID window,
// and disk writes are coalesced (see `flushDelayMs`). Replay of the retained log recovers anything a crash left unwritten.
const idWindow=2000;
const bucketKey=(day,source,model)=>JSON.stringify([day,source,model]);
const live=new Set();let hooked=false;
function hookProcess(){
 if(hooked)return;hooked=true;
 // Fires for process.exit() and for a natural end alike, where only a synchronous atomic write can still finish.
 process.on('exit',()=>{for(const history of live)history.flushSync();});
}
function pushCapped(list,ids,limit,onDrop){
 for(const id of ids)list.push(id);
 if(list.length>limit)for(const dropped of list.splice(0,list.length-limit))onDrop?.(dropped);
}
export class UsageHistory{
 constructor(file,state,{now=()=>new Date(),flushDelayMs=3000}={}){
  this.file=file;this.now=now;this.flushDelayMs=flushDelayMs;this.error='';this.disabled=false;
  this.dirty=false;this.writing=false;this.timer=null;this.writes=serial();this.snapshotRows=null;this.state=state;
 }
 get state(){return this._state;}
 // Assigning a whole state rebuilds the indexes; per-request updates never do.
 set state(state){
  this._state=state;this.edgeCache=null;
  this.buckets=new Map();this.seen=new Set(state?.seenIds||[]);
  for(const bucket of state?.buckets||[]){const key=bucketKey(bucket.day,bucket.source,bucket.model);if(!this.buckets.has(key))this.buckets.set(key,bucket);}
 }
 edges(){return this.edgeCache||=tierEdges(this.state.catalogs);}
 static async load(file,rows,options={}){
  const now=options.now?.()||new Date();let history;
  try{
   const missing=Symbol('missing');let state=await readJson(file,missing);const initial=state===missing;
   if(!initial){
    if(!state||state.schemaVersion!==1||typeof state.timeZone!=='string'||!valid(state.importedRequests)||!Array.isArray(state.buckets)||!Array.isArray(state.seenIds)||!Number.isFinite(Date.parse(state.startedAt)))throw Error('Invalid history');
    if(state.catalogs!==undefined&&(!Array.isArray(state.catalogs)||state.catalogs.some(entry=>!entry||typeof entry.source!=='string'||typeof entry.id!=='string'||!Array.isArray(entry.aliases)||entry.aliases.some(id=>typeof id!=='string'))))throw Error('Invalid model names');
    new Intl.DateTimeFormat('en',{timeZone:state.timeZone}).format(now);
    if(state.tieredIds!==undefined&&(!Array.isArray(state.tieredIds)||state.tieredIds.some(id=>typeof id!=='string')))throw Error('Invalid history');
    if(state.buckets.some(b=>!isCivilDate(b.day)||typeof b.source!=='string'||typeof b.model!=='string'||fields.some(k=>!valid(b[k])))||state.seenIds.some(id=>typeof id!=='string'))throw Error('Invalid history buckets');
    // Optional pricing detail never makes the permanent totals unreadable; unusable detail is dropped and re-estimated.
    state={...state,buckets:state.buckets.map(b=>b.tiers===undefined||validBins(b.tiers)?b:Object.fromEntries(Object.entries(b).filter(([key])=>key!=='tiers')))};
   }else state={schemaVersion:1,timeZone:options.timeZone||Intl.DateTimeFormat().resolvedOptions().timeZone,startedAt:now.toISOString(),importedRequests:0,buckets:[],seenIds:[]};
   history=new UsageHistory(file,state,options);
   if(initial||state.recentSnapshotHash!==snapshotHash(rows))for(const row of rows)if(history.next(row)&&initial)state.importedRequests++;
   history.backfillTiers(rows);
   state.recentSnapshotHash=snapshotHash(rows);
   await writeJson(file,state);
   hookProcess();live.add(history);
  }catch{
   history ||= new UsageHistory(file,null,options);history.disabled=true;history.error='历史统计无法读取或保存，原文件已保留；代理请求记录仍可继续使用。';
  }
  return history;
 }
 // Rows already in the totals but not yet in the pricing histogram get their real input length from the retained log.
 // `tieredIds` records each row once, so repeated startups and replays never add a request twice.
 backfillTiers(rows){
  const state=this.state,done=new Set(state.tieredIds||[]),edges=this.edges(),ids=[];let recovered=0;
  for(const row of rows){
   if(row.origin==='test')continue;
   const id=identity(row),mark=tag(id);if(!this.seen.has(id)||done.has(mark))continue;
   const bucket=this.buckets.get(bucketKey(usageDay(row.time||row.completedAt,state.timeZone),typeof row.provider==='string'&&row.provider?row.provider:'unresolved',usageModel(row)));
   if(!bucket)continue;
   done.add(mark);ids.push(mark);
   const shape=requestShape(row.usage);
   if(shape){bucket.tiers=addTierBin(bucket.tiers,shape,edges);recovered++;}
  }
  if(!ids.length)return false;
  state.tieredIds=[...(state.tieredIds||[])];pushCapped(state.tieredIds,ids,idWindow);
  state.tierBackfilledRequests=(state.tierBackfilledRequests||0)+recovered;
  return true;
 }
 // Counts one request in place; returns whether it was new. Persisting is the caller's decision (see touch).
 next(row){
  const state=this.state;
  if(row.origin==='test')return false;
  const day=usageDay(row.time||row.completedAt,state.timeZone),today=usageDay(this.now(),state.timeZone),id=identity(row);
  if(!day||day>today||this.seen.has(id))return false;
  const source=typeof row.provider==='string'&&row.provider?row.provider:'unresolved',model=usageModel(row),delta=empty();delta.requests=1;
  if(row.outcome==='cancelled')delta.cancelled=1;
  else if(row.outcome==='timeout')delta.timedOut=1;
  else if(['completed','truncated'].includes(row.outcome)&&row.status>=200&&row.status<300&&!row.error)delta.succeeded=1;
  else if(row.outcome==='failed'||row.error||row.status>=400)delta.failed=1;
  else delta.unknown=1;
  const u=row.usage;
  if(u&&!u.estimated&&valid(u.inputTokens)&&valid(u.outputTokens)){
   delta.tokenRequests=1;delta.inputTokens=u.inputTokens;delta.outputTokens=u.outputTokens;
   if(valid(u.cacheReadTokens)&&u.cacheReadTokens<=u.inputTokens){delta.cacheRequests=1;delta.cacheInputTokens=u.inputTokens;delta.cacheReadTokens=u.cacheReadTokens;}
   if(valid(u.cacheWriteTokens)){delta.cacheWriteRequests=1;delta.cacheWriteTokens=u.cacheWriteTokens;}
   if(valid(u.outputDetails?.reasoning_tokens)&&u.outputDetails.reasoning_tokens<=u.outputTokens){delta.reasoningRequests=1;delta.reasoningTokens=u.outputDetails.reasoning_tokens;}
  }
  const key=bucketKey(day,source,model);let bucket=this.buckets.get(key);
  if(bucket)add(bucket,delta);else{bucket={day,source,model,...delta};state.buckets.push(bucket);this.buckets.set(key,bucket);}
  const shape=requestShape(u);
  if(shape)bucket.tiers=addTierBin(bucket.tiers,shape,this.edges());
  state.seenIds.push(id);this.seen.add(id);
  if(state.seenIds.length>idWindow)for(const dropped of state.seenIds.splice(0,state.seenIds.length-idWindow))this.seen.delete(dropped);
  state.tieredIds||=[];pushCapped(state.tieredIds,[tag(id)],idWindow);
  return true;
 }
 setModelCatalog(source,models){
  if(this.disabled)return false;
  const current=this.state.catalogs||[],next=[...current];
  for(const model of models){
   if(typeof model.id!=='string')continue;
   const entry={source,id:model.id,aliases:[...new Set([...(model.aliases||[]),model.upstreamId].filter(id=>typeof id==='string'&&id!==model.id))],...(model.referencePricing?{pricing:model.referencePricing}:{})};
   const index=next.findIndex(row=>row.source===source&&row.id===model.id);
   if(index>=0)next[index]=entry;else next.push(entry);
  }
  if(JSON.stringify(next)===JSON.stringify(current))return false;
  this.state.catalogs=next;this.edgeCache=null;this.touch();return true;
 }
 canonicalModel(source,model){
  const catalog=(this.state.catalogs||[]).filter(row=>row.source===source),id=source==='qoder'?parseModelRef(model).id:model;
  const exact=catalog.find(row=>row.id===id);if(exact)return exact.id;
  const matches=catalog.filter(row=>row.aliases.includes(id));return matches.length===1?matches[0].id:model;
 }
 // Marks unwritten changes and arms one timer; every change inside the window shares a single whole-file write.
 touch(){
  this.dirty=true;
  if(this.disabled||this.timer)return;
  this.timer=setTimeout(()=>{this.timer=null;void this.flush();},this.flushDelayMs);this.timer.unref?.();
  hookProcess();live.add(this);
 }
 // Atomic write of the current state; resolves after every earlier flush. A failed write stays dirty and is retried by the next change.
 flush(){
  if(this.timer){clearTimeout(this.timer);this.timer=null;}
  return this.writes(async()=>{
   if(this.disabled||!this.dirty)return;
   this.dirty=false;this.writing=true;
   try{this.stamp();await writeJson(this.file,this.state);this.error='';}
   catch{this.dirty=true;this.error='历史统计保存失败，当前统计可能尚未更新；保留原有历史文件。';}
   finally{this.writing=false;}
  });
 }
 // Last-chance write when the process ends without an orderly close. Never creates the data directory.
 flushSync(){
  if(this.disabled||!(this.dirty||this.writing))return;
  try{this.stamp();writeJsonSync(this.file,this.state);this.dirty=false;}catch{}
 }
 async close(){
  try{await this.flush();}finally{live.delete(this);}
 }
 stamp(){if(this.snapshotRows)this.state.recentSnapshotHash=snapshotHash(this.snapshotRows);}
 // The hash of the retained log is only needed on disk, so it is computed when writing rather than per request.
 checkpoint(rows){if(!this.disabled)this.snapshotRows=rows;}
 append(row){
  if(this.disabled)return;
  if(!this.next(row)&&!this.error)return;
  this.touch();
 }
 report(query={}){
  if(this.disabled)throw Object.assign(Error(this.error),{status:503});
  const {timeZone,startedAt,importedRequests}=this.state,today=usageDay(this.now(),timeZone);
  const from=query.from||today,to=query.to||today,{days}=validateDateRange({from,to,maxDays:366});
  if(to>today)throw Object.assign(Error('统计结束日期不能晚于今天。'),{status:400});
  const source=query.source||'',model=query.model||'';
  const available=this.state.buckets.filter(b=>b.day>=from&&b.day<=to).map(bucket=>{
   const id=this.canonicalModel(bucket.source,bucket.model),reference=(this.state.catalogs||[]).find(entry=>entry.source===bucket.source&&entry.id===id)?.pricing;
   const range=referenceCostRange(bucket,reference);
   return {...bucket,model:id,referenceCostMinUsd:range?.minUsd??0,referenceCostMaxUsd:range?.maxUsd??0,pricedRequests:range?.coveredRequests??0,estimatedRequests:range?.estimatedRequests??0};
  });
  const selected=available.filter(b=>(!source||b.source===source)&&(!model||b.model===model));
  const groups=key=>[...Map.groupBy(selected,b=>b[key])].map(([id,rows])=>({id,...decorate(summarize(rows))})).sort((a,b)=>b.requests-a.requests||a.id.localeCompare(b.id));
  const daily=Array.from({length:days},(_,i)=>{const day=addCivilDays(from,i);return{day,...decorate(summarize(selected.filter(b=>b.day===day)))};});
  return{from,to,today,timeZone,startedAt,importedRequests,retention:'permanent',partial:from<=usageDay(startedAt,timeZone),error:this.error,
   summary:decorate(summarize(selected)),daily,models:groups('model'),sources:groups('source'),references:(this.state.catalogs||[]).filter(entry=>selected.some(b=>b.source===entry.source&&b.model===entry.id)&&entry.pricing).map(entry=>({source:entry.source,model:entry.id,...entry.pricing.info,tiers:tierRules(entry.pricing)})),
   options:{sources:[...new Set(available.map(b=>b.source))].sort(),models:[...new Set(available.filter(b=>!source||b.source===source).map(b=>b.model))].sort()}};
 }
}
