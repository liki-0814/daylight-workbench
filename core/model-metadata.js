import {capacityLimit,positiveCapacity,reasoningCapabilities,resolveReasoningCapabilities} from './model-capabilities.js';
const fields=['input','output','cacheRead','cacheWrite'];
export const validRate=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// A reference snapshot is derived data. Remove unchanged fills before refreshing or saving.
export function stripModelMetadata(model){
 const next={...model};
 for(const [field,value] of Object.entries(model.modelMetadata?.filled||{}))if(same(next[field],value)){if(Object.hasOwn(model.modelMetadata.base||{},field))next[field]=model.modelMetadata.base[field];else delete next[field];}
 delete next.modelMetadata;delete next.priceInfo;return next;
}
const rates=pricing=>({input:validRate(pricing?.input)?pricing.input:null,output:validRate(pricing?.output)?pricing.output:null,cacheRead:validRate(pricing?.cached_input)?pricing.cached_input:null,cacheWrite:validRate(pricing?.cache_write)?pricing.cache_write:null});
// Complete tier schedule for reference-cost statistics. Unlike Pi `cost.tiers` it keeps upper bounds,
// so bounded or gapped catalog tiers stay interpretable. A tier applies when `above < input <= atMost`.
export function referenceTierSchedule(reference,{cacheWriteIncluded=false}={}){
 if(!Array.isArray(reference?.pricing_tiers)||!reference.pricing_tiers.length)return undefined;
 const includes=cacheWriteIncluded||reference.billing?.cache_write_mode==='included_in_input';
 return reference.pricing_tiers.map(tier=>{const rate=rates(tier);if(includes&&!validRate(rate.cacheWrite))rate.cacheWrite=rate.input;return{above:tier.input_tokens_gt,atMost:tier.input_tokens_lte??null,...rate};});
}
export function piModelCost(cost){
 if(!cost||!fields.every(field=>validRate(cost[field])))return undefined;
 const result=Object.fromEntries(fields.map(field=>[field,cost[field]]));
 if(cost.tiers!==undefined){
  if(!Array.isArray(cost.tiers)||cost.tiers.some((tier,i,all)=>!tier||typeof tier!=='object'||!Number.isSafeInteger(tier.inputTokensAbove)||tier.inputTokensAbove<0||!fields.every(field=>validRate(tier[field]))||i>0&&tier.inputTokensAbove<=all[i-1].inputTokensAbove))return undefined;
  result.tiers=cost.tiers.map(t=>({inputTokensAbove:t.inputTokensAbove,...Object.fromEntries(fields.map(field=>[field,t[field]]))}));
 }
 return result;
}
export function fillModelMetadata(model,reference,{referenceId='',version='',updatedAt='',subscription=false,manualFallback=false,cacheWriteIncluded=false}={}){
 const next=stripModelMetadata(model),filled={},base={};
 const fill=(field,value)=>{if(value!==undefined){if(next[field]!==undefined)base[field]=structuredClone(next[field]);next[field]=value;filled[field]=structuredClone(value);}};
 {
  const upstream=manualFallback?(next.upstreamCapabilities||{}):next;
  for(const [field,limit,ref] of [['contextWindow','contextLimit','context_length'],['maxOutputTokens','outputLimit','max_output_tokens']]){
   const declared=manualFallback?capacityLimit(upstream,field):next.manualCapacities?.[field]?positiveCapacity(next[limit]):capacityLimit(next,field);
   const value=declared??positiveCapacity(reference?.limits?.[ref]);
   if(value){if(next[field]!==value)fill(field,value);if(next[limit]!==value)fill(limit,value);}
  }
  const reasoning=reference?.reasoning_effort;
  const levels=reasoning?.field_status?.levels==='verified'&&Array.isArray(reasoning.levels)?reasoning.levels.filter(level=>typeof level==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(level)):undefined;
  if(levels?.length&&reasoning.can_disable===true&&!levels.some(level=>['off','none'].includes(level)))levels.unshift('none');
  const referenceReasoning={...reasoningCapabilities(reasoning?.field_status?.supported==='verified'?reasoning.supported:undefined,levels),defaultEffort:reasoning?.default};
  const resolved=resolveReasoningCapabilities(upstream,referenceReasoning,manualFallback?next:undefined);
  for(const field of ['isReasoning','reasoningEfforts','reasoningEffortsProvided','thinkingType','defaultEffort'])if(resolved[field]!==undefined&&!same(next[field],resolved[field]))fill(field,resolved[field]);
  if(next.settingFields&&!next.settingFields.includes('effort')&&next.reasoningEfforts?.length)fill('settingFields',[...next.settingFields,'effort']);
 }
 const includedCacheWrite=cacheWriteIncluded||reference?.billing?.cache_write_mode==='included_in_input';
 const original=next.cost, fallback=reference&&!next.pricingConflict?rates(reference.pricing):undefined;
 if(fallback)for(const [field,source] of [['input','input'],['output','output'],['cacheRead','cached_input'],['cacheWrite','cache_write']])if(reference.pricing_status?.[source]&&!['verified','reference'].includes(reference.pricing_status[source]))fallback[field]=null;
 if(original||fallback){
  const cost=Object.fromEntries(fields.map(field=>[field,validRate(original?.[field])?original[field]:fallback?.[field]??null]));
  // Grok cache establishment is ordinary input, not a separate unknown/free charge.
  if(includedCacheWrite&&!next.pricingConflict&&!validRate(cost.cacheWrite))cost.cacheWrite=cost.input;
  if(original?.tiers!==undefined)cost.tiers=structuredClone(original.tiers);
  else if(reference?.pricing_tiers?.length&&!next.pricingConflict){
   cost.tiers=reference.pricing_tiers.map(tier=>{const rate=rates(tier);if(includedCacheWrite&&!validRate(rate.cacheWrite))rate.cacheWrite=rate.input;return{inputTokensAbove:tier.input_tokens_gt,...rate};});
   // Pi tiers have no upper bound; unsupported gaps/bounded final tiers cannot be exported.
   if(reference.pricing_tiers.some((t,i,all)=>t.input_tokens_lte!=null&&t.input_tokens_lte!==all[i+1]?.input_tokens_gt))cost.tiers=null;
  }
  fill('cost',cost);
 }
 const fromReference=!!(reference&&!next.pricingConflict&&(!original||fields.some(field=>!validRate(original[field]))||original.tiers===undefined&&reference.pricing_tiers?.length));
 next.priceInfo={...(next.pricingConflict?{note:'多 Key 价表不同，Pi 无法按实际 Key 计费'}:{}),currency:'USD',unit:'per_1M_tokens',complete:!!piModelCost(next.cost),referenceEstimate:!!(subscription||fromReference&&(reference.price_basis?.type==='reference'||reference.billing?.channel==='subscription')),basis:fromReference?(reference.price_basis?.source==='local'?'official-reference':'llm-pricing'):'upstream',...(reference?{referenceId:reference.id,updatedAt,version,note:reference.price_basis?.note||reference.billing?.note||'',sources:reference.price_basis?.sources||reference.price_basis?.urls||[],cacheWriteIncluded:!validRate(original?.cacheWrite)&&includedCacheWrite}:{})};
 if(next.pricingConflict)Object.assign(next.priceInfo,{complete:false,basis:'mixed',note:'多 Key 价表不同，Pi 无法按实际 Key 计费'});
 next.modelMetadata={referenceId,matchedId:reference?.id||'',version,updatedAt,filled,base};
 return next;
}
export function mergeModelPrices(models){
 const first=models[0];
 if(models.every(m=>same(m.cost,first.cost)))return{...(first.cost?{cost:first.cost}:{}),...(models.some(m=>m.priceInfo)?{priceInfo:{...first.priceInfo,referenceEstimate:models.some(m=>m.priceInfo?.referenceEstimate)}}:{})};
 return{cost:undefined,pricingConflict:true,priceInfo:{complete:false,referenceEstimate:false,note:'路由来源价表不同，Pi 无法按实际来源计费'}};
}
export function modelPriceLabel(model){
 const cost=model.cost,info=model.priceInfo||{};
 if(!cost)return info.note||'价格未知 · 沿用 Pi 默认';
 const label=value=>validRate(value)?'$'+value:'未知';
 return `${info.referenceEstimate?'参考估算':'价格'} / 百万 token：输入 ${label(cost.input)} · 输出 ${label(cost.output)} · 缓存读取 ${label(cost.cacheRead)} · ${info.cacheWriteIncluded?'缓存建立计入普通输入':'缓存写入 '+label(cost.cacheWrite)}${cost.tiers?.length?' · '+cost.tiers.length+' 档长上下文价':''}${!piModelCost(cost)?' · 价表不完整，Pi 沿用默认':''}${info.referenceEstimate?'（不代表订阅实际扣费）':''}`;
}
// Discovery replaces upstream declarations; only explicit prior settings survive.
export function mergeDiscoveredModels(discovered,prior){
 return discovered.map(row=>{
  const model=stripModelMetadata(row),previous=prior.map(stripModelMetadata).find(p=>p.upstreamId===model.upstreamId);
  return{...model,id:previous?.id||model.id,enabled:previous?.enabled??false,referenceId:previous?.referenceId,
   contextLimit:model.contextLimit??model.contextWindow??previous?.contextLimit,outputLimit:model.outputLimit??model.maxOutputTokens??previous?.outputLimit,
   contextWindow:model.contextWindow&&previous?.contextWindow?Math.min(previous.contextWindow,model.contextWindow):model.contextWindow??previous?.contextWindow,
   maxOutputTokens:model.maxOutputTokens&&previous?.maxOutputTokens?Math.min(previous.maxOutputTokens,model.maxOutputTokens):model.maxOutputTokens??previous?.maxOutputTokens,
   reasoningEfforts:model.reasoningEfforts??previous?.reasoningEfforts,reasoningEffortsProvided:model.reasoningEffortsProvided??previous?.reasoningEffortsProvided,effort:previous?.effort,manualCapacities:previous?.manualCapacities,upstreamCapabilities:model.upstreamCapabilities??Object.fromEntries(['contextWindow','maxOutputTokens','isReasoning','isVL','reasoningEfforts','reasoningEffortsProvided'].filter(k=>model[k]!==undefined).map(k=>[k,model[k]]))};
 });
}
