// Display presets are shared by every model editor; upstream limits remain authoritative.
import {positiveCapacity as positive,capacityLimit} from '../../core/model-capabilities.js';
export {capacityLimit};
export const contextPresets=[256000,353000,500000,1000000];
const outputPresets=[4096,8192,16384,32768,65536,131072,262144,524288,1048576];
export function capacityOptions(model,field){
 const limit=capacityLimit(model,field);if(!limit)return[{value:'',label:'上游未提供'}];
 const presets=field==='contextWindow'?contextPresets:outputPresets;
 const selected=model[field],values=[...new Set([...presets.filter(value=>value<=limit),limit,...(positive(selected)&&selected<=limit?[selected]:[])])].sort((a,b)=>a-b);
 return values.map(value=>({value,label:field==='maxOutputTokens'&&outputPresets.includes(value)?`${value/1024}k`:`${Number((value/1000).toFixed(3))}k`}));
}
export function fastSetting(model){
 const fields=model.settingFields||[];
 if(fields.includes('fast')&&model.supportsFast)return{field:'fast',checked:!!model.fast};
 const tier=model.serviceTiers?.find(t=>['priority','fast'].includes(t.id));
 if(fields.includes('serviceTier')&&tier)return{field:'serviceTier',on:tier.id,checked:['priority','fast'].includes(model.serviceTier)};
}
