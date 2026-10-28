import test from 'node:test';
import { Readable } from 'node:stream';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgyProvider } from '../proxy/agy/provider.js';
import { CodexProvider } from '../proxy/codex/provider.js';
import { GrokProvider } from '../proxy/grok/provider.js';
import { selectMedia } from '../proxy/shared/media.js';
import { createProxyService } from '../proxy/service.js';
import { createProxyState } from '../public/proxy/state.js';

const providers = {
  agy: dataDir => new AgyProvider({ dataDir, auth: { identity: 'a', token: async () => 'test' } }),
  codex: dataDir => new CodexProvider({ dataDir, auth: { identity: 'c', read: async () => ({ identity: 'c', token: 'test' }), close() {} } }),
  grok: dataDir => new GrokProvider({ dataDir, auth: { identity: 'g', credential: async () => ({ identity: 'g', token: 'test' }) } }),
};

for (const [source, create] of Object.entries(providers)) {
  test(`${source} media enablement persists, rejects invalid changes and preserves chat settings`, async t => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'daylight-media-settings-'));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const provider = create(dataDir), registry = { providers: { [source]: provider } };
    const [model] = await provider.mediaModels();
    assert.equal(model.enabled, true);
    await Promise.all([
      provider.settings.save({ id: 'chat-model' }, { field: 'enabled', value: false }, { invalid: Error }),
      provider.setMediaModel({ id: model.id, field: 'enabled', value: false }),
    ]);
    assert.equal((await provider.mediaModels())[0].enabled, false);
    assert.equal((await create(dataDir).mediaModels())[0].enabled, false);
    await assert.rejects(selectMedia(registry, model.id, source), { code: 'model_not_found' });
    await assert.rejects(provider.setMediaModel({ id: model.id, field: 'enabled', value: 'false' }), { status: 400 });
    await assert.rejects(provider.setMediaModel({ id: model.id, field: 'effort', value: 'high' }), { status: 400 });
    await assert.rejects(provider.setMediaModel({ id: 'unknown', field: 'enabled', value: true }), { status: 400 });
    await provider.setMediaModel({ id: model.id, field: 'enabled', value: true });
    assert.equal((await selectMedia(registry, model.id, source)).id, model.id);
    assert.deepEqual((await provider.settings.read()).disabled, ['chat-model']);
  });
}

test('media management uses a separate settings route and does not discover chat models', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'daylight-media-management-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const provider = providers.grok(dataDir);
  provider.listModels = async () => { throw Error('must not discover chat'); };
  const service = await createProxyService({ dataDir, provider: { listModels: async () => [] }, grokProvider: provider, piOptions: { piDir: path.join(dataDir, 'pi') } });
  t.after(() => service.close());
  const call = async (url, body, method = body === undefined ? 'GET' : 'POST') => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.url = url; req.method = method;
    let code, result;
    await service.handle(req, { writeHead(status) { code = status; }, end(text) { result = JSON.parse(text); } });
    if (code !== 200) throw Object.assign(Error(result.error), { status: code });
    return result;
  };
  const route = '/api/proxy/sources/grok/media-models';
  const { models: [model] } = await call(route);
  const result = await call(route + '/setting', { id: model.id, field: 'enabled', value: false });
  assert.equal(result.models[0].enabled, false);
  assert.equal((await call(route)).models[0].enabled, false);
  await assert.rejects(call(route + '/setting', undefined, 'GET'), { status: 404 });
  await assert.rejects(call('/api/proxy/sources/qoder/media-models/setting', { id: 'x', field: 'enabled', value: true }), { status: 400 });
});

test('media store updates its cached catalog without invalidating chat and discards previous account saves', async () => {
  let pending = Promise.withResolvers();
  let identity = 'a';
  const saved = { models: [{ id: 'image', enabled: false }] };
  const store = createProxyState({
    request: async op => op === 'status' ? { state: 'stopped' } : { sources: [{ id: 'grok', identityKey: identity, revision: identity, authentication: { operations: [] } }] },
    source: async (id, op) => op === 'models' ? { models: [{ id: 'chat' }] } : op === 'media-models' ? { models: [{ id: 'image', enabled: true }] } : pending.promise,
  });
  await store.refresh();
  const chat = await store.resource('grok', 'models');
  await store.resource('grok', 'media-models');
  const save = store.setMediaModel('grok', { id: 'image', field: 'enabled', value: false });
  pending.resolve(saved); await save;
  assert.strictEqual(store.cachedResource('grok', 'models'), chat);
  assert.strictEqual(store.cachedResource('grok', 'media-models'), saved);
  pending = Promise.withResolvers();
  const oldAccountSave = store.setMediaModel('grok', {});
  identity = 'b'; await store.refresh(); pending.resolve(saved); await oldAccountSave;
  assert.equal(store.cachedResource('grok', 'media-models'), undefined);
  store.dispose();
});
