// Pi 1.4 exposes provider_stream_event before Responses normalization. Its
// message_start shallow copy shares the adapter's live usage object, so updating
// that object makes counters available before text/thinking/tool delta handlers.
// Final Responses usage is still assigned by Pi's built-in adapter.
export default function daylightStreamingUsage(pi) {
  let target, latest;
  const apply = () => {
    if (!target || !latest) return;
    const valid = value => Number.isFinite(value) && value >= 0;
    if (valid(latest.output_tokens)) target.output = latest.output_tokens;
    const cached = latest.input_tokens_details?.cached_tokens;
    const written = latest.input_tokens_details?.cache_write_tokens;
    if (valid(cached)) target.cacheRead = cached;
    if (valid(written)) target.cacheWrite = written;
    if (valid(latest.input_tokens)) target.input = Math.max(0, latest.input_tokens - (target.cacheRead || 0) - (target.cacheWrite || 0));
    if (valid(latest.output_tokens_details?.reasoning_tokens)) target.reasoning = latest.output_tokens_details.reasoning_tokens;
    target.totalTokens = valid(latest.total_tokens) ? latest.total_tokens : (target.input || 0) + (target.output || 0) + (target.cacheRead || 0) + (target.cacheWrite || 0);
    if (latest.estimated) target.estimated = true;
    else delete target.estimated;
  };
  pi.on('before_provider_request', () => { target = undefined; latest = undefined; });
  pi.on('message_start', event => {
    if (event.message?.role !== 'assistant') return;
    target = event.message.provider === 'daylight' && event.message.api === 'openai-responses' ? event.message.usage : undefined;
    apply();
  });
  pi.on('provider_stream_event', event => {
    if (event.provider !== 'daylight' || event.api !== 'openai-responses') return;
    // Terminal events are handled authoritatively by Pi, including zero counts.
    if (['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(event.data?.type)) return;
    const usage = event.data?.usage || event.data?.response?.usage;
    if (!usage || !Number.isFinite(usage.output_tokens) || usage.output_tokens < 0) return;
    latest = {...latest, ...usage, input_tokens_details:{...latest?.input_tokens_details, ...usage.input_tokens_details}, output_tokens_details:{...latest?.output_tokens_details, ...usage.output_tokens_details}};
    if (!usage.estimated) delete latest.estimated;
    apply();
  });
  pi.on('message_end', event => {
    if (event.message?.role === 'assistant') { target = undefined; latest = undefined; }
  });
  pi.on('session_shutdown', () => { target = undefined; latest = undefined; });
}
