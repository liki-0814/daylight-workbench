import {modelPriceLabel} from '../../core/model-metadata.js';
import {reasoningCapabilityLabel} from '../../core/model-capabilities.js';
import {capacityLimit,capacityOptions,fastSetting} from './model-options.js';
import {selectField} from '../components/select.js';
import {disclosureSection,mountDisclosures,refreshButton,setRefreshState} from '../components/section.js';
import {renderModelSpeed,updateModelSpeeds} from '../components/model-speed.js';
import {modelGroups,modelHeading,onTabReturn,pinToggle,regroupPins,repaintKeepingControl} from '../components/model-row.js';
export {modelGroups} from '../components/model-row.js';
export {renderModelSpeed,updateModelSpeeds} from '../components/model-speed.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function modelSummary(m){
 const context=m.contextWindow||m.contextWindows?.find(w=>w.isDefault)?.length;
 const quantity=value=>Number.isFinite(value)&&value>0?Number(value).toLocaleString():'未提供（Pi 默认）';
 const reasoning=reasoningCapabilityLabel(m);
 return `<div data-model-summary><p class="proxy-hint">上下文 ${quantity(context)} · 最大输出 ${quantity(m.maxOutputTokens)}</p><p class="proxy-hint">默认推理强度：${esc(m.effort||m.defaultEffort||'未提供')}${m.thinkingType==='only'?' · 不支持关闭思考':''}</p><p class="proxy-hint">支持的推理强度：${esc(reasoning)}</p><p class="proxy-hint">${esc(modelPriceLabel(m))}</p>${renderModelSpeed(m)}${m.modelMetadata?.matchedId?`<p class="proxy-hint">${m.priceInfo?.basis==='official-reference'?'官方价表（本地补充）':'参考目录'}：${esc(m.modelMetadata.matchedId)} · ${esc(m.modelMetadata.updatedAt)} · 仅补全上游未提供的字段</p>`:''}</div>`;
}
export function updateModelSummary(row,model){
 row.querySelector('[data-model-summary]').outerHTML=modelSummary(model);
}
function capacityFields(m,field){
 return ['contextWindow','maxOutputTokens'].map(name=>field(name,name==='contextWindow'?'上下文':'最大输出',m[name]??capacityLimit(m,name)??'',capacityOptions(m,name),!capacityLimit(m,name))).join('');
}
export function referenceOptions(references,current=''){return[{value:'',label:'自动匹配模型 ID'},...references.map(m=>({value:m.id,label:m.name+' · '+m.id})),...(current&&!references.some(m=>m.id===current)?[{value:current,label:'已关联（目录未收录）：'+current}]:[])];}
function referenceField(m,references,field){
 const referenceId=m.referenceId??m.modelMetadata?.referenceId??'',matchedId=m.modelMetadata?.matchedId;
 const status=matchedId?'已匹配：'+matchedId:m.modelMetadata?'未匹配到参考模型':'等待匹配';
 return `<div class="proxy-model-reference">${field('referenceId','参考模型关联',referenceId,referenceOptions(references,referenceId))}${referenceId?'':`<span class="proxy-model-reference-status" role="status">${esc(status)}</span>`}</div>`;
}
export function renderModelRow(m,references=[],state={}){
 const fields=m.settingFields||[],field=(name,label,value,options,disabled=false)=>`<div class="proxy-model-field" data-model="${esc(m.id)}" data-field="${name}">${selectField({name,label,value,options,disabled,compact:true})}</div>`;
 const effort=fields.includes('effort')?field('effort','默认推理强度',m.effort||'auto',[{value:'auto',label:'自动'},...m.reasoningEfforts.map(level=>({value:level,label:level}))]):'';
 const fast=fastSetting(m),speed=fast?`<label class="proxy-checkbox"><input type="checkbox" data-model="${esc(m.id)}" data-field="${fast.field}" ${fast.on?`data-fast-tier="${esc(fast.on)}"`:''} ${fast.checked?'checked':''} aria-label="Fast ${esc(m.id)}">Fast</label>`:'';
 return `<div class="proxy-model">${modelHeading(m,`<input type="checkbox" data-model="${esc(m.id)}" data-field="enabled" ${m.enabled?'checked':''} aria-label="启用 ${esc(m.id)}">`,{pending:state.pending,selected:m.enabled})}${modelSummary(m)}<div class="proxy-model-options">${capacityFields(m,field)}${effort}${speed}${referenceField(m,references,field)}</div></div>`;
}

export function createModelList({store,source}){
 const element=document.createElement('div');element.innerHTML=disclosureSection({id:source+'-models-details',className:'proxy-disclosure',title:'模型设置',description:'启用与默认参数',actions:refreshButton({ariaLabel:'刷新模型',attrs:{'data-refresh-models':true}}),content:'<div data-models-list></div><p class="proxy-hint proxy-model-message ui-feedback-row" role="status" data-message></p>'});mountDisclosures(element);
 const details=element.querySelector('details'),list=element.querySelector('[data-models-list]'),message=element.querySelector('[data-message]'),refresh=element.querySelector('[data-refresh-models]');let models=[],references=[],referenceSnapshot,loaded=false,loading=false,version=0,visible=false;const pins=new Map();
 function paintSpeeds(){updateModelSpeeds(list,store.source(source)?.performance,{stale:!!store.error});}
 function paint(forceOpen=false){const open=forceOpen||list.querySelector('.proxy-disabled-models')?.open||false;list.innerHTML=modelGroups(models,(m,i,state)=>renderModelRow(m,references,state),{open,pins});paintSpeeds();}
 const unsubscribe=store.subscribe(paintSpeeds),stopTabReturn=onTabReturn(()=>{if(visible&&details.open)regroupPins(pins,paint);});
 async function load(force=false){
  if(loading||!force&&loaded&&models===store.cachedResource(source,'models')&&referenceSnapshot&&referenceSnapshot===store.cachedResource(null,'model-metadata'))return;
  loading=true;const current=version;let retry=false;message.textContent=loaded?'正在刷新模型…':'正在获取模型…';setRefreshState(refresh,{loading:true});
  try{
   let [result,reference]=await Promise.all([store.resource(source,'models',{refresh:force}),store.resource(null,'model-metadata',{refresh:force}).catch(e=>({...store.cachedResource(null,'model-metadata')||{models:[]},error:e.message}))]);
   if(current!==version)return;
   if(result===undefined||reference===undefined){retry=true;return;}
   if(reference.meta?.data_version&&result.some(m=>m.modelMetadata&&m.modelMetadata.version!==reference.meta.data_version)){
    store.invalidate(source);result=await store.resource(source,'models');if(current!==version)return;if(result===undefined){retry=true;return;}
   }
   references=reference.models;referenceSnapshot=reference;models=result;loaded=true;if(force)pins.clear();paint();message.textContent=reference.error||(models.length?'':'账号暂无可用模型');
  }
  catch(e){if(current===version){if(e.name==='AbortError')retry=true;else message.textContent=e.message;}}
  finally{if(current===version){loading=false;setRefreshState(refresh);if(retry&&visible&&details.open)void load();}}
 }
 list.onchange=async event=>{
  const input=event.target,{model,field}=input.closest('[data-model]')?.dataset||{};if(!model)return;
  const original=models.find(m=>m.id===model),current=version,restoreFocus=input.closest('workbench-select')?.contains(document.activeElement);input.disabled=true;
  try{const value=input.type==='checkbox'?input.dataset.fastTier?input.checked?input.dataset.fastTier:'auto':input.checked:['context','contextWindow','maxOutputTokens'].includes(field)?Number(input.value):input.value;const result=field==='referenceId'?(await store.api.request('model-metadata',{source,id:original.upstreamId||original.id,referenceId:value})).models:await store.setModel(source,{id:model,field,value});if(field==='referenceId')store.invalidate(source);if(current!==version)return;models=result;message.textContent='已保存';if(field==='enabled')pinToggle(pins,model,!input.checked);if(['enabled','referenceId'].includes(field)){const target=field==='enabled'?`input[data-model="${CSS.escape(model)}"][data-field="enabled"]`:`[data-model="${CSS.escape(model)}"][data-field="referenceId"] .select-trigger`;repaintKeepingControl(list,target,()=>paint(),{focus:field==='enabled'||restoreFocus});}else if(['contextWindow','maxOutputTokens','effort'].includes(field)){const updated=models.find(m=>m.id===model),row=input.closest('.proxy-model');updateModelSummary(row,updated);}}
  catch(e){if(current!==version)return;message.textContent=e.message;if(input.type==='checkbox')input.checked=field==='enabled'?original.enabled:field==='serviceTier'?['priority','fast'].includes(original.serviceTier):original.fast;else if(field==='referenceId')input.value=original.modelMetadata?.referenceId||'';else input.value=['contextWindow','maxOutputTokens'].includes(field)?original[field]??'':field==='context'?original.contextWindows.find(w=>w.isDefault)?.length:field==='serviceTier'?original.serviceTier||'auto':field==='fast'?original.fast?'fast':'default':original.effort||'auto';}
  finally{input.disabled=false;paintSpeeds();}
 };
 details.ontoggle=()=>{if(details.open)regroupPins(pins,paint);if(details.open&&visible)void load();};refresh.onclick=()=>{void load(true);};
 return{element,load,refreshIfOpen(force=false){if(details.open)void load(force);},getModel:()=>models.find(m=>m.enabled)?.id,setVisible(value){visible=value;if(value){regroupPins(pins,paint);if(details.open)void load();}},reset(){pins.clear();version++;loading=false;loaded=false;referenceSnapshot=undefined;models=[];list.replaceChildren();message.textContent='';setRefreshState(refresh);},dispose(){version++;unsubscribe();stopTabReturn();}};
}

// Draft mode keeps edits in the Custom transaction; the same module owns all model rows.
const effortLevels=['none','minimal','low','medium','high','xhigh','max'];
function effortChoices(model){
 const selected=new Set(model.reasoningEfforts||[]),levels=[...effortLevels,...selected].filter((level,index,all)=>all.indexOf(level)===index);
 return `<div class="custom-effort-field" role="group" aria-label="支持的思考档位"><span>支持的思考档位</span><div class="custom-effort-choices">${levels.map(level=>`<label class="proxy-checkbox"><input type="checkbox" data-effort value="${esc(level)}" ${selected.has(level)?'checked':''}>${esc(level)}</label>`).join('')}</div></div>`;
}
export function renderDraftModelRow(m,i,references=[],state={}){
 const field=(name,label,value,options,disabled=false)=>`<div class="proxy-model-field" data-draft-field="${name}">${selectField({name,label,value,options,disabled,compact:true})}</div>`;
 const effort=m.reasoningEfforts?.length?field('effort','默认推理强度',m.effort||'auto',[{value:'auto',label:'自动'},...m.reasoningEfforts.map(level=>({value:level,label:level}))]):'';
 return `<div class="custom-model-row proxy-model" data-model-index="${i}">${modelHeading(m,`<input type="checkbox" data-selected ${m.enabled!==false?'checked':''} aria-label="启用 ${esc(m.id)}">`,{pending:state.pending,selected:m.enabled!==false})}${modelSummary(m)}<div class="proxy-model-options">${capacityFields(m,field)}${effort}${referenceField(m,references,field)}</div><details><summary>选项</summary><div class="custom-proxy-grid"><label>对外名称<input data-alias value="${esc(m.id)}" placeholder="${esc(m.upstreamId)}"></label><label>上下文上限<input data-context-limit type="number" min="1" value="${capacityLimit(m,'contextWindow')||''}" placeholder="上游未提供"></label>${effortChoices(m)}<label>最大输出上限<input data-output-limit type="number" min="1" value="${capacityLimit(m,'maxOutputTokens')||''}" placeholder="上游未提供"></label></div></details></div>`;
}
