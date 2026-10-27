import {mergeUsage} from './usage.js';

// Display-only estimates. Never feed them into the assembler or request records.
// Count visible text, reasoning summaries and tool arguments; hidden reasoning,
// images and prompt serialization cannot be inferred from output deltas.
export class StreamingUsage {
  weight = 0;
  baseline = 0;
  usage;
  reasoningVisible = false;
  constructor({calibration} = {}) {
    this.calibration = calibration;
    this.factor = calibration?.factor ?? 1;
  }
  add(text) {
    for (const char of text || '') {
      if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)) this.weight += 1;
      else if (char.length === 2) this.weight += 1;
      else if (/[\uD800-\uDFFF]/.test(char)) this.weight += 0.5;
      else this.weight += Buffer.byteLength(char) / 4;
    }
  }
  observe(usage) {
    this.usage = mergeUsage(this.usage, usage);
    if (this.usage && !usage?.estimated) delete this.usage.estimated;
    if (Number.isFinite(usage?.outputTokens)) this.baseline = this.weight;
  }
  snapshot() {
    const extra = Math.ceil((this.weight - this.baseline) * this.factor);
    const outputTokens = (this.usage?.outputTokens ?? 0) + extra;
    if (!outputTokens && !this.usage) return undefined;
    const estimated = extra > 0 || this.usage?.outputTokens === undefined;
    return {...this.usage, outputTokens,
      totalTokens: estimated ? (this.usage?.inputTokens === undefined ? undefined : this.usage.inputTokens + outputTokens) : this.usage.totalTokens,
      ...(estimated ? {estimated: true} : {})};
  }
  async complete(finish) {
    if (!['stop','tool_calls'].includes(finish) || !Number.isFinite(this.usage?.outputTokens) || this.usage.estimated || this.baseline !== this.weight || this.missingFinalUsage) return;
    try { await this.calibration?.observe({estimated:this.weight,actual:this.usage.outputTokens,reasoningVisible:this.reasoningVisible,reasoningTokens:this.usage.outputDetails?.reasoning_tokens}); }
    catch { /* Display calibration must not fail a completed response. */ }
  }
}

export async function* withStreamingUsage(events, options) {
  const counter = new StreamingUsage(options);
  let finish, failed = false;
  for await (const event of events) {
    if (['native','native_response'].includes(event.type) && ['response.completed','response.incomplete'].includes(event.event?.type) && !Number.isFinite(event.event.response?.usage?.output_tokens)) counter.missingFinalUsage = true;
    if (event.type === 'usage') counter.observe(event.usage);
    if (event.type === 'reasoning' && event.delta) counter.reasoningVisible = true;
    if (event.type === 'finish') finish = event.reason;
    if (event.type === 'error') failed = true;
    const text = event.type === 'text' || event.type === 'reasoning' ? event.delta : event.type === 'tool_call' ? event.argumentsDelta : undefined;
    if (event.type === 'text' || event.type === 'reasoning' || event.type === 'tool_call') {
      if (text) counter.add(text);
      yield {...event, streamUsage: counter.snapshot()};
    } else yield event;
  }
  if (!failed) await counter.complete(finish);
}

// Native wire events keep their identity and opaque payloads. usage on delta
// events is a Daylight extension; terminal usage remains upstream-authoritative.
export function nativeStreamingUsage(event, protocol, counter, usage) {
  if (protocol === 'chat' && event.choices?.some(c => c.delta?.reasoning_content || c.delta?.reasoning) || protocol === 'responses' && ['response.reasoning_text.delta','response.reasoning_summary_text.delta'].includes(event.type) && event.delta) counter.reasoningVisible = true;
  if (protocol === 'responses' && ['response.completed','response.incomplete'].includes(event.type)) counter.missingFinalUsage = !Number.isFinite(usage?.outputTokens);
  const texts = protocol === 'chat'
    ? (event.choices || []).filter(c => c.index === undefined || c.index === 0).flatMap(c => [c.delta?.content, c.delta?.reasoning_content ?? c.delta?.reasoning, ...(c.delta?.tool_calls || []).map(t => t.function?.arguments)])
    : protocol === 'responses' && ['response.output_text.delta', 'response.refusal.delta', 'response.reasoning_text.delta', 'response.reasoning_summary_text.delta', 'response.function_call_arguments.delta', 'response.custom_tool_call_input.delta'].includes(event.type) ? [event.delta] : [];
  for (const text of texts) if (typeof text === 'string') counter.add(text);
  if (usage) counter.observe(usage);
  return texts.some(text => typeof text === 'string' && text.length) ? counter.snapshot() : undefined;
}
