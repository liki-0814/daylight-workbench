import { LLMError } from '../shared/llm/canonical.js';
import { SseParser } from '../shared/llm/sse.js';

export const invalid = (message, param) => Object.assign(new Error(message), { status: 400, code: 'invalid_request', param });
const allowed = {
  chat: 'model messages tools tool_choice stream stream_options max_tokens max_completion_tokens reasoning_effort temperature top_p response_format parallel_tool_calls user store metadata',
  responses: 'model input instructions tools tool_choice stream max_output_tokens reasoning temperature top_p text parallel_tool_calls include store metadata prompt_cache_key',
  messages: 'model messages system tools tool_choice stream max_tokens output_config thinking metadata',
};
const checkKeys = (obj, keys, label) => { for (const key of Object.keys(obj || {})) if (!keys.includes(key)) throw invalid(`Grok 暂不支持 ${label}${key}`, `${label}${key}`); };
export function compileRequest(request, model) {
  const p = request.options.protocol, raw = request.raw;
  if (!raw || !allowed[p]) throw invalid('请求协议无效');
  checkKeys(raw, allowed[p].split(' '), '');
  const effort = raw.reasoning_effort ?? raw.reasoning?.effort ?? raw.output_config?.effort ?? model.effort ?? model.defaultEffort;
  if (effort !== undefined && !model.reasoningEfforts.includes(effort)) throw invalid(`可用推理强度：${model.reasoningEfforts.join('、')}`, 'reasoning_effort');
  if (raw.thinking !== undefined && (raw.thinking?.type !== 'adaptive' || Object.keys(raw.thinking).some(k => !['type', 'display'].includes(k)) || raw.thinking.display !== undefined && raw.thinking.display !== 'summarized')) throw invalid('Grok 仅支持 adaptive thinking 与推理档位，不支持手动思考预算或关闭思考', 'thinking');
  checkKeys(raw.reasoning, ['effort', 'summary'], 'reasoning.');
  checkKeys(raw.output_config, ['effort'], 'output_config.');
  if (raw.max_tokens !== undefined && raw.max_completion_tokens !== undefined && raw.max_tokens !== raw.max_completion_tokens) throw invalid('最大输出参数冲突', 'max_tokens');
  const max = raw.max_output_tokens ?? raw.max_completion_tokens ?? raw.max_tokens ?? model.defaultMaxTokens;
  if (max !== undefined && (!Number.isInteger(max) || max < 1 || model.maxOutputTokens && max > model.maxOutputTokens)) throw invalid('最大输出必须是模型范围内的正整数', 'max_tokens');
  if (raw.store === true) throw invalid('Grok 中转使用无状态历史，请传入完整 input；不支持 store=true', 'store');
  if (raw.include !== undefined && !Array.isArray(raw.include)) throw invalid('include 必须为数组', 'include');
  if (raw.include?.some(x => x !== 'reasoning.encrypted_content')) throw invalid('不支持的 include 项', 'include');
  const body = { model: model.id, input: [], stream: true, store: false, reasoning: { effort, ...(raw.reasoning?.summary ? { summary: raw.reasoning.summary } : {}) }, include: ['reasoning.encrypted_content'] };
  if (raw.prompt_cache_key !== undefined) {
    if (typeof raw.prompt_cache_key !== 'string' || !raw.prompt_cache_key.length || raw.prompt_cache_key.length > 256) throw invalid('prompt_cache_key 必须为 1–256 字符的字符串', 'prompt_cache_key');
    body.prompt_cache_key = raw.prompt_cache_key;
  }
  if (max !== undefined) body.max_output_tokens = max;
  for (const k of ['temperature', 'top_p']) if (raw[k] !== undefined) {
    if (!Number.isFinite(raw[k]) || raw[k] < 0 || raw[k] > (k === 'temperature' ? 2 : 1)) throw invalid(`${k} 超出范围`, k);
    body[k] = raw[k];
  }
  if (raw.parallel_tool_calls !== undefined) {
    if (typeof raw.parallel_tool_calls !== 'boolean') throw invalid('parallel_tool_calls 必须为布尔值');
    body.parallel_tool_calls = raw.parallel_tool_calls;
  }
  const parts = (content, role) => {
    if (typeof content === 'string') return [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }];
    if (content == null) return [];
    if (!Array.isArray(content)) throw invalid('消息 content 格式无效');
    return content.map(b => {
      if (!b || typeof b !== 'object') throw invalid('消息内容块格式无效');
      if (b.cache_control) throw invalid('Grok 不支持 cache_control');
      if (['text', 'input_text', 'output_text'].includes(b.type) && typeof b.text === 'string') {
        return { type: role === 'assistant' ? 'output_text' : 'input_text', text: b.text };
      }
      if (['input_image', 'image_url', 'image'].includes(b.type)) {
        if (role === 'assistant') throw invalid('图片仅支持输入消息');
        const url = b.type === 'image' ? b.source?.url ?? (b.source?.data ? `data:${b.source.media_type};base64,${b.source.data}` : undefined) : typeof b.image_url === 'string' ? b.image_url : b.image_url?.url;
        if (typeof url !== 'string' || !/^https:\/\//.test(url) && !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/.test(url)) throw invalid('图片需使用 HTTPS URL 或有效的 base64 data URL');
        const detail = b.detail ?? b.image_url?.detail;
        if (detail !== undefined && !['auto', 'low', 'high'].includes(detail)) throw invalid('图片 detail 无效');
        return { type: 'input_image', image_url: url, ...(detail ? { detail } : {}) };
      }
      throw invalid(`Grok 当前未开放 ${b.type || '未知'} 内容块，请使用文本或 Responses 原生推理项`);
    });
  };
  if (p === 'responses') {
    if (raw.instructions !== undefined) body.instructions = raw.instructions;
    body.input = typeof raw.input === 'string' ? [{ role: 'user', content: parts(raw.input, 'user') }] : raw.input.map(item => {
      if (item.type === 'reasoning') return item; // Opaque native reasoning must survive round trips.
      if (item.type === 'function_call' || item.type === 'function_call_output') return item;
      if (item.type && item.type !== 'message') throw invalid(`Grok 不支持 input.${item.type}`);
      if (!['user', 'assistant', 'system', 'developer'].includes(item.role)) throw invalid('消息 role 无效');
      return { role: item.role, content: parts(item.content, item.role) };
    });
  } else if (p === 'chat') {
    body.input = raw.messages.flatMap(m => {
      if (m.role === 'tool') return [{ type: 'function_call_output', call_id: m.tool_call_id, output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }];
      if (!['user', 'assistant', 'system', 'developer'].includes(m.role)) throw invalid('消息 role 无效');
      const c = parts(m.content, m.role), result = c.length ? [{ role: m.role, content: c }] : [];
      for (const call of m.tool_calls || []) result.push({ type: 'function_call', call_id: call.id, name: call.function?.name, arguments: call.function?.arguments });
      return result;
    });
  } else {
    if (raw.system) body.input.push({ role: 'system', content: parts(raw.system, 'system') });
    for (const m of raw.messages) {
      if (!['user', 'assistant'].includes(m.role)) throw invalid('消息 role 无效');
      if (typeof m.content === 'string') { body.input.push({ role: m.role, content: parts(m.content, m.role) }); continue; }
      for (const b of m.content) {
        if (b.cache_control) throw invalid('Grok 不支持 cache_control');
        if (b.type === 'tool_use') body.input.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) });
        else if (b.type === 'tool_result') {
          if (Array.isArray(b.content) && b.content.some(x => x.type !== 'text')) throw invalid('工具结果仅支持文本');
          body.input.push({ type: 'function_call_output', call_id: b.tool_use_id, output: typeof b.content === 'string' ? b.content : (b.content || []).map(x => x.text).join('\n') });
        } else if (b.type === 'thinking' && !b.signature) { /* Informational summary, not a native Grok reasoning item. */ }
        else body.input.push({ role: m.role, content: parts([b], m.role) });
      }
    }
  }
  if (!body.input.length) throw invalid('需要非空消息');
  const calls = new Set();
  for (const item of body.input) {
    if (item.type === 'function_call') {
      if (!item.call_id || !item.name || typeof item.arguments !== 'string') throw invalid('工具调用格式无效');
      try { JSON.parse(item.arguments); } catch { throw invalid('工具参数必须是 JSON'); }
      calls.add(item.call_id);
    }
    if (item.type === 'function_call_output' && !calls.has(item.call_id)) throw invalid('工具结果缺少对应的 function_call');
  }
  if (raw.tools) body.tools = raw.tools.map(t => {
    if (p === 'responses' && ['web_search', 'x_search'].includes(t.type)) return t;
    const f = p === 'chat' ? t.function : t;
    if ((p !== 'messages' && t.type !== 'function') || (p === 'messages' && t.type && t.type !== 'custom') || !f?.name) throw invalid('当前只开放 function 工具');
    if (t.cache_control) throw invalid('Grok 不支持工具 cache_control');
    return { type: 'function', name: f.name, description: f.description, parameters: f.parameters ?? f.input_schema ?? { type: 'object', properties: {} }, ...(f.strict !== undefined ? { strict: f.strict } : {}) };
  });
  if (raw.tool_choice !== undefined) {
    const c = raw.tool_choice;
    if (typeof c === 'string') body.tool_choice = c;
    else if (c?.type === 'function' || c?.type === 'tool') body.tool_choice = { type: 'function', name: c.function?.name ?? c.name };
    else if (['auto', 'any', 'none'].includes(c?.type)) body.tool_choice = c.type === 'any' ? 'required' : c.type;
    else throw invalid('tool_choice 无效');
    if (c?.disable_parallel_tool_use !== undefined) body.parallel_tool_calls = !c.disable_parallel_tool_use;
    if (typeof body.tool_choice === 'string' && !['auto', 'none', 'required'].includes(body.tool_choice)) throw invalid('tool_choice 无效');
    if (body.tool_choice === 'required' && !body.tools?.length || typeof body.tool_choice === 'object' && !body.tools?.some(t => t.name === body.tool_choice.name)) throw invalid('tool_choice 需要有效工具');
  }
  if (raw.response_format) {
    const f = raw.response_format;
    body.text = { format: f.type === 'json_schema' ? { type: f.type, ...f.json_schema } : f };
  } else if (raw.text) body.text = raw.text;
  return body;
}

const count = n => Number.isFinite(n) && n >= 0 ? n : undefined;
export function parseUsage(u) {
  if (!u) return undefined;
  return { inputTokens: count(u.input_tokens), outputTokens: count(u.output_tokens), totalTokens: count(u.total_tokens), cacheReadTokens: count(u.input_tokens_details?.cached_tokens),
    outputDetails: u.output_tokens_details?.reasoning_tokens === undefined ? undefined : { reasoning_tokens: count(u.output_tokens_details.reasoning_tokens) },
    costUsdTicks: count(u.cost_in_usd_ticks) };
}
export async function* decodeStream(response, model, signal, idleTimeoutMs = 300000, observe = () => {}) {
  const reader = response.body.getReader(), decoder = new TextDecoder(), parser = new SseParser();
  let finished = false; const calls = new Map();
  try {
    for (;;) {
      signal?.throwIfAborted();
      let timer;
      const chunk = await Promise.race([
        reader.read(),
        new Promise((_, reject) => { timer = setTimeout(() => { reject(Object.assign(new Error('Grok 流式响应空闲超时'), {code:'idle_timeout'})); void reader.cancel().catch(() => {}); }, idleTimeoutMs); }),
      ]).finally(() => clearTimeout(timer));
      const frames = chunk.done ? [...parser.push(decoder.decode()), ...parser.flush()] : parser.push(decoder.decode(chunk.value, { stream: true }));
      if (parser.buffer.length > 4_000_000) throw new Error('oversized frame');
      for (const frame of frames) {
        if (!frame.data || frame.data === '[DONE]') continue;
        const e = JSON.parse(frame.data);
        if (e.type === 'error' || e.type === 'response.failed' || e.response?.error) { yield { type: 'error', code: 'upstream_error', message: 'Grok 推理失败，请检查额度与请求参数' }; return; }
        observe({reportedModel:e.response?.model,actualTier:e.response?.service_tier});
        if (e.response) e.response.model = model;
        yield { type: 'native_response', event: e };
        if (e.type === 'response.output_text.delta') yield { type: 'text', delta: e.delta };
        if (e.type === 'response.reasoning_summary_text.delta') yield { type: 'reasoning', delta: e.delta };
        if (e.type === 'response.output_item.added' && e.item.type === 'function_call') {
          calls.set(e.output_index, { streamed: !!e.item.arguments });
          yield { type: 'tool_call', index: e.output_index, id: e.item.call_id, name: e.item.name, argumentsDelta: e.item.arguments || '' };
        }
        if (e.type === 'response.function_call_arguments.delta') {
          if (!calls.has(e.output_index)) throw new Error('tool delta before start');
          calls.get(e.output_index).streamed = true;
          yield { type: 'tool_call', index: e.output_index, argumentsDelta: e.delta };
        }
        if (e.type === 'response.output_item.done' && e.item.type === 'function_call' && !calls.get(e.output_index)?.streamed) {
          calls.set(e.output_index, { streamed: true });
          yield { type: 'tool_call', index: e.output_index, id: e.item.call_id, name: e.item.name, argumentsDelta: e.item.arguments || '' };
        }
        if (['response.completed', 'response.incomplete'].includes(e.type)) {
          finished = true;
          if (e.response?.usage) yield { type: 'usage', usage: parseUsage(e.response.usage) };
          yield { type: 'finish', reason: e.type === 'response.incomplete' ? 'length' : calls.size ? 'tool_calls' : 'stop' };
        }
      }
      if (finished || chunk.done) break;
    }
    if (!finished) yield { type: 'error', code: 'incomplete_stream', message: 'Grok 上游连接提前结束' };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function* renderNativeStream(events) {
  for await (const e of events) {
    if (e.type === 'native_response') yield `event: ${e.event.type}\ndata: ${JSON.stringify(e.event)}\n\n`;
    if (e.type === 'error') { yield `event: error\ndata: ${JSON.stringify({ type: 'error', code: e.code, message: e.message })}\n\n`; return; }
  }
}
export async function renderNativeResponse(events) {
  let response;
  for await (const e of events) {
    if (e.type === 'error') throw new LLMError(e.message, e.code);
    if (e.type === 'native_response' && ['response.completed', 'response.incomplete'].includes(e.event.type)) response = e.event.response;
  }
  if (!response) throw new LLMError('Grok 未返回完整响应', 'incomplete_stream');
  return response;
}
