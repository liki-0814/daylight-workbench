import {readJson,writeJson,serial} from './store.js';
import {validOutputBudget,validEffort} from './request-parameters.js';

const positive=value=>Number.isSafeInteger(value)&&value>0?value:undefined;
export function applyCapacitySettings(models,settings={}){
 return models.map(model=>{
  const windows=model.contextWindows||[];
  const contextLimit=positive(model.contextLimit)??positive(Math.max(0,...windows.map(w=>w.length)))??positive(model.contextWindow)??positive(model.maxInputTokens);
  const outputLimit=positive(model.outputLimit)??positive(model.maxOutputTokens);
  const saved=settings.capacities?.[model.id]||{};
  const requestedContext=saved.contextWindow??settings.context?.[model.id]??(model.contextLimit?model.contextWindow:undefined);
  const requestedOutput=saved.maxOutputTokens??(model.outputLimit?model.maxOutputTokens:undefined);
  const contextWindow=positive(requestedContext)&&requestedContext<=contextLimit?requestedContext:contextLimit;
  const maxOutputTokens=positive(requestedOutput)&&requestedOutput<=outputLimit?requestedOutput:outputLimit;
  // Qoder advertises discrete native windows. Client capacity may be lower than a window,
  // but an upstream request always selects a real window large enough for that capacity.
  const nativeWindow=[...windows].sort((a,b)=>a.length-b.length).find(w=>w.length>=contextWindow)?.length;
  return {...model,contextLimit,outputLimit,contextWindow,maxOutputTokens,...(nativeWindow?{contextWindows:windows.map(w=>({...w,isDefault:w.length===nativeWindow}))}:{})};
 });
}

// Keep each provider's existing JSON layout. This handles shared fields only.
export function applyModelSettings(models,settings){
 return applyCapacitySettings(models,settings).map(m=>({...m,enabled:!(settings.disabled||[]).includes(m.id),effort:settings.efforts?.[m.id],...(settings.maxTokens?.[m.id]!==undefined?{defaultMaxTokens:settings.maxTokens[m.id]}:{}),...(settings.tiers?.[m.id]!==undefined?{serviceTier:settings.tiers[m.id]}:{})}));
}
export function updateModelSetting(settings,model,{field,value},{fields=['enabled','effort'],invalid,error='不支持的模型设置',enableIds=[]}={}){
 const id=model.id;
 if(!fields.includes(field))throw invalid(error);
 if(field==='enabled'&&typeof value==='boolean'){
  const disabled=new Set(settings.disabled||[]);
  if(value)for(const key of [id,...enableIds])disabled.delete(key);else disabled.add(id);
  settings.disabled=[...disabled];
 }else if(field==='effort'&&(value==='auto'||validEffort(value,model.reasoningEfforts||[]))){
  settings.efforts||={};if(value==='auto')delete settings.efforts[id];else settings.efforts[id]=value;
 }else if(field==='maxTokens'&&(value===null||validOutputBudget(value,model.maxOutputTokens))){
  settings.maxTokens||={};if(value===null)delete settings.maxTokens[id];else settings.maxTokens[id]=value;
 }else if(['contextWindow','maxOutputTokens'].includes(field)){
  const ceiling=field==='contextWindow'?model.contextLimit:model.outputLimit;
  if(!positive(value)||!positive(ceiling)||value>ceiling)throw invalid('所选容量超出模型支持的上限');
  settings.capacities||={};settings.capacities[id]||={};
  if(value===ceiling)delete settings.capacities[id][field];else settings.capacities[id][field]=value;
 }else if(field==='serviceTier'&&['auto','default',...(model.serviceTiers||[]).map(t=>t.id)].includes(value)){
  settings.tiers||={};if(value==='auto')delete settings.tiers[id];else settings.tiers[id]=value;
 }else throw invalid(error);
 return settings;
}
export function modelSettings(file){
 const mutate=serial();
 return {read:()=>readJson(file,{}),save:(model,input,options)=>mutate(async()=>{
  const settings=updateModelSetting(await readJson(file,{}),model,input,options);
  await writeJson(file,settings);
 })};
}
