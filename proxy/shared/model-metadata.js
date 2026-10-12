import path from 'node:path';
import {createHash} from 'node:crypto';
import {readJson,writeJson,serial} from './store.js';
import {fillModelMetadata} from '../../core/model-metadata.js';
export const pricingURL='https://liki-0814.github.io/llm-pricing/api/v1/models.json';
const bad=message=>Object.assign(new Error(message),{status:400});
export function createModelMetadata({dataDir,fetchImpl=fetch,enabled=true,ttlMs=86400000,timeoutMs=5000,url=pricingURL,now=Date.now}={}){
 const cacheFile=path.join(dataDir,'proxy/llm-pricing-cache.json'),bindingsFile=path.join(dataDir,'proxy/model-references.json'),supplementFile=path.join(dataDir,'proxy/model-reference-supplement.json'),run=serial();
 let cache,bindings,pending,lastAttempt=0,error='',supplement,supplementError='';
 const key=(source,id)=>JSON.stringify([source,id]);
 const valid=s=>s?.api_version==='v1'&&s.meta?.currency==='USD'&&s.meta?.unit==='per_1M_tokens'&&typeof s.meta.data_version==='string'&&Array.isArray(s.data)&&s.data.length>0&&s.data.every(m=>m&&typeof m.id==='string'&&(m.pricing_tiers===undefined||Array.isArray(m.pricing_tiers)&&m.pricing_tiers.every(t=>t&&typeof t==='object')))&&new Set(s.data.map(m=>m.id)).size===s.data.length;
 const publicEntries=()=>valid(cache?.snapshot)?cache.snapshot.data:[];
 const localEntries=()=>valid(supplement)?supplement.data.filter(m=>!publicEntries().some(p=>p.id===m.id)):[];
 const entries=()=>[...publicEntries(),...localEntries()];
 const meta=()=>{const local=localEntries(),base=cache?.snapshot?.meta||supplement?.meta;if(!base)return null;return {...base,count:entries().length,...(local.length?{data_version:(base.data_version||'')+'-local-'+createHash('sha256').update(JSON.stringify(local)).digest('hex'),updated_at:[base.updated_at,supplement.meta.updated_at].filter(Boolean).sort().at(-1),local_reference_count:local.length}:{})};};
 async function load(){if(!cache){try{cache=await readJson(cacheFile,{});}catch{cache={};error='参考缓存无法读取，将尝试重新获取';}}bindings??=await readJson(bindingsFile,{});try{const next=await readJson(supplementFile,null);if(next&&!valid(next))throw Error();supplement=next;supplementError='';}catch{supplementError='本地参考补充无法读取，保留原文件与最近有效数据';}}
 async function refresh(force=false){
  await load();if(!enabled)return;
  if(pending)return pending;
  if(!force&&(valid(cache.snapshot)||lastAttempt)&&now()-Math.max(cache.fetchedAt||0,lastAttempt)<(error?60000:ttlMs))return;
  lastAttempt=now();pending=(async()=>{try{
   const response=await fetchImpl(url,{signal:AbortSignal.timeout(timeoutMs),redirect:'error',headers:{Accept:'application/json'}});
   if(!response.ok)throw Error('参考目录请求失败');const snapshot=await response.json();if(!valid(snapshot))throw Error('参考目录格式无效');
   const next={snapshot,fetchedAt:now()};await writeJson(cacheFile,next);cache=next;error='';
  }catch{error='参考目录暂不可用，保留缓存、上游和手动设置';}finally{pending=null;}})();return pending;
 }
 function enrich(source,models){
  if(!enabled)return models;
  const catalog=entries(),info=meta();
  return models.map(model=>{
   const referenceId=model.referenceId??bindings?.[key(source,model.upstreamId||model.id)]??'';
   const reference=catalog.find(m=>m.id===(referenceId||model.upstreamId||model.id));
   return fillModelMetadata(model,reference,{referenceId,version:info?.data_version||'',updatedAt:reference?.checked_at||info?.updated_at||'',subscription:!source.startsWith('custom:'),manualFallback:source.startsWith('custom:'),cacheWriteIncluded:source==='grok'&&reference?.billing?.cached_input_type==='implicit'});
  });
 }
 return{refresh,enrich,async read(force=false){await refresh(force);return{models:entries(),meta:meta(),fetchedAt:cache?.fetchedAt||null,error:[error,supplementError].filter(Boolean).join('；')};},bind:input=>run(async()=>{
  await load();if(!input||typeof input.source!=='string'||typeof input.id!=='string'||typeof input.referenceId!=='string')throw bad('模型关联无效');
  if(input.referenceId&&!entries().some(m=>m.id===input.referenceId))throw bad('参考模型不存在，请刷新参考目录');
  const next={...bindings};if(input.referenceId)next[key(input.source,input.id)]=input.referenceId;else delete next[key(input.source,input.id)];
  await writeJson(bindingsFile,next);bindings=next;return{ok:true};
 })};
}
