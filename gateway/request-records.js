import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readJson, writeJson, serial } from '../qoder/store.js';
import { mergeUsage } from '../qoder/llm/usage.js';
import { diagnosticError, protocolFor } from './contracts.js';

// Select fields here rather than persisting event payloads from five protocols.
const metadata = ['origin', 'provider', 'model', 'streaming', 'sourceRevision', 'upstreamModel', 'reportedModel', 'upstreamProtocol', 'execution', 'requestedTier', 'actualTier', 'upstreamStatus', 'retries'];
const counters = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsdTicks'];
const count = n => Number.isFinite(n) && n >= 0;
const detailCounters = ['cached_tokens', 'cache_write_tokens', 'audio_tokens', 'reasoning_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens'];

/** One trace per authenticated inference request; observe never changes execution. */
export class RequestTrace {
  constructor(endpoint) {
    this.started = performance.now();
    this.stageStarted = this.started;
    this.stage = 'validation';
    this.entry = { schemaVersion: 2, id: randomUUID(), time: new Date().toISOString(), endpoint, protocol: protocolFor(endpoint), retries: 0, stages: {} };
  }
  observe(info) {
    const row = this.entry;
    if (info.stage && info.stage !== this.stage) {
      row.stages[this.stage] = (row.stages[this.stage] || 0) + performance.now() - this.stageStarted;
      this.stage = info.stage; this.stageStarted = performance.now();
    }
    for (const key of metadata) if (['string', 'number', 'boolean'].includes(typeof info[key])) row[key] = info[key];
    if (info.usage) {
      const usage = Object.fromEntries(counters.filter(key => count(info.usage[key])).map(key => [key, info.usage[key]]));
      for (const key of ['inputDetails', 'outputDetails']) if (info.usage[key]) usage[key] = Object.fromEntries(detailCounters.filter(name => count(info.usage[key][name])).map(name => [name, info.usage[key][name]]));
      row.usage = mergeUsage(row.usage, usage);
    }
    if (info.content && row.firstContentMs === undefined) row.firstContentMs = performance.now() - this.started;
    if (info.toolCall) row.toolCallObserved = true;
    if (info.finish && !row.error) row.outcome = info.finish === 'length' ? 'truncated' : 'completed';
    if (info.error) this.fail(info.error);
  }
  event(event) {
    if (event.type === 'usage') this.observe({ usage: event.usage });
    if (event.retries !== undefined) this.entry.retries = Math.max(this.entry.retries || 0, event.retries);
    if (['text', 'reasoning', 'tool_call'].includes(event.type)) this.observe({ content: !!(event.delta || event.name || event.argumentsDelta), toolCall: event.type === 'tool_call' });
    if (event.type === 'finish') this.observe({ finish: event.reason });
    if (event.type === 'error') { this.fail({ code: event.code }); this.entry.upstreamCode = this.entry.error.code; }
  }
  fail(error, outcome = 'failed') {
    this.entry.outcome = outcome;
    this.entry.error ||= { stage: this.stage, ...diagnosticError(error) };
    if (this.entry.error.category === 'timeout') this.entry.outcome = 'timeout';
  }
  finish(status, httpStatus) {
    const row = this.entry;
    row.stages[this.stage] = (row.stages[this.stage] || 0) + performance.now() - this.stageStarted;
    row.completedAt = new Date().toISOString();
    row.durationMs = performance.now() - this.started;
    row.status = status; row.httpStatus = httpStatus;
    row.provider ||= 'unresolved';
    row.outcome ||= 'unknown';
    return row;
  }
}

export class RequestRecords {
  constructor(file, rows) { this.file = file; this.rows = rows.slice(-1000); this.write = serial(); this.error = ''; }
  static async load(file) {
    const rows = await readJson(file, []);
    if (!Array.isArray(rows)) throw new Error('用量记录无效，原文件已保留');
    return new RequestRecords(file, rows);
  }
  async append(row) {
    this.rows = [...this.rows, row].slice(-1000);
    await this.write(async () => {
      try { await writeJson(this.file, this.rows); this.error = ''; }
      catch { this.error = '请求记录保存失败，请检查数据目录权限'; }
    });
  }
  query({ source, model, outcome, limit = 100 } = {}) {
    const filtered = this.rows.filter(r => (!source || r.provider === source) && (!model || r.model === model) && (!outcome || r.outcome === outcome));
    return { records: filtered.slice(-limit).reverse(), retained: this.rows.length, matched: filtered.length, error: this.error };
  }
  legacy() {
    return { ...this.query(), today: this.rows.filter(row => new Date(row.time).toDateString() === new Date().toDateString()) };
  }
}
