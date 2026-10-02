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
