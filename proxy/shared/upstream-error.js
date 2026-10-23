// Upstreams may echo prompts, credentials or image data in their error messages.
// Only allowlisted metadata and locally generated summaries may leave this module.
const summaries = {
  tool_result_sequence: '工具调用与结果顺序不匹配，请检查完整工具批次和历史',
  context_length: '请求超过上游上下文限制，请缩减历史或附件',
  invalid_image: '上游无法处理图片，请检查图片格式、大小和模型视觉能力',
  unsupported_parameter: '上游不支持请求中的参数，请检查协议与模型能力',
};
const field = (value, pattern) => typeof value === 'string' && pattern.test(value) ? value : undefined;
const token = value => field(value, /^[a-zA-Z0-9_.:-]{1,128}$/);
export function safeErrorDetails(error) {
  const reason = Object.hasOwn(summaries, error.reason) ? error.reason : undefined;
  return {
    param: field(error.param, /^[a-zA-Z][a-zA-Z0-9_.\[\]-]{0,159}$/),
    upstreamRequestId: token(error.upstreamRequestId),
    reason, summary: summaries[reason],
    retryable: typeof error.retryable === 'boolean' ? error.retryable : undefined,
  };
}

export function upstreamError(body, status, headers) {
  const root = body?.response ?? body;
  const detail = root?.error ?? (root?.type === 'error' ? root : undefined);
  const code = field(detail?.code, /^[a-zA-Z0-9_.-]{1,80}$/) ?? field(detail?.type, /^[a-zA-Z0-9_.-]{1,80}$/);
  const text = `${code ?? ''} ${typeof detail?.message === 'string' ? detail.message.slice(0,4096) : ''}`;
  let reason;
  if (/tool.?calls?|tool.?results?|tool_use|tool_messages/i.test(text) && /follow|match|missing|sequence|order|respond|result|immediately/i.test(text)) reason = 'tool_result_sequence';
  else if (/context_length|maximum context|too many tokens|prompt.{0,30}too long/i.test(text)) reason = 'context_length';
  else if (/invalid_image|image.{0,40}(invalid|large|size|format|unsupported)|vision.{0,30}(support|disabled)/i.test(text)) reason = 'invalid_image';
  else if (/unsupported_parameter|unknown parameter|unrecognized.{0,20}(parameter|argument)/i.test(text)) reason = 'unsupported_parameter';
  const details = safeErrorDetails({param:detail?.param,reason,
    upstreamRequestId: token(headers?.get('x-request-id')) ?? token(headers?.get('request-id')) ?? token(root?.request_id) ?? token(body?.request_id),
    // Authentication may be recovered by a different configured source/key.
    retryable: !reason && ([401,403,404,408,429].includes(status) || status >= 500),
  });
  return Object.assign(new Error(`上游请求失败（${status}）${details.summary ? '：' + details.summary : ''}`), {status,code,...details});
}

export async function readUpstreamError(response) {
  // One total deadline and a hard byte limit; neither slow reads nor cancellation may block errors.
  let reader, timer, body;
  try {
    reader = response.body?.getReader();
    if (reader) {
      const expired = new Promise(resolve => { timer = setTimeout(() => resolve(null), 1000); });
      const chunks = []; let bytes = 0;
      for (;;) {
        const part = await Promise.race([reader.read(), expired]);
        if (!part) break;
        if (part.done) { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); break; }
        bytes += part.value.byteLength;
        if (bytes > 16384) break;
        chunks.push(Buffer.from(part.value));
      }
    }
  } catch { /* Malformed and unreadable bodies still preserve the HTTP status and headers. */ }
  finally {
    clearTimeout(timer);
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  return upstreamError(body, response.status >= 400 && response.status < 600 ? response.status : 502, response.headers);
}
