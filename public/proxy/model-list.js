import {capacityLimit,capacityOptions,fastSetting} from './model-options.js';
import {selectField} from '../components/select.js';
import {disclosureSection,mountDisclosures,refreshButton,setRefreshState} from '../components/section.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function modelGroups(models,row,{open=false,selected=m=>m.enabled!==false}={}) {
  const enabled=models.map((m,i)=>({m,i})).filter(({m})=>selected(m));
  const disabled=models.map((m,i)=>({m,i})).filter(({m})=>!selected(m));
  return enabled.map(({m,i})=>row(m,i)).join('')+(disabled.length?`<details class="proxy-disabled-models" ${open?'open':''}><summary>未启用模型 <span>${disabled.length}</span></summary>${disabled.map(({m,i})=>row(m,i)).join('')}</details>`:'');
}

function modelSummary(m){
 const context=m.contextWindow||m.contextWindows?.find(w=>w.isDefault)?.length;
 const quantity=value=>Number.isFinite(value)&&value>0?Number(value).toLocaleString():'上游未提供';
 return `<p class="proxy-hint">上下文 ${quantity(context)} · 最大输出 ${quantity(m.maxOutputTokens)}</p><p class="proxy-hint">上游默认推理强度：${esc(m.defaultEffort||'上游未提供')}${m.thinkingType==='only'?' · 不支持关闭思考':''}</p><p class="proxy-hint">支持的推理强度：${esc(m.reasoningEfforts?.length?m.reasoningEfforts.join(' · '):m.isReasoning===false?'不支持思考':'上游未提供')}</p>`;
}
export function updateModelSummary(row,model){
 row.querySelector('.proxy-hint').outerHTML=modelSummary(model).split('</p>')[0]+'</p>';
}
function modelHeading(m,selection){
 return `<div class="proxy-model-heading"><div>${esc(m.displayName||m.upstreamId||m.id)}<small>${esc(m.id)}</small></div><label class="proxy-checkbox ui-first-line-slot">${selection}启用</label></div>`;
}
function capacityFields(m,field){
 return ['contextWindow','maxOutputTokens'].map(name=>field(name,name==='contextWindow'?'上下文':'最大输出',m[name]??capacityLimit(m,name)??'',capacityOptions(m,name),!capacityLimit(m,name))).join('');
}
export function renderModelRow(m){
 const fields=m.settingFields||[],field=(name,label,value,options,disabled=false)=>`<div class="proxy-model-field" data-model="${esc(m.id)}" data-field="${name}">${selectField({name,label,value,options,disabled,compact:true})}</div>`;
 const effort=fields.includes('effort')?field('effort','默认推理强度',m.effort||'auto',[{value:'auto',label:'自动'},...m.reasoningEfforts.map(level=>({value:level,label:level}))]):'';
 const fast=fastSetting(m),speed=fast?`<label class="proxy-checkbox"><input type="checkbox" data-model="${esc(m.id)}" data-field="${fast.field}" ${fast.on?`data-fast-tier="${esc(fast.on)}"`:''} ${fast.checked?'checked':''} aria-label="Fast ${esc(m.id)}">Fast</label>`:'';
 return `<div class="proxy-model">${modelHeading(m,`<input type="checkbox" data-model="${esc(m.id)}" data-field="enabled" ${m.enabled?'checked':''} aria-label="启用 ${esc(m.id)}">`)}${modelSummary(m)}<div class="proxy-model-options">${capacityFields(m,field)}${effort}${speed}</div></div>`;
}

export function createModelList({store,source}){
 const element=document.createElement('div');element.innerHTML=disclosureSection({id:source+'-models-details',className:'proxy-disclosure',title:'模型设置',description:'启用与默认参数',actions:refreshButton({ariaLabel:'刷新模型',attrs:{'data-refresh-models':true}}),content:'<div data-models-list></div><p class="proxy-hint proxy-model-message ui-feedback-row" role="status" data-message></p>'});mountDisclosures(element);
 const details=element.querySelector('details'),list=element.querySelector('[data-models-list]'),message=element.querySelector('[data-message]'),refresh=element.querySelector('[data-refresh-models]');let models=[],loading=false,version=0,visible=false;
 function paint(){const open=list.querySelector('.proxy-disabled-models')?.open||false;list.innerHTML=modelGroups(models,renderModelRow,{open});}
 async function load(force=false){
  if(loading)return;loading=true;const current=version;message.textContent='正在获取模型…';setRefreshState(refresh,{loading:true});
  try{const result=await store.resource(source,'models',{refresh:force});if(current!==version||result===undefined)return;models=result;paint();message.textContent=models.length?'':'账号暂无可用模型';}
  catch(e){if(current===version&&e.name!=='AbortError')message.textContent=e.message;}
  finally{if(current===version){loading=false;setRefreshState(refresh);}}
 }
 list.onchange=async event=>{
  const input=event.target,{model,field}=input.closest('[data-model]')?.dataset||{};if(!model)return;
  const original=models.find(m=>m.id===model),current=version;input.disabled=true;
  try{const value=input.type==='checkbox'?input.dataset.fastTier?input.checked?input.dataset.fastTier:'auto':input.checked:['context','contextWindow','maxOutputTokens'].includes(field)?Number(input.value):input.value;const result=await store.setModel(source,{id:model,field,value});if(current!==version)return;models=result;message.textContent='已保存';if(field==='enabled')paint();else if(['contextWindow','maxOutputTokens'].includes(field)){const updated=models.find(m=>m.id===model),row=input.closest('.proxy-model');updateModelSummary(row,updated);}}
  catch(e){if(current!==version)return;message.textContent=e.message;if(input.type==='checkbox')input.checked=field==='enabled'?original.enabled:field==='serviceTier'?['priority','fast'].includes(original.serviceTier):original.fast;else input.value=['contextWindow','maxOutputTokens'].includes(field)?original[field]??'':field==='context'?original.contextWindows.find(w=>w.isDefault)?.length:field==='serviceTier'?original.serviceTier||'auto':field==='fast'?original.fast?'fast':'default':original.effort||'auto';}
  finally{input.disabled=false;}
 };
 details.ontoggle=()=>{if(details.open&&visible)void load();};refresh.onclick=()=>{void load(true);};
 return{element,load,refreshIfOpen(force=false){if(details.open)void load(force);},getModel:()=>models.find(m=>m.enabled)?.id,setVisible(value){visible=value;if(value&&details.open)void load();},reset(){version++;loading=false;models=[];list.replaceChildren();message.textContent='';setRefreshState(refresh);},dispose(){version++;}};
}

// Draft mode keeps edits in the Custom transaction; the same module owns all model rows.
export function renderDraftModelRow(m,i){
 const field=(name,label,value,options,disabled=false)=>`<div class="proxy-model-field" data-draft-field="${name}">${selectField({name,label,value,options,disabled,compact:true})}</div>`;
 const effort=m.reasoningEfforts?.length?field('effort','默认推理强度',m.effort||'auto',[{value:'auto',label:'自动'},...m.reasoningEfforts.map(level=>({value:level,label:level}))]):'';
 return `<div class="custom-model-row proxy-model" data-model-index="${i}">${modelHeading(m,`<input type="checkbox" data-selected ${m.enabled!==false?'checked':''} aria-label="启用 ${esc(m.id)}">`)}${modelSummary(m)}<div class="proxy-model-options">${capacityFields(m,field)}${effort}</div><details><summary>选项</summary><div class="custom-proxy-grid"><label>对外名称<input data-alias value="${esc(m.id)}" placeholder="${esc(m.upstreamId)}"></label><label>上下文上限<input data-context-limit type="number" min="1" value="${capacityLimit(m,'contextWindow')||''}" placeholder="上游未提供"></label><label>支持的思考档位<input data-efforts value="${esc((m.reasoningEfforts||[]).join(', '))}" placeholder="例如 low, high, max"></label><label>最大输出上限<input data-output-limit type="number" min="1" value="${capacityLimit(m,'maxOutputTokens')||''}" placeholder="上游未提供"></label></div></details></div>`;
}
