import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter } from '../proxy/shared/router.js';
import { createProxyService } from '../proxy/service.js';
import { CustomSources } from '../proxy/custom/provider.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

const model = { id: 'shared', enabled: true, contextWindow: 1000 };
const deferred = () => Promise.withResolvers();
const provider = () => ({ calls: 0, cache: { at: Date.now() }, async listModels() { this.calls++; return [{ ...model }]; } });

test('cached catalog reads never rediscover known sources, including expired caches; local settings/routes republish without upstream I/O', async () => {
  const a = provider(), b = provider(), router = new ModelRouter({ a, b });
  await router.listModels();
  router.discoveredAt = 0;
  for (let i = 0; i < 5; i++) assert.equal((await router.cachedModels())[0].contextWindow, 1000);
  assert.deepEqual([a.calls, b.calls], [1, 1]);
  router.setCatalog('a', [{ ...model, contextWindow: 500 }]);
  assert.equal((await router.cachedModels())[0].contextWindow, 500);
  await router.saveRoute({ id: 'shared', order: ['b', 'a'], excluded: ['a'] });
  assert.equal((await router.cachedModels())[0].provider, 'b');
  assert.equal((await router.cachedModels())[0].contextWindow, 1000);
  assert.deepEqual([a.calls, b.calls], [1, 1]);
  router.invalidateSource('b');
  await router.cachedModels();
  assert.deepEqual([a.calls, b.calls], [1, 2]);
});

test('discovery completion order cannot change the default route priority', async () => {
  const gate = deferred(), router = new ModelRouter({ a: { async listModels() { await gate.promise; return [model]; } }, b: provider() });
  const reading = router.cachedModels();
  await router.refreshSource('b'); gate.resolve();
  assert.equal((await reading)[0].provider, 'a');
  assert.deepEqual(router.preferences.shared.order, ['a', 'b']);
});

test('concurrent forced refreshes and cold reads share one discovery per source', async () => {
  const gate = deferred(), started = deferred(); let calls = 0;
  const router = new ModelRouter({ a: { async listModels(force) { calls++; assert.equal(force, true); started.resolve(); await gate.promise; return [model]; } } });
  const requests = [router.listModels(true), router.listModels(true), router.cachedModels()];
  await started.promise; assert.equal(calls, 1);
  gate.resolve();
  assert((await Promise.all(requests)).every(models => models[0].id === 'shared'));
  assert.equal(calls, 1);
});

test('warm reads do not wait for a slow upstream refresh; stale discovery cannot overwrite a newer local setting', async () => {
  const a = provider(), router = new ModelRouter({ a }); await router.cachedModels();
  const gate = deferred(), started = deferred();
  a.listModels = async () => { started.resolve(); await gate.promise; return [{ ...model, contextWindow: 1000 }]; };
  const refreshing = router.listModels(true); await started.promise;
  // This must finish before resolving the remote request, not merely beat a timeout.
  assert.equal((await router.cachedModels())[0].contextWindow, 1000);
  router.setCatalog('a', [{ ...model, contextWindow: 2000 }]);
  assert.equal((await router.cachedModels())[0].contextWindow, 2000);
  gate.resolve(); await refreshing;
  assert.equal((await router.cachedModels())[0].contextWindow, 2000);
});

test('partial refresh failures retain last-known-good catalogs and the completeness error, without implicit retries on reads', async () => {
  const a = provider(), b = provider(), router = new ModelRouter({ a, b }); await router.cachedModels();
  b.listModels = async () => { b.calls++; throw new Error('offline'); };
  await router.listModels(true);
  assert.equal(router.catalogs.get('b')[0].id, 'shared'); assert(router.errors.b);
  for (let i = 0; i < 5; i++) assert.equal((await router.cachedModels())[0].provider, 'a');
  assert.equal(b.calls, 2); assert(router.errors.b);
});

test('proxy page model/settings/custom-source changes reach Pi through the shared catalog without unrelated rediscovery', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'daylight-catalog-'));
  const qoder = provider(), agy = provider(); let agyModels = [{ ...model, id: 'agy-model' }];
  agy.listModels = async () => { agy.calls++; return agyModels; };
  agy.setModel = async () => (agyModels = [{ ...agyModels[0], contextWindow: 2000 }]);
  const custom = new CustomSources({ dataDir, secrets: { delete: async () => {} }, fetchImpl: async () => { assert.fail('custom save must not discover remotely'); } });
  const bridge = await createProxyService({ dataDir, provider: qoder, agyProvider: agy, customSources: custom, piOptions: { piDir: path.join(dataDir, 'pi'), getInfo: async () => ({ installed: true, version: 'test' }) } });
  const server = http.createServer((req, res) => bridge.handle(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await bridge.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (route, body) => {
    const res = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await res.json(); assert.equal(res.status, 200, JSON.stringify(result)); return result;
  };
  await call('/api/qoder/models'); await call('/api/agy/models');
  const initial = await call('/api/cli/pi/state');
  for (let i = 0; i < 3; i++) assert.equal((await call('/api/cli/pi/state')).version, initial.version);
  assert.deepEqual([qoder.calls, agy.calls], [1, 1]);
  await call('/api/agy/models/setting', { id: 'agy-model', field: 'context', value: 2000 });
  const changed = await call('/api/cli/pi/state');
  assert.notEqual(changed.version, initial.version); assert.equal(changed.models.find(m => m.id === 'agy-model').contextWindow, 2000);
  const input = { name: 'Local', baseUrl: 'https://example.invalid/v1', protocol: 'chat', auth: 'none', models: [{ id: 'custom-model', enabled: true }] };
  const { source } = await call('/api/custom-proxy/save', input);
  assert((await call('/api/cli/pi/state')).models.some(m => m.id === 'custom-model'));
  await call('/api/custom-proxy/save', { ...input, id: source.id, enabled: false });
  assert(!(await call('/api/cli/pi/state')).models.some(m => m.id === 'custom-model'));
  await call('/api/custom-proxy/save', { ...input, id: source.id });
  assert((await call('/api/cli/pi/state')).models.some(m => m.id === 'custom-model'));
  await call('/api/custom-proxy/delete', { id: source.id });
  assert(!(await call('/api/cli/pi/state')).models.some(m => m.id === 'custom-model'));
  assert.deepEqual([qoder.calls, agy.calls], [1, 1]);
});

test('catalog updates arriving while route preferences load cannot publish an older catalog', async () => {
  const a = provider(), router = new ModelRouter({ a });
  router.setCatalog('a', [model]);
  const gate = deferred(), started = deferred(), original = router.preferencesFor.bind(router); let first = true;
  router.preferencesFor = async groups => {
    if (first) { first = false; started.resolve(); await gate.promise; }
    return original(groups);
  };
  const reading = router.cachedModels(); await started.promise;
  router.setCatalog('a', [{ ...model, contextWindow: 2000 }]);
  gate.resolve();
  assert.equal((await reading)[0].contextWindow, 2000);
  assert.equal((await router.cachedModels())[0].contextWindow, 2000);
});
