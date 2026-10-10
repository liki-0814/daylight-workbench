import {validOutputBudget,validSampling} from '../shared/request-parameters.js';
const invalid = message => Object.assign(new Error(message), { status: 400, code: 'invalid_request' });
export function reasoningEfforts(model) {
  if (model.effortRoutes) return model.reasoningEfforts;
  return model.isReasoning && (model.id.startsWith('claude-') || (model.catalogId || model.upstreamId)?.endsWith('-tiered')) ? ['low', 'medium', 'high'] : [];
}
export function generationConfig(request, model = {}) {
  const o = request.options || {};
  if (o.unsupported?.length) throw invalid(`AGY 暂不支持：${o.unsupported.join('、')}`);
  if (o.contextLength !== undefined) throw invalid('AGY 暂不支持覆盖上下文长度');
  const c = { maxOutputTokens: o.maxTokens ?? 8192 };
  if (!validOutputBudget(c.maxOutputTokens,model.maxOutputTokens)) throw invalid('max_tokens 超出模型允许范围');
  for (const [key, value, max] of [['temperature', o.temperature, 2], ['topP', o.topP, 1]]) {
    if (value === undefined) continue;
    if (!validSampling(value,max)) throw invalid(`${key} 超出允许范围`);
    c[key] = value;
  }
  if (o.topK !== undefined) {
    if (!Number.isInteger(o.topK) || o.topK < 1) throw invalid('top_k 必须为正整数');
    c.topK = o.topK;
  }
  if (o.stop !== undefined) {
    const stop = typeof o.stop === 'string' ? [o.stop] : o.stop;
    if (!Array.isArray(stop) || stop.length > 5 || stop.some(s => typeof s !== 'string' || !s)) throw invalid('stop 必须为最多 5 个非空字符串');
    c.stopSequences = stop;
  }
  const t = o.thinking;
  if (t !== undefined && (!t || !['enabled', 'disabled', 'adaptive'].includes(t.type) || Object.keys(t).some(k => !['type', 'budget_tokens'].includes(k)))) throw invalid('不支持的 thinking 配置');
  const effort = o.reasoningEffort ?? ((!t && model.effort) || undefined);
  if (effort && effort !== 'none' && !reasoningEfforts(model).includes(effort)) throw invalid(`AGY 暂不支持该推理强度；可用档位为 ${reasoningEfforts(model).join('、') || '无'}`);
  if (t?.type === 'disabled' || effort === 'none') {
    if (t?.budget_tokens !== undefined || (t?.type === 'disabled' && effort && effort !== 'none') || (effort === 'none' && t && t.type !== 'disabled')) throw invalid('thinking 与推理强度冲突');
    if (!model.id?.startsWith('claude-')) throw invalid('该 AGY 模型暂不支持关闭思考');
    c.thinkingConfig = { includeThoughts: false, thinkingBudget: 0 };
  } else if (t?.type === 'enabled') {
    if (!model.id?.startsWith('claude-')) throw invalid('手动思考预算当前仅适配 Claude');
    if (effort) throw invalid('budget_tokens 不能与 effort 同时指定');
    if (!Number.isInteger(t.budget_tokens) || t.budget_tokens < 1024 || t.budget_tokens >= c.maxOutputTokens) throw invalid('budget_tokens 必须至少 1024 且小于 max_tokens');
    c.thinkingConfig = { includeThoughts: true, thinkingBudget: t.budget_tokens };
  } else {
    if (t?.budget_tokens !== undefined) throw invalid('adaptive 不接受 budget_tokens');
    if (t && !reasoningEfforts(model).length) throw invalid('该模型暂不支持 adaptive thinking');
    const level = effort || model.defaultEffort || ((model.catalogId || model.upstreamId)?.endsWith('-tiered') ? model.defaultEffort || model.id.split('-').at(-1) : t || model.id?.startsWith('claude-') && model.isReasoning ? 'high' : undefined);
    const route = model.effortRoutes?.[level];
    if (route && route.thinkingBudget !== -1 && !(route.catalogId || route.upstreamId).endsWith('-tiered')) {
      if (route.thinkingBudget !== undefined) {
        if (o.maxTokens === undefined && route.thinkingBudget >= c.maxOutputTokens) c.maxOutputTokens = Math.min(model.maxOutputTokens || Infinity, route.thinkingBudget + 8192);
        if (route.thinkingBudget >= c.maxOutputTokens) throw invalid('max_tokens 必须大于该档位的思考预算');
        c.thinkingConfig = { includeThoughts: true, thinkingBudget: route.thinkingBudget };
      }
    } else if (level) c.thinkingConfig = { includeThoughts: true, thinkingLevel: level.toUpperCase() };
  }
  return c;
}
export function toolConfig(request) {
  const choice = request.options?.toolChoice;
  if (choice === undefined) return undefined;
  const kind = typeof choice === 'string' ? choice : choice?.type;
  const modes = { auto: 'AUTO', none: 'NONE', required: 'ANY', any: 'ANY', function: 'ANY', tool: 'ANY' };
  if (!modes[kind]) throw invalid('不支持的 tool_choice');
  if (choice?.disable_parallel_tool_use !== undefined) throw invalid('AGY 暂不支持 disable_parallel_tool_use');
  const name = kind === 'function' ? choice.function?.name ?? choice.name : kind === 'tool' ? choice.name : undefined;
  if (['tool', 'function'].includes(kind) && !request.tools?.some(t => t.name === name)) throw invalid('tool_choice 指定的工具不存在');
  if (modes[kind] === 'ANY' && !request.tools?.length) throw invalid('tool_choice 需要 tools');
  return { functionCallingConfig: { mode: modes[kind], ...(name ? { allowedFunctionNames: [name] } : {}) } };
}
export function agyUsage(u) {
  const count = v => Number.isFinite(v) && v >= 0 ? v : undefined;
  const output = count(u.candidatesTokenCount), thought = count(u.thoughtsTokenCount);
  // Stream counters are snapshots. Missing fields must not reset earlier usage to zero.
  return Object.fromEntries(Object.entries({
    inputTokens: count(u.promptTokenCount),
    outputTokens: output === undefined ? undefined : output + (thought ?? 0),
    totalTokens: count(u.totalTokenCount),
    cacheReadTokens: count(u.cachedContentTokenCount),
    outputDetails: thought === undefined ? undefined : { reasoning_tokens: thought },
  }).filter(([,v]) => v !== undefined));
}

export function compileRequest(request, signatures = new Map(), model = {}) {
  const calls = new Map();
  const contents = request.messages.map(message => {
    const parts = [];
    if (message.role === 'assistant') for (const thought of message.thinkingBlocks || []) {
      if (!thought.signature) throw invalid('AGY 思考块回传需要原始 signature');
      parts.push({ text: thought.text, thought: true, thoughtSignature: thought.signature });
    }
    if (message.role === 'tool') {
      const call = calls.get(message.toolCallId);
      if (!call) throw invalid('工具结果缺少对应的 assistant tool_call');
      parts.push({ functionResponse: { id: message.toolCallId, name: call.name, response: { result: message.content } } });
    } else {
      for (const part of typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content || []) {
        if (part.type === 'text' && part.text) parts.push({ text: part.text });
        else if (part.type === 'image') {
          const match = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(part.url);
          if (!match) throw invalid('AGY 图片需使用 base64 data URL');
          parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
        }
      }
      for (const call of message.toolCalls || []) {
        calls.set(call.id, call);
        let args; try { args = JSON.parse(call.arguments || '{}'); } catch { throw invalid('工具参数必须是 JSON'); }
        const saved = signatures.get(call.id);
        if (saved && (saved.name !== call.name || saved.args !== JSON.stringify(args))) throw invalid('工具调用内容与原始签名不匹配');
        parts.push({ functionCall: { id: call.id, name: call.name, args }, ...(saved?.signature ? { thoughtSignature: saved.signature } : {}) });
      }
    }
    return { role: message.role === 'assistant' ? 'model' : 'user', parts };
  }).filter(message => message.parts.length);
  if (!contents.length) throw invalid('需要非空消息');
  const body = { contents, generationConfig: generationConfig(request, model) };
  if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };
  if (request.tools?.length) body.tools = [{ functionDeclarations: request.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
  const config = toolConfig(request);
  if (config) body.toolConfig = config;
  return body;
}
