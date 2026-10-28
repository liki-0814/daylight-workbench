import path from 'node:path';
import {UsageHistory} from './usage-history.js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readJson, writeJson, serial } from './store.js';
import { mergeUsage } from './llm/usage.js';
import { diagnosticError, protocolFor } from './contracts.js';
import {GenerationSpeed,summarizeSpeeds} from './generation-speed.js';

// Select fields here rather than persisting event payloads from five protocols.
const metadata = ['origin', 'provider', 'model', 'sourceModel', 'streaming', 'sourceRevision', 'upstreamModel', 'reportedModel', 'upstreamProtocol', 'execution', 'effort', 'requestedTier', 'actualTier', 'upstreamStatus', 'retries', 'keyId', 'requestedTemperature', 'effectiveTemperature', 'promptCacheTtl', 'promptCacheReason'];
const counters = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsdTicks'];
const count = n => Number.isFinite(n) && n >= 0;
const detailCounters = ['cached_tokens', 'cache_write_tokens', 'audio_tokens', 'reasoning_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens'];

/** One trace per authenticated inference request; observe never changes execution. */
export class RequestTrace {
  constructor(endpoint, {now = () => performance.now()} = {}) {
    this.now = now;
    this.started = now();
    this.stageStarted = this.started;
    this.stage = 'validation';
    this.entry = { schemaVersion: 2, id: randomUUID(), time: new Date().toISOString(), endpoint, protocol: protocolFor(endpoint), retries: 0, stages: {} };
    this.generation = new GenerationSpeed(now);
  }
  startGeneration(info) {
    this.generation = new GenerationSpeed(this.now);
    this.upstreamStarted = this.now();
    for (const key of ['usage','firstContentMs','reportedModel','actualTier','requestedTier','effort','promptCacheTtl','promptCacheReason']) delete this.entry[key];
    this.observe(info);
  }
  observe(info) {
    const row = this.entry;
    if (info.stage === 'upstream') this.upstreamStarted = this.now();
    if (info.routeFailure) { (row.routeAttempts ||= []).push({provider:info.provider,...diagnosticError(info.routeFailure)}); row.routeAttempts=row.routeAttempts.slice(-50); }
    if (info.stage && info.stage !== this.stage) {
      row.stages[this.stage] = (row.stages[this.stage] || 0) + this.now() - this.stageStarted;
      this.stage = info.stage; this.stageStarted = this.now();
    }
    if (info.provider && row.provider && info.provider !== row.provider) { delete row.keyId; delete row.error; delete row.outcome; delete row.requestedTemperature; delete row.effectiveTemperature;delete row.upstreamErrorStatus;delete row.upstreamErrorCode; }
    for (const key of metadata) if (['string', 'number', 'boolean'].includes(typeof info[key])) row[key] = info[key];
    if(Number.isInteger(info.upstreamErrorStatus)&&info.upstreamErrorStatus>=400&&info.upstreamErrorStatus<600)row.upstreamErrorStatus=info.upstreamErrorStatus;
    if(typeof info.upstreamErrorCode==='string'&&/^[a-zA-Z0-9_.-]{1,80}$/.test(info.upstreamErrorCode))row.upstreamErrorCode=info.upstreamErrorCode;
    if (info.usage && !info.usage.estimated) {
      if (count(info.usage.outputTokens)) this.generation.usageChunks = this.generation.chunks;
      const usage = Object.fromEntries(counters.filter(key => count(info.usage[key])).map(key => [key, info.usage[key]]));
      for (const key of ['inputDetails', 'outputDetails']) if (info.usage[key]) usage[key] = Object.fromEntries(detailCounters.filter(name => count(info.usage[key][name])).map(name => [name, info.usage[key][name]]));
      row.usage = mergeUsage(row.usage, usage);
    }
    if (info.content && row.firstContentMs === undefined) row.firstContentMs = this.now() - this.started;
    if (info.toolCall) row.toolCallObserved = true;
    if (info.finish && !row.error) { row.outcome = info.finish === 'length' ? 'truncated' : 'completed'; this.generation.ended = this.now(); }
    if (info.error) this.fail(info.error);
  }
  event(event) {
    this.generation.event(event);
    if (event.type === 'usage') this.observe({ usage: event.usage });
    if (event.retries !== undefined) this.entry.retries = Math.max(this.entry.retries || 0, event.retries);
    if (['text', 'reasoning', 'tool_call'].includes(event.type)) this.observe({ content: !!(event.delta || event.name || event.argumentsDelta), toolCall: event.type === 'tool_call' });
    if (event.type === 'finish') this.observe({ finish: event.reason });
    if (event.type === 'error') { this.observe({upstreamErrorStatus:event.upstreamErrorStatus,upstreamErrorCode:event.upstreamErrorCode});this.fail({ code: event.code }); this.entry.upstreamCode = this.entry.error.code; }
  }
  fail(error, outcome = 'failed') {
    this.entry.outcome = outcome;
    this.entry.error ||= { stage: this.stage, ...diagnosticError(error) };
    if (this.entry.error.category === 'timeout') this.entry.outcome = 'timeout';
  }
  finish(status, httpStatus) {
    const row = this.entry;
    row.stages[this.stage] = (row.stages[this.stage] || 0) + this.now() - this.stageStarted;
    row.completedAt = new Date().toISOString();
    row.durationMs = this.now() - this.started;
    row.status = status; row.httpStatus = httpStatus;
    row.provider ||= 'unresolved';
    row.outcome ||= 'unknown';
    const speed = this.generation.finish(row, this.upstreamStarted, this.now());
    if (speed) row.generationSpeed = speed;
    return row;
  }
}

export class RequestRecords {
  constructor(file, rows) { this.file = file; this.rows = rows.slice(-1000); this.write = serial(); this.error = ''; }
  static async load(file) {
    const rows = await readJson(file, []);
    if (!Array.isArray(rows)) throw new Error('用量记录无效，原文件已保留');
    const records=new RequestRecords(file, rows);
    records.history=await UsageHistory.load(path.join(path.dirname(file),'usage-history.json'),rows);
    return records;
  }
  async append(row) {
    this.rows = [...this.rows, row].slice(-1000);
    const snapshot=this.rows;
    await this.write(async () => {
      try { await this.history?.append(row); await writeJson(this.file, snapshot); this.history?.checkpoint(snapshot); this.error = this.history?.error || ''; }
      catch { this.error = '请求记录保存失败，请检查数据目录权限'; }
    });
  }
  query({ source, model, outcome, limit = 100 } = {}) {
    const filtered = this.rows.filter(r => (!source || r.provider === source) && (!model || r.model === model) && (!outcome || r.outcome === outcome));
    return { records: filtered.slice(-limit).reverse(), retained: this.rows.length, matched: filtered.length, error: this.error };
  }
  setModelCatalog(source,models) {
    if(this.history?.setModelCatalog(source,models))void this.write(()=>this.history.flush());
  }
  statistics(query={}) { if(!this.history)throw Object.assign(Error('历史统计未启用'),{status:503});return this.history.report(query,this.rows); }
  speeds(source, revision) { return summarizeSpeeds(this.rows, source, revision); }
  frequencies(source, revision) {
    const models = new Map();
    for (const row of this.rows) {
      if (row.provider !== source || row.sourceRevision !== revision || row.origin === 'test') continue;
      const rawModel = row.sourceModel || row.upstreamModel || row.model;
      if (!rawModel) continue;
      const model=this.history?.canonicalModel(source,String(rawModel))||rawModel;
      models.set(model, (models.get(model) || 0) + 1);
    }
    return [...models].map(([model, requests]) => ({model, requests}));
  }
  legacy() {
    return { ...this.query(), today: this.rows.filter(row => new Date(row.time).toDateString() === new Date().toDateString()) };
  }
}
