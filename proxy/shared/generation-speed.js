import {StreamingUsage} from './llm/streaming-usage.js';

// Only numeric measurements survive the request. Never retain generated text.
export class GenerationSpeed {
  constructor(now, calibration) {
    this.now = now;
    this.counter = new StreamingUsage({calibration});
    this.chunks = 0;
    this.usageChunks = -1;
  }
  event(event) {
    const text = ['text','reasoning'].includes(event.type) ? event.delta : event.type === 'tool_call' ? event.argumentsDelta : undefined;
    if (typeof text !== 'string' || !text.length) return;
    const at = this.now();
    this.counter.add(text);
    if (!this.chunks++) { this.first = at; this.firstWeight = this.counter.weight; }
    this.last = at;
  }
  finish(row, upstreamStarted, finished) {
    if (row.origin === 'test' || row.error || !['completed','truncated'].includes(row.outcome) || row.status < 200 || row.status >= 300) return;
    const actual = row.usage?.outputTokens, estimated = !Number.isFinite(actual) || this.usageChunks < this.chunks;
    const tokens = estimated ? Math.ceil(this.counter.weight * this.counter.factor) : actual;
    if (!(tokens >= 20)) return;
    // Hidden reasoning belongs to output_tokens but precedes the visible stream.
    // For it (and JSON responses), only the upstream request window is observable.
    const requestWindow = row.usage?.outputDetails?.reasoning_tokens > 0 || !this.chunks;
    if (estimated && row.usage?.outputDetails?.reasoning_tokens > 0) return;
    const durationMs = requestWindow ? (this.ended ?? finished) - upstreamStarted : this.last - this.first;
    if (!Number.isFinite(durationMs) || durationMs < 250 || !requestWindow && this.chunks < 2) return;
    // SSE chunks contain multiple tokens. Exclude the first chunk proportionally
    // instead of pretending a network chunk is one token.
    const measuredTokens = requestWindow ? tokens : tokens * (1 - this.firstWeight / this.counter.weight);
    if (!(measuredTokens > 0)) return;
    return {tokensPerSecond:measuredTokens * 1000 / durationMs, outputTokens:tokens, durationMs,
      estimated, timing:requestWindow?'upstream':'stream'};
  }
}

const median = values => { if (!values.length) return undefined; const sorted = values.toSorted((a,b)=>a-b), half = Math.floor(sorted.length/2); return sorted.length%2 ? sorted[half] : (sorted[half-1]+sorted[half])/2; };

export function summarizeSpeeds(rows, source, revision) {
  const groups = new Map();
  for (const row of rows) {
    const speed = row.generationSpeed;
    if (row.provider !== source || row.sourceRevision !== revision || row.origin === 'test' || row.error || !['completed','truncated'].includes(row.outcome) || !speed || !Number.isFinite(speed.tokensPerSecond) || speed.tokensPerSecond <= 0) continue;
    const upstreamModel = row.upstreamModel || row.model, model = row.sourceModel || upstreamModel, effort = row.effort || 'auto', tier = row.actualTier || row.requestedTier || 'auto';
    const key = JSON.stringify([model,upstreamModel,effort,tier,speed.estimated,speed.timing]);
    let group = groups.get(key);
    if (!group) { group = {model,upstreamModel,effort,tier,estimated:speed.estimated,timing:speed.timing,samples:[]}; groups.set(key,group); }
    group.samples.push(row); group.samples = group.samples.slice(-20);
  }
  return [...groups.values()].map(({samples,...group})=>({...group,samples:samples.length,
    tokensPerSecond:median(samples.map(row=>row.generationSpeed.tokensPerSecond)),
    lastTokensPerSecond:samples.at(-1).generationSpeed.tokensPerSecond,
    firstContentMs:median(samples.filter(row=>Number.isFinite(row.firstContentMs)).map(row=>row.firstContentMs)),
    updatedAt:samples.at(-1).completedAt || samples.at(-1).time,
  })).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
}
