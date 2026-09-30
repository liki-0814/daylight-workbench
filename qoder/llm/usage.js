// Canonical inputTokens includes cache reads/writes, as in OpenAI usage.
const count = value => Number.isFinite(value) && value >= 0 ? value : undefined;
const clean = value => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
const details = value => value && typeof value === 'object' ? clean(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, count(v)]))) : undefined;
export function mergeUsage(previous, next) {
  if (!next) return previous;
  const result = { ...previous, ...clean(next) };
  for (const key of ['inputDetails', 'outputDetails']) if (previous?.[key] || next[key]) result[key] = { ...previous?.[key], ...next[key] };
  if (result.cacheReadTokens !== undefined && result.inputTokens > 0) result.cacheHitRate = Math.min(1, result.cacheReadTokens / result.inputTokens);
  return result;
}
export function parseUsage(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  return mergeUsage(undefined, clean({
    inputTokens: count(raw.prompt_tokens), outputTokens: count(raw.completion_tokens), totalTokens: count(raw.total_tokens),
    cacheReadTokens: count(raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens ?? raw.prompt_cache_hit_tokens ?? raw.cached_tokens),
    cacheWriteTokens: count(raw.prompt_tokens_details?.cache_write_tokens ?? raw.cache_creation_input_tokens),
    inputDetails: details(raw.prompt_tokens_details), outputDetails: details(raw.completion_tokens_details),
  }));
}
export function chatUsage(u) {
  if (!u) return undefined;
  const input = clean({ ...u.inputDetails, cached_tokens: u.cacheReadTokens, cache_write_tokens: u.cacheWriteTokens });
  return clean({ prompt_tokens: u.inputTokens, completion_tokens: u.outputTokens, total_tokens: u.totalTokens ?? (u.inputTokens !== undefined && u.outputTokens !== undefined ? u.inputTokens + u.outputTokens : undefined),
    prompt_tokens_details: Object.keys(input).length ? input : undefined, completion_tokens_details: u.outputDetails,
    cost_in_usd_ticks: u.costUsdTicks });
}
export function responsesUsage(u) {
  const chat = chatUsage(u);
  return chat && clean({ input_tokens: chat.prompt_tokens, output_tokens: chat.completion_tokens, total_tokens: chat.total_tokens,
    input_tokens_details: chat.prompt_tokens_details, output_tokens_details: chat.completion_tokens_details, cost_in_usd_ticks: u.costUsdTicks });
}
export function messagesUsage(u) {
  if (!u) return {};
  return clean({ input_tokens: u.inputTokens === undefined ? undefined : Math.max(0, u.inputTokens - (u.cacheReadTokens ?? 0) - (u.cacheWriteTokens ?? 0)),
    output_tokens: u.outputTokens, cache_read_input_tokens: u.cacheReadTokens, cache_creation_input_tokens: u.cacheWriteTokens, cost_in_usd_ticks: u.costUsdTicks });
}
