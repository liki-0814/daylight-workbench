import {booleanCapability,reasoningCapabilities} from '../../core/model-capabilities.js';
// Kimi catalog fields and thinking capabilities; no credentials or I/O.
export function parseModels(data){
 if(!Array.isArray(data.data))throw Error('Kimi 未返回有效模型列表');
 return data.data.filter(m=>typeof m.id==='string'&&m.id).map(m=>{
    const efforts=m.reasoning?.effort?.valid || m.think_efforts?.valid_efforts || [];
    const reasoningEfforts=Array.isArray(efforts)?[...new Set(efforts.filter(e=>typeof e==='string'))]:[];
    const thinkingType=m.reasoning?.type || m.supports_thinking_type;
    return {id:m.id,displayName:m.display_name||m.id,provider:'kimi',source:'kimi',enabled:true,contextWindow:m.context_length||m.limit?.context||undefined,maxOutputTokens:m.max_output_tokens||m.limit?.max_output_tokens||undefined,contextWindows:[],...reasoningCapabilities(m.supports_reasoning,reasoningEfforts,thinkingType),defaultEffort:m.reasoning?.effort?.default||m.think_efforts?.default_effort,thinkingType,...(thinkingType==='only'?{thinkingLevelMap:{off:null}}:{}),isVL:booleanCapability(m.supports_image_in),capabilities:{nativeChat:true,tools:true}};
   });
}
