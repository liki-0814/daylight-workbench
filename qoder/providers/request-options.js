// Preserve controls for providers that support them; Qoder keeps its existing contract.
export function additionalOptions(req, protocol) {
  const options = {
    thinking: req.thinking,
    temperature: req.temperature,
    topP: req.top_p,
    topK: req.top_k,
    stop: protocol === 'messages' ? req.stop_sequences : req.stop,
    toolChoice: req.tool_choice,
    protocol,
  };
  const unsupported = [];
  function inspect(value) {
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'cache_control')) unsupported.push('cache_control');
    if (value.type === 'redacted_thinking') unsupported.push('redacted_thinking');
    for (const [key, child] of Object.entries(value)) if (!['parameters', 'input_schema'].includes(key) && child && typeof child === 'object') inspect(child);
  }
  inspect(req);
  for (const key of ['context_length', 'response_format', 'text', 'seed', 'logprobs', 'top_logprobs', 'presence_penalty', 'frequency_penalty', 'logit_bias', 'parallel_tool_calls', 'prompt_cache_key', 'prompt_cache_retention', 'previous_response_id', 'truncation']) {
    if (req[key] !== undefined) unsupported.push(key);
  }
  if (req.n !== undefined && req.n !== 1) unsupported.push('n');
  if (req.output_config && Object.keys(req.output_config).some(k => k !== 'effort')) unsupported.push('output_config');
  if (req.tools?.some(t => protocol === 'messages' ? t.type !== undefined && t.type !== 'custom' : t.type !== 'function')) unsupported.push('非 function 工具');
  options.unsupported = [...new Set(unsupported)];
  return options;
}
