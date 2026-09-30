import { parseModelRef } from './models.js';

export class ModelRouter {
  constructor(providers, { cacheRoutesMs = 0, onCatalog = () => {} } = {}) { this.providers = providers; this.onCatalog = onCatalog; this.cacheRoutesMs = cacheRoutesMs; this.errors = {}; this.conflicts = []; this.available = new Set(); this.catalogs = new Map(); this.failedAt = new Map(); }
  async listModels(force = false) {
    const entries = Object.entries(this.providers);
    const results = await Promise.allSettled(entries.map(([source, p]) => !force && Date.now() - (this.failedAt.get(source) || 0) < 30000 ? Promise.reject(Object.assign(new Error('Source unavailable'), { backoff: true })) : p.listModels(force)));
    const all = []; this.available.clear();
    results.forEach((result, i) => {
      const [source, provider] = entries[i];
      if (!result.reason?.backoff) this.onCatalog(source, result.value, result.reason, provider);
      if (result.status === 'fulfilled') { delete this.errors[source]; this.failedAt.delete(source); this.available.add(source); this.catalogs.set(source, result.value); all.push(...result.value.map(m => ({ ...m, provider: source }))); }
      else { if (!this.failedAt.has(source) || Date.now() - this.failedAt.get(source) >= 30000) this.failedAt.set(source, Date.now()); this.errors[source] = `${{ qoder: 'Qoder', agy: 'AGY', grok: 'Grok' }[source] || source} 不可用，请检查登录状态与网络`; }
    });
    if (!this.available.size) throw new Error('没有可用模型来源，请检查账号与网络');
    const counts = new Map();
    for (const m of [...this.catalogs.values()].flat().filter(m => m.enabled)) counts.set(m.id, (counts.get(m.id) || 0) + 1);
    this.conflicts = [...counts].filter(([, n]) => n > 1).map(([id]) => id);
    this.routeModels = all.filter(m => !this.conflicts.includes(m.id)); this.discoveredAt = Date.now();
    return this.routeModels;
  }
  async resolve(request) {
    // Known routes need only their own provider's readiness check. An unavailable
    // unrelated provider must not add its discovery timeout to every inference.
    const cached = this.routeModels?.some(m => m.id === request.model || m.provider === 'qoder' && m.id === parseModelRef(request.model).id);
    const models = cached && Date.now() - this.discoveredAt < this.cacheRoutesMs ? this.routeModels : await this.listModels();
    const id = parseModelRef(request.model).id;
    if (this.conflicts.includes(request.model) || this.conflicts.includes(id)) throw Object.assign(new Error('模型名称冲突，请停用其中一个或设置别名'), {code:'invalid_request',status:400});
    const model = models.find(m => m.enabled && (m.id === request.model || m.provider === 'qoder' && m.id === id));
    if (!model) throw Object.assign(new Error('模型不存在、已停用或来源不可用'), {code:'model_not_found',status:400});
    return model;
  }
  async *stream(request, options) {
    let model;try { model=await this.resolve(request); } catch(e) { yield {type:'error',code:e.code||'upstream_error',message:e.message};return; }
    options?.onRoute?.(model.provider);
    yield* this.providers[model.provider].stream(request, options);
  }
}
