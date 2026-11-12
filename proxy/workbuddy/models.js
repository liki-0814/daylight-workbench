import {positiveCapacity,booleanCapability,reasoningCapabilities} from '../../core/model-capabilities.js';
export function parseModels(payload){
 const data=payload?.data;if(payload?.code!==0||!Array.isArray(data?.models)||!Array.isArray(data?.agents))throw Error('WorkBuddy 模型目录无效');
 const cli=data.agents.find(agent=>agent.name==='cli');if(!Array.isArray(cli?.models))throw Error('WorkBuddy 未返回 CLI 模型目录');
 const ids=new Set(cli.models);
 return data.models.filter(m=>typeof m?.id==='string'&&m.id&&m.id.length<=200&&ids.has(m.id)&&m.disabled!==true).map(m=>({
  id:m.id,displayName:typeof m.name==='string'?m.name:m.id,provider:'workbuddy',source:'workbuddy',enabled:true,
  contextWindow:positiveCapacity(m.maxInputTokens),maxOutputTokens:positiveCapacity(m.maxOutputTokens),contextWindows:[],
  ...reasoningCapabilities(m.supportsReasoning,Array.isArray(m.reasoning?.supportedEfforts)?m.reasoning.supportedEfforts:undefined),
  isVL:booleanCapability(m.supportsImages===true&&m.disabledMultimodal!==true),capabilities:{nativeChat:true,tools:m.supportsToolCall===true},
 }));
}
