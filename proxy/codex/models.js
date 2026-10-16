import {positiveCapacity,booleanCapability,reasoningCapabilities} from '../../core/model-capabilities.js';
// Account-specific catalog from the documented ChatGPT plan /v1/models endpoint.
export function parseModels(catalog){
 const rows=catalog.models;if(!Array.isArray(rows))throw Error('ChatGPT 未返回有效模型目录');
 return rows.filter(m=>typeof m.slug==='string'&&m.slug&&m.visibility==='list').map(m=>({id:m.slug,displayName:m.display_name||m.slug,provider:'codex',source:'codex',enabled:true,contextWindows:[],contextWindow:positiveCapacity(m.context_window),maxOutputTokens:positiveCapacity(m.max_output_tokens),isVL:Array.isArray(m.input_modalities)?m.input_modalities.includes('image'):booleanCapability(m.supports_images),...reasoningCapabilities(m.supports_reasoning,m.supported_reasoning_efforts?.map(e=>typeof e==='string'?e:e.reasoning_effort)),defaultEffort:m.default_reasoning_effort,serviceTiers:m.service_tiers||[],capabilities:{nativeResponses:true,tools:true}}));
}
