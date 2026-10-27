import {referenceCost} from './reference-cost.js';
import {parseModelRef} from './llm/models.js';
import {createHash} from 'node:crypto';
import {readJson,writeJson} from './store.js';
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
const summarize=rows=>rows.reduce((sum,row)=>{add(sum,row);sum.referenceCostUsd+=row.referenceCostUsd??0;sum.pricedRequests+=row.pricedRequests||0;return sum;},{...empty(),referenceCostUsd:0,pricedRequests:0});
const decorate=row=>({...row,referenceCostUsd:row.pricedRequests?row.referenceCostUsd:null,totalTokens:row.tokenRequests?row.inputTokens+row.outputTokens:null,successRate:row.succeeded+row.failed+row.timedOut?row.succeeded/(row.succeeded+row.failed+row.timedOut):null,cacheHitRate:row.cacheInputTokens>0?row.cacheReadTokens/row.cacheInputTokens:null});

// Daily numeric aggregates have a separate lifetime from the bounded diagnostic log.
// The last 2000 IDs make replay of the latest 1000 records idempotent after a crash.
export class UsageHistory{
 constructor(file,state,{now=()=>new Date()}={}){this.file=file;this.state=state;this.now=now;this.error='';this.disabled=false;}
 static async load(file,rows,options={}){
  const now=options.now?.()||new Date();let history;
  try{
   const missing=Symbol('missing');let state=await readJson(file,missing);const initial=state===missing;
   if(!initial){
    if(!state||state.schemaVersion!==1||typeof state.timeZone!=='string'||!valid(state.importedRequests)||!Array.isArray(state.buckets)||!Array.isArray(state.seenIds)||!Number.isFinite(Date.parse(state.startedAt)))throw Error('Invalid history');
    if(state.catalogs!==undefined&&(!Array.isArray(state.catalogs)||state.catalogs.some(entry=>!entry||typeof entry.source!=='string'||typeof entry.id!=='string'||!Array.isArray(entry.aliases)||entry.aliases.some(id=>typeof id!=='string'))))throw Error('Invalid model names');
    new Intl.DateTimeFormat('en',{timeZone:state.timeZone}).format(now);
    if(state.buckets.some(b=>!isCivilDate(b.day)||typeof b.source!=='string'||typeof b.model!=='string'||fields.some(k=>!valid(b[k])))||state.seenIds.some(id=>typeof id!=='string'))throw Error('Invalid history buckets');
   }else state={schemaVersion:1,timeZone:options.timeZone||Intl.DateTimeFormat().resolvedOptions().timeZone,startedAt:now.toISOString(),importedRequests:0,buckets:[],seenIds:[]};
   history=new UsageHistory(file,state,options);
   let next=state;
   if(initial||state.recentSnapshotHash!==snapshotHash(rows))for(const row of rows){const updated=history.next(row,next);if(updated!==next&&initial)updated.importedRequests++;next=updated;}
   next={...next,recentSnapshotHash:snapshotHash(rows)};
   await writeJson(file,next);history.state=next;
  }catch{
   history ||= new UsageHistory(file,null,options);history.disabled=true;history.error='历史统计无法读取或保存，原文件已保留；代理请求记录仍可继续使用。';
  }
  return history;
 }
 next(row,state=this.state){
  if(row.origin==='test')return state;
  const day=usageDay(row.time||row.completedAt,state.timeZone),today=usageDay(this.now(),state.timeZone),id=identity(row);
  if(!day||day>today||state.seenIds.includes(id))return state;
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
  const buckets=state.buckets.map(b=>({...b}));
  const bucket=buckets.find(b=>b.day===day&&b.source===source&&b.model===model);
  if(bucket)add(bucket,delta);else buckets.push({day,source,model,...delta});
  return {...state,buckets,seenIds:[...state.seenIds,id].slice(-2000)};
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
  this.state={...this.state,catalogs:next};return true;
 }
 canonicalModel(source,model){
  const catalog=(this.state.catalogs||[]).filter(row=>row.source===source),id=source==='qoder'?parseModelRef(model).id:model;
  const exact=catalog.find(row=>row.id===id);if(exact)return exact.id;
  const matches=catalog.filter(row=>row.aliases.includes(id));return matches.length===1?matches[0].id:model;
 }
 async flush(){
  if(this.disabled)return;
  try{await writeJson(this.file,this.state);this.error='';}catch{this.error='历史统计保存失败，当前统计可能尚未更新；保留原有历史文件。';}
 }
 checkpoint(rows){if(!this.disabled)this.state={...this.state,recentSnapshotHash:snapshotHash(rows)};}
 async append(row){
  if(this.disabled)return;
  const next=this.next(row);if(next===this.state&&!this.error)return;
  this.state=next;
  await this.flush();
 }
 report(query={}){
  if(this.disabled)throw Object.assign(Error(this.error),{status:503});
  const {timeZone,startedAt,importedRequests}=this.state,today=usageDay(this.now(),timeZone);
  const from=query.from||today,to=query.to||today,{days}=validateDateRange({from,to,maxDays:366});
  if(to>today)throw Object.assign(Error('统计结束日期不能晚于今天。'),{status:400});
  const source=query.source||'',model=query.model||'';
  const available=this.state.buckets.filter(b=>b.day>=from&&b.day<=to).map(bucket=>{
   const id=this.canonicalModel(bucket.source,bucket.model),reference=(this.state.catalogs||[]).find(entry=>entry.source===bucket.source&&entry.id===id)?.pricing;
   const amount=referenceCost(bucket,reference);
   return {...bucket,model:id,referenceCostUsd:amount,pricedRequests:amount===null?0:bucket.tokenRequests};
  });
  const selected=available.filter(b=>(!source||b.source===source)&&(!model||b.model===model));
  const groups=key=>[...Map.groupBy(selected,b=>b[key])].map(([id,rows])=>({id,...decorate(summarize(rows))})).sort((a,b)=>b.requests-a.requests||a.id.localeCompare(b.id));
  const daily=Array.from({length:days},(_,i)=>{const day=addCivilDays(from,i);return{day,...decorate(summarize(selected.filter(b=>b.day===day)))};});
  return{from,to,today,timeZone,startedAt,importedRequests,retention:'permanent',partial:from<=usageDay(startedAt,timeZone),error:this.error,
   summary:decorate(summarize(selected)),daily,models:groups('model'),sources:groups('source'),references:(this.state.catalogs||[]).filter(entry=>selected.some(b=>b.source===entry.source&&b.model===entry.id)&&entry.pricing).map(entry=>({source:entry.source,model:entry.id,...entry.pricing.info})),
   options:{sources:[...new Set(available.map(b=>b.source))].sort(),models:[...new Set(available.filter(b=>!source||b.source===source).map(b=>b.model))].sort()}};
 }
}
