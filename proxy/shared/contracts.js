import {capacityLimit,positiveCapacity} from '../../core/model-capabilities.js';
/** Diagnostics are metadata only; never pass an upstream body or error message. */
export const protocolFor = endpoint => ({ '/chat/completions': 'chat', '/responses': 'responses', '/messages': 'messages' })[endpoint];

export function classifyError({ code, status, name } = {}) {
  if (status === 401 || status === 403 || ['401', '403', 'source_auth_required'].includes(code)) return 'authentication';
  if (status === 429 || code === '429' || code === '10605') return 'rate_limit';
  if (name === 'TimeoutError' || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'idle_timeout'].includes(code)) return 'timeout';
  if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'network';
  if (code === 'incomplete_stream') return 'interrupted';
  if (code === 'model_not_found') return 'model';
  if (status === 400 || code === 'invalid_request') return 'parameters';
  return 'upstream';
}

export const errorHints = {
  authentication: '请检查对应来源的登录或 API Key',
  rate_limit: '请检查额度，或稍后重试',
  timeout: '请检查网络，或稍后重试',
  network: '请检查网络与上游地址',
  interrupted: '上游连接提前结束，可重试',
  model: '请检查模型名称、启用状态及名称冲突',
  parameters: '请检查参数；跨协议调用可改用上游原生协议',
  upstream: '请检查来源状态，或稍后重试',
};

export function diagnosticError(error) {
  const upstreamCode = error.code ?? error.cause?.code;
  const category = classifyError({ code: upstreamCode, status: error.status, name: error.name });
  const code = typeof upstreamCode === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(upstreamCode) ? upstreamCode : undefined;
  return { category, code, status: error.status, hint: errorHints[category] };
}

/** Public metadata: no credential, transport or mutable settings object escapes. */
export function sourceSnapshot({id,name,identityKey,configured=true,connected=false,error,checkedAt,catalogIdentityKey,authentication,capabilities={},nativeProtocols=[],revision}) {
 return {id,name,kind:id.startsWith('custom:')?'custom':'builtin',enabled:true,configured,connected,error,identityKey,revision:revision||identityKey,checkedAt,catalogIdentityKey,authentication,capabilities,nativeProtocols};
}
export function modelCapabilities(models,fields){
 return models.map(model=>({...model,settingFields:[...new Set([...fields,'contextWindow','maxOutputTokens'])].filter(field=>field!=='context'||model.contextWindows?.length).filter(field=>field!=='effort'||model.reasoningEfforts?.length).filter(field=>field!=='fast'||model.supportsFast)}));
}

/**
 * Provider.execute({raw,protocol,model,conversationId,stateful}, {signal,observe,conversationId})
 * -> {kind:'response', response, protocol, streaming, ...relayMetadata}
 *  | {kind:'events', events:AsyncIterable, renderers?, headerTimeoutOnly?}
 * Snapshot and execution never expose credentials. Native results retain opaque upstream fields;
 * event adapters decode raw requests themselves using shared/protocol.js.
 */

// Structural validation is shared; each provider remains authoritative for persistence.
export function validateModelSetting(model, {field,value}) {
 const fail=message=>{throw Object.assign(new Error(message),{status:400});};
 if(!model.settingFields?.includes(field))fail('此来源不支持该模型设置');
 if(['enabled','fast'].includes(field)&&typeof value!=='boolean')fail('开关必须为布尔值');
 if(['context','contextWindow','maxOutputTokens','defaultMaxTokens','maxTokens'].includes(field)&&!(field==='maxTokens'&&value===null)&&!positiveCapacity(value))fail('Token 参数必须为正整数');
 if(['contextWindow','maxOutputTokens'].includes(field)){const ceiling=capacityLimit(model,field);if(!ceiling||value>ceiling)fail('所选容量超出模型支持的上限');}
 if(['maxTokens','defaultMaxTokens'].includes(field)&&value!==null&&model.maxOutputTokens&&value>model.maxOutputTokens)fail('输出预算超出模型支持的上限');
 if(field==='context'&&!model.contextWindows?.some(w=>w.length===value))fail('该模型未提供此上下文长度');
 if(field==='reasoningEfforts'&&(!Array.isArray(value)||value.length>16||value.some(e=>typeof e!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(e))))fail('思考档位需为有效字符串列表');
 if(field==='effort'&&value!=='auto'&&!model.reasoningEfforts?.includes(value))fail('该模型未提供此思考强度');
 if(field==='serviceTier'&&!['auto','default',...(model.serviceTiers||[]).map(t=>t.id)].includes(value))fail('该模型未提供此速度档位');
 if(field==='fast'&&value&&!model.supportsFast)fail('该模型不支持 Fast');
}
