import {positiveCapacity as positive,capacityLimit} from '../../core/model-capabilities.js';
import {validateModelSetting} from './contracts.js';
import {readJson,writeJson,serial} from './store.js';

export function applyCapacitySettings(models,settings={}){
 return models.map(model=>{
  const windows=model.contextWindows||[];
  const contextLimit=capacityLimit(model,'contextWindow');
  const outputLimit=capacityLimit(model,'maxOutputTokens');
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
export function updateModelSetting(settings,model,{field,value},{fields=['enabled','effort'],invalid,error='不支持的模型设置',enableIds=[],effortField='efforts'}={}){
 const id=model.id;
 if(!fields.includes(field))throw invalid(error);
 try{validateModelSetting({...model,settingFields:fields},{field,value});}catch(e){throw invalid(e.message);}
 if(field==='enabled'){
  const disabled=new Set(settings.disabled||[]);
  if(value)for(const key of [id,...enableIds])disabled.delete(key);else disabled.add(id);
  settings.disabled=[...disabled];
 }else if(field==='effort'){
  settings[effortField]||={};if(value==='auto')delete settings[effortField][id];else settings[effortField][id]=value;
 }else if(field==='fast'||field==='context'){
  settings[field]||={};settings[field][id]=value;
 }else if(field==='maxTokens'){
  settings.maxTokens||={};if(value===null)delete settings.maxTokens[id];else settings.maxTokens[id]=value;
 }else if(['contextWindow','maxOutputTokens'].includes(field)){
  const ceiling=capacityLimit(model,field);
  settings.capacities||={};settings.capacities[id]||={};
  if(value===ceiling)delete settings.capacities[id][field];else settings.capacities[id][field]=value;
 }else if(field==='serviceTier'){
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
