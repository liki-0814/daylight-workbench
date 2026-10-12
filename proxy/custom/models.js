import {stripModelMetadata,mergeModelPrices,validRate} from '../../core/model-metadata.js';
import {booleanCapability,reasoningCapabilities,mergeModelCapabilities} from '../../core/model-capabilities.js';
export const customSettingFields = ['enabled','contextWindow','maxOutputTokens','defaultMaxTokens','reasoningEfforts','effort'];
import {applyCapacitySettings} from '../shared/model-settings.js';
import {invalid} from '../shared/protocol.js';
const limits=['contextWindow','maxOutputTokens','defaultMaxTokens','contextLimit','outputLimit'];

export function modelUnion(keys){
 const groups=new Map();
 for(const key of keys)for(const m of key.models){const rows=groups.get(m.id)||[];rows.push({...m,enabled:key.enabled!==false&&m.enabled!==false});groups.set(m.id,rows);}
 return [...groups.values()].map(rows=>{const active=rows.filter(m=>m.enabled),pool=active.length?active:rows,model={id:pool[0].id,upstreamId:pool[0].upstreamId,enabled:active.length>0};
  const price=mergeModelPrices(pool);if(price.cost)model.cost=price.cost;if(price.pricingConflict)model.pricingConflict=true;
  for(const field of ['referenceId','reasoningEffortsProvided','manualCapacities'])if(pool.every(m=>JSON.stringify(m[field])===JSON.stringify(pool[0][field]))&&pool[0][field]!==undefined)model[field]=pool[0][field];
  for(const [field,value] of Object.entries(mergeModelCapabilities(pool)))if([...limits,'isVL','isReasoning','reasoningEfforts'].includes(field)&&value!==undefined)model[field]=value;
  if(pool.some(m=>m.upstreamCapabilities)){const declared=pool.map(m=>m.upstreamCapabilities||{});model.upstreamCapabilities=mergeModelCapabilities(declared);if(declared.every(m=>m.reasoningEffortsProvided))model.upstreamCapabilities.reasoningEffortsProvided=true;}
  if(pool.every(m=>m.effort===pool[0].effort)&&pool[0].effort)model.effort=pool[0].effort;
  return model;
 });
}
export function validateModels(models){
 if(!Array.isArray(models))throw invalid('模型列表无效');
 const seen=new Set();return models.map(raw=>{const m=stripModelMetadata(raw),id=String(m.id||'').trim(),upstreamId=String(m.upstreamId||id).trim();
  if(!id||!upstreamId||seen.has(id)||id.length>200||upstreamId.length>200)throw invalid('模型名无效或重复');seen.add(id);
  const n={id,upstreamId,enabled:m.enabled!==false};for(const k of limits)if(m[k]!=null){if(!Number.isSafeInteger(m[k])||m[k]<1)throw invalid('Token 参数需为正整数');n[k]=m[k];}
  if(n.contextLimit&&n.contextWindow>n.contextLimit||n.outputLimit&&n.maxOutputTokens>n.outputLimit)throw invalid('所选容量超出模型支持的上限');
  if(m.reasoningEfforts!==undefined){if(!Array.isArray(m.reasoningEfforts)||m.reasoningEfforts.length>16||m.reasoningEfforts.some(e=>typeof e!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(e)))throw invalid('思考档位需为有效字符串列表');n.reasoningEfforts=[...new Set(m.reasoningEfforts)];if(m.isReasoning===false&&n.reasoningEfforts.some(e=>!['none','off'].includes(e)))throw invalid('不支持思考的模型不能配置思考档位');Object.assign(n,reasoningCapabilities(m.isReasoning,n.reasoningEfforts));}
  if(m.effort&&m.effort!=='auto'){if(typeof m.effort!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(m.effort)||n.reasoningEfforts&&!n.reasoningEfforts.includes(m.effort)||!n.reasoningEfforts&&!m.referenceId&& !raw.modelMetadata?.matchedId)throw invalid('默认思考强度需属于支持档位');n.effort=m.effort;}
  for(const field of ['isVL','isReasoning'])if(typeof m[field]==='boolean')n[field]=m[field];
  if(m.referenceId!==undefined){if(typeof m.referenceId!=='string'||m.referenceId.length>200)throw invalid('参考模型关联无效');n.referenceId=m.referenceId;}
  if(m.effort&&raw.modelMetadata?.matchedId&&!n.referenceId)n.referenceId=raw.modelMetadata.matchedId;
  const manual={...m.manualCapacities};for(const field of ['contextWindow','maxOutputTokens'])if(raw.modelMetadata?.filled[field]!==undefined&&raw[field]!==raw.modelMetadata.filled[field]&&raw[field])manual[field]=raw[field];
  for(const [field,value] of Object.entries(manual))if(!['contextWindow','maxOutputTokens'].includes(field)||!Number.isSafeInteger(value)||value<1)throw invalid('手动容量设置无效');
  if(Object.keys(manual).length)n.manualCapacities=manual;
  if(m.pricingConflict)n.pricingConflict=true;
  if(m.reasoningEffortsProvided)n.reasoningEffortsProvided=true;
  if(m.upstreamCapabilities){const declared=validateModels([{id,...m.upstreamCapabilities,upstreamCapabilities:undefined}])[0];n.upstreamCapabilities=Object.fromEntries(['contextWindow','maxOutputTokens','contextLimit','outputLimit','isReasoning','isVL','reasoningEfforts','reasoningEffortsProvided'].filter(k=>declared[k]!==undefined).map(k=>[k,declared[k]]));}
  if(m.cost){n.cost={};for(const field of ['input','output','cacheRead','cacheWrite']){if(m.cost[field]!=null&&!validRate(m.cost[field]))throw invalid('模型价格无效');n.cost[field]=m.cost[field]??null;}if(m.cost.tiers!==undefined)n.cost.tiers=m.cost.tiers;}
  return n;
 });
}
export function parseModels(data){
 if(!Array.isArray(data.data))throw invalid('上游没有返回标准模型列表，请手动填写');return data.data.filter(m=>typeof m.id==='string').map(m=>{
   const positive=values=>values.map(v=>typeof v==='string'&&/^\d+$/.test(v)?Number(v):v).find(v=>Number.isSafeInteger(v)&&v>0);
   const contextWindow=positive([m.context_length,m.context_window,m.contextWindow,m.limit?.context]);
   const maxOutputTokens=positive([m.max_output_tokens,m.max_completion_tokens,m.maxOutputTokens,m.limit?.max_output_tokens,m.limit?.output]);
   const reasoningEfforts=m.reasoningEfforts||m.reasoning_efforts||m.supported_reasoning_efforts||m.reasoning?.effort?.valid||m.think_efforts?.valid_efforts;
   const parsed={id:m.id,upstreamId:m.id,...(m.cost&&typeof m.cost==='object'?{cost:m.cost}:m.pricing?{cost:{input:m.pricing.input??null,output:m.pricing.output??null,cacheRead:m.pricing.cached_input??null,cacheWrite:m.pricing.cache_write??null}}:{}),...(Array.isArray(reasoningEfforts)?{reasoningEffortsProvided:true}:{}),...(Array.isArray(reasoningEfforts)||typeof m.supports_reasoning==='boolean'?reasoningCapabilities(m.supports_reasoning,reasoningEfforts):{}),...(typeof m.supports_image_in==='boolean'?{isVL:booleanCapability(m.supports_image_in)}:{}),...(contextWindow?{contextWindow}:{}),...(maxOutputTokens?{maxOutputTokens}:{})};
   return {...parsed,upstreamCapabilities:Object.fromEntries(['contextWindow','maxOutputTokens','isReasoning','isVL','reasoningEfforts','reasoningEffortsProvided'].filter(k=>parsed[k]!==undefined).map(k=>[k,parsed[k]]))};
  });
}

// Saved models are a permission-conservative union, not a fresh discovery.
export function catalogModels(source){
 return applyCapacitySettings(source.models).map(model=>({...model,provider:'custom:'+source.id,source:'custom:'+source.id,displayName:model.id,contextWindows:[],reasoningEfforts:model.reasoningEfforts||[],capabilities:{native_protocol:source.protocol}}));
}
