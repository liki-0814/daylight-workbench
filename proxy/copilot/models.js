import {positiveCapacity,booleanCapability,reasoningCapabilities} from '../../core/model-capabilities.js';

export function parseModels(data){
 if(!Array.isArray(data.data))throw Error('Copilot 未返回有效模型列表');
 return data.data.filter(m=>typeof m.id==='string'&&m.id&&m.capabilities?.type==='chat'&&!['disabled','unconfigured'].includes(m.policy?.state)).flatMap(m=>{
  const endpoints=m.supported_endpoints||['/chat/completions'];
  const nativeEndpoints={chat:'/chat/completions',responses:'/responses',messages:'/v1/messages'};
  const protocols=Object.keys(nativeEndpoints).filter(p=>endpoints.includes(nativeEndpoints[p]));
  if(!protocols.length)return[];
  const {limits={},supports={}}=m.capabilities;
  return[{id:m.id,displayName:m.name||m.id,provider:'copilot',source:'copilot',enabled:true,nativeProtocols:protocols,pi:protocols.includes('messages')?{}:{'anthropic-messages':'此 Copilot 模型未提供原生 Messages，Pi 的 thinking 预算与缓存字段需使用 Responses 或 Chat Completions'},contextWindow:positiveCapacity(limits.max_context_window_tokens),maxInputTokens:positiveCapacity(limits.max_prompt_tokens),maxOutputTokens:positiveCapacity(limits.max_output_tokens),contextWindows:[],...reasoningCapabilities(supports.reasoning,m.capabilities.reasoning_effort?.supported_values),isVL:booleanCapability(supports.vision),capabilities:{nativeChat:protocols.includes('chat'),tools:booleanCapability(supports.tool_calls)}}];
 });
}
