import { createHash } from 'node:crypto';
import { diagnosticError } from './contracts.js';

const names = { qoder: 'Qoder', agy: 'AGY', grok: 'Grok', codex: 'Codex', kimi: 'Kimi' };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const modelFields = ['id', 'upstreamId', 'enabled', 'effort', 'fast', 'serviceTier', 'defaultMaxTokens', 'contextWindow'];
const unavailableCategories = ['authentication', 'rate_limit', 'network', 'timeout', 'interrupted', 'upstream'];

/** Catalog checks and successful requests are evidence, not capability promises. */
export class SourceState {
  constructor() { this.checks = new Map(); }
  checked(id, provider, models, error) {
    // A custom provider's listModels reads configuration, not its upstream.
    if (provider.source) return;
    const at = error ? Date.now() : provider.cache?.at || Date.now();
    this.checks.set(id, { at: new Date(at).toISOString(), models: models || this.checks.get(id)?.models || [], error: error && diagnosticError(error) });
  }
  discovered(source, models, error) {
    this.checks.set('custom:' + source.id, { at: new Date().toISOString(), models: models || [], error: error && diagnosticError(error) });
  }
  invalidate(id) { this.checks.delete(id); }
  revision(id, provider) {
    const source = provider.source;
    const models = this.checks.get(id)?.models;
    return hash(source || {
      id,
      identity: provider.identity ?? provider.auth?.identity ?? provider.cache?.identity ?? provider.cache?.id ?? provider.cache?.project,
      models: models?.map(m => Object.fromEntries(modelFields.filter(k => m[k] !== undefined).map(k => [k, m[k]]))),
    });
  }
  snapshot(providers, custom, records, conflicts, qoderConfigured) {
    const definitions = [
      ...Object.entries(providers).filter(([, p]) => !p.source).map(([id, provider]) => ({ id, name: names[id] || id, provider, enabled: true })),
      ...custom.map(source => ({ id: 'custom:' + source.id, name: source.name, provider: providers['custom:' + source.id] || { source }, enabled: source.enabled })),
    ];
    return definitions.map(({ id, name, provider, enabled }) => {
      const check = this.checks.get(id), revision = this.revision(id, provider);
      const configured = id === 'qoder' ? qoderConfigured : !provider.source || provider.source.auth === 'none' || provider.source.hasKey;
      const models = provider.source?.models || check?.models || [];
      const routableModels = models.filter(m => m.enabled !== false && !conflicts.includes(m.id)).length;
      const rows = records.filter(r => r.provider === id && r.sourceRevision === revision);
      const verified = rows.filter(r => ['completed', 'truncated'].includes(r.outcome));
      const last = rows.at(-1);
      const checkIsLatest = check && (!last || check.at >= (last.completedAt || last.time));
      const requestError = ['failed', 'timeout'].includes(last?.outcome) && unavailableCategories.includes(last.error?.category) ? last.error : undefined;
      const error = checkIsLatest ? check.error : requestError;
      let state = 'unchecked';
      if (check || verified.length) state = routableModels ? 'ready' : 'no_models';
      if (error) state = 'unavailable';
      if (!configured) state = 'unconfigured';
      if (!enabled) state = 'disabled';
      return {
        id, name, enabled, state, configured, routableModels, checkedAt: check?.at, error,
        verification: {
          generation: verified.at(-1)?.time,
          streaming: verified.findLast(r => r.streaming)?.time,
          toolCall: verified.findLast(r => r.toolCallObserved)?.time,
        },
        observations: verified.slice(-10).map(r => ({ model: r.model, protocol: r.protocol, streaming: r.streaming, toolCall: r.toolCallObserved, time: r.time })),
      };
    });
  }
}
