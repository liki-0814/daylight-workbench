import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPiConfig, piAPIs, modelConfig } from '../cli/pi-config.js';
import { writeJson } from '../proxy/shared/store.js';
import { createWorkbench } from '../server.mjs';

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'daylight-pi-'));
  let pi; t.after(async () => { await pi?.close(); await rm(dataDir, { recursive: true, force: true }); });
  const piDir = path.join(dataDir, 'pi');
  const models = { extra: true, providers: { other: { apiKey: 'other-private' }, daylight: { api: 'openai-completions', apiKey: 'old-private', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'old', name: 'Old', custom: 'keep' }, { id: 'a', name: 'Old A', maxTokens: 444, compat: { supportsDeveloperRole: false }, headers: { Authorization: 'model-private' } }] } } };
  const settings = { defaultProvider: 'other', defaultModel: 'old-default', defaultThinkingLevel: 'high', extensions: ['keep'] };
  await writeJson(path.join(piDir, 'models.json'), models); await writeJson(path.join(piDir, 'settings.json'), settings);
  let catalog = [{ id: 'a', name: 'A', source: 'codex', pi: {'openai-completions':'Codex 通道需用 Responses，不能接收 Pi 的输出预算','anthropic-messages':'Codex 通道需用 Responses，不能接收 Pi 的输出预算'}, sourceName: 'Codex', contextWindow: 272000, isReasoning: true }, { id: 'b', name: 'B', source: 'kimi', pi: {'anthropic-messages':'此通道不能转换 Pi Messages 的缓存与思考字段，请选择 Responses 或 Chat Completions'}, sourceName: 'Kimi' }];
  let gateway = { baseUrl: 'http://127.0.0.1:4319/v1', apiKey: 'proxy-private', state: 'running' };
  const getCatalog = async () => catalog, getGateway = async () => gateway;
  const serviceOptions = { dataDir, piDir, getCatalog, getGateway, getInfo: async () => ({ installed: true, version: 'test' }), ...options };
  pi=createPiConfig(serviceOptions);
  return { dataDir, piDir, serviceOptions, pi, models, settings, setCatalog: value => { catalog = value; }, setGateway: value => { gateway = value; }, json: async name => JSON.parse(await readFile(path.join(piDir, name + '.json'), 'utf8')), text: name => readFile(path.join(piDir, name + '.json'), 'utf8') };
}
async function apply(pi, input, requestId = 'apply-one') { const state = await pi.state(input.api); return pi.apply({ ...input, expectedVersion: state.version, requestId }); }

test('Pi preview is read-only, shows real metadata and never exposes keys or model headers', async t => {
  const f = await fixture(t), before = await f.text('models');
  const state = await f.pi.state(), plan = await f.pi.prepare({});
  assert.equal(state.models[0].state, 'update'); assert.equal(state.models[1].state, 'new');
  assert.equal(state.pi.importedCount, 1); assert.equal(state.pi.configuredCount, 2); assert.equal(state.obsolete[0].id, 'old');
  assert(plan.changes.some(m => m.id === 'old' && m.state === 'removed'));
  assert.equal(plan.config.providers.daylight.models[0].contextWindow, 272000);
  assert.equal(plan.config.providers.daylight.models[0].compat.supportsMaxOutputTokens, false);
  assert(!('contextWindow' in plan.config.providers.daylight.models[1]));
  for (const value of [state, plan]) assert(!JSON.stringify(value).includes('-private'));
  assert.equal(await f.text('models'), before);
});
test('Pi fully replaces Daylight with the complete catalog, removes stale definitions and preserves other providers/settings', async t => {
  const f = await fixture(t), settingsBefore = await f.text('settings');
  const result = await apply(f.pi, {}), saved = await f.json('models');
  assert.equal(result.count, 2); assert.deepEqual(saved.providers.other, f.models.providers.other);
  assert.deepEqual(saved.providers.daylight.models.map(m => m.id), ['a', 'b']);
  assert.equal(saved.providers.daylight.models[0].api, 'openai-responses');
  assert.equal(saved.providers.daylight.models[0].maxTokens, undefined);
  assert.equal(saved.providers.daylight.models[0].headers, undefined);
  assert.equal(saved.providers.daylight.api, 'openai-responses');
  assert.equal(saved.providers.daylight.apiKey, 'proxy-private');
  assert.equal(await f.text('settings'), settingsBefore);
  assert.equal((await stat(result.backupPath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(f.piDir, 'models.json'))).mode & 0o777, 0o600);
  assert((await f.pi.state()).models.every(m => m.state === 'connected'));
});
test('one global API applies to all catalog models, for all three Pi protocols', async t => {
  const f = await fixture(t);
  f.setCatalog([{ id: 'a', name: 'A', source: 'qoder' }, { id: 'b', name: 'B', source: 'agy' }]);
  for (const [i, api] of piAPIs.entries()) {
    const plan = await f.pi.prepare({ api });
    assert(plan.config.providers.daylight.models.every(m => m.api === api));
    await apply(f.pi, { api }, 'protocol-' + i);
    assert((await f.json('models')).providers.daylight.models.every(m => m.api === api));
  }
  await assert.rejects(f.pi.state('other'), /接口无效/);
});
test('known incompatible Pi protocol combinations are blocked before any write', async t => {
  const f = await fixture(t), before = await f.text('models');
  assert((await f.pi.state('openai-completions')).models[0].unavailableReason);
  await assert.rejects(f.pi.prepare({ api: 'openai-completions' }), /Codex 通道/);
  f.setCatalog([{ id: 'b', name: 'B', source: 'kimi', pi: {'anthropic-messages':'此通道不能转换 Pi Messages 的缓存与思考字段，请选择 Responses 或 Chat Completions'} }]);
  await assert.rejects(apply(f.pi, { api: 'anthropic-messages' }), /缓存与思考/);
  f.setCatalog([{ id: 'native', name: 'Native', source: 'custom:one', nativeProtocol: 'messages' }]);
  assert.equal((await f.pi.prepare({ api: 'anthropic-messages' })).api, 'anthropic-messages');
  assert.equal(await f.text('models'), before);
});
test('default change is explicit; durable restore returns both files byte-for-byte', async t => {
  const f = await fixture(t), before = [await f.text('models'), await f.text('settings')];
  await apply(f.pi, { defaultModel: 'b' });
  assert.deepEqual(await f.json('settings'), { ...f.settings, defaultProvider: 'daylight', defaultModel: 'b' });
  const restarted = createPiConfig(f.serviceOptions);
  assert.equal((await restarted.state()).pi.canRestore, true);
  await restarted.restore();
  assert.deepEqual([await f.text('models'), await f.text('settings')], before);
  assert.equal((await restarted.state()).pi.canRestore, false);
});
test('stale files, key changes and catalog changes reject apply; external edits reject restore', async t => {
  const f = await fixture(t), state = await f.pi.state();
  await writeJson(path.join(f.piDir, 'settings.json'), { ...f.settings, manual: true });
  await assert.rejects(f.pi.apply({ ids: ['a'], expectedVersion: state.version, requestId: 'stale-files' }), /已变化/);
  const current = await f.pi.state(); f.setGateway({ baseUrl: 'http://127.0.0.1:4319/v1', apiKey: 'rotated', state: 'running' });
  await assert.rejects(f.pi.apply({ ids: ['a'], expectedVersion: current.version, requestId: 'stale-key' }), /已变化/);
  const catalogBefore = await f.pi.state(); f.setCatalog([{ id: 'a', name: 'new', source: 'codex', pi: {'openai-completions':'Codex 通道需用 Responses，不能接收 Pi 的输出预算','anthropic-messages':'Codex 通道需用 Responses，不能接收 Pi 的输出预算'} }]);
  await assert.rejects(f.pi.apply({ ids: ['a'], expectedVersion: catalogBefore.version, requestId: 'stale-catalog' }), /已变化/);
  await apply(f.pi, {});
  await writeFile(path.join(f.piDir, 'models.json'), '{broken');
  await assert.rejects(f.pi.restore(), /外部修改/); assert.equal(await f.text('models'), '{broken');
});
test('request replay is idempotent and cannot hide changed or restored files', async t => {
  const f = await fixture(t), state = await f.pi.state(), input = { expectedVersion: state.version, requestId: 'same-request' };
  await f.pi.apply(input); assert.equal((await f.pi.apply(input)).replayed, true);
  await assert.rejects(f.pi.apply({ ...input, ids: ['b'] }), /requestId/);
  await f.pi.restore(); await assert.rejects(f.pi.apply(input), /恢复或中断/);
});
test('malformed JSON, missing models and invalid defaults never overwrite user files', async t => {
  const f = await fixture(t);
  await assert.rejects(f.pi.prepare(null), error => error.status === 400);
  await assert.rejects(f.pi.apply(null), error => error.status === 400);
  await assert.rejects(f.pi.prepare({ ids: ['a'] }), /全量同步/);
  await assert.rejects(f.pi.prepare({ defaultModel: 'missing' }), /默认模型/);
  await writeFile(path.join(f.piDir, 'settings.json'), '{broken');
  await assert.rejects(f.pi.state(), /不是有效 JSON/); assert.equal(await f.text('settings'), '{broken');
});
test('failed second-file writes roll back the first file and preserve the original default', async t => {
  let failed = false;
  const f = await fixture(t, { writeText: async (file, text) => {
    if (file.endsWith('settings.json') && !failed) { failed = true; throw new Error('simulated write failure'); }
    await writeFile(file, text, { mode: 0o600 });
  } });
  const before = [await f.text('models'), await f.text('settings')];
  await assert.rejects(apply(f.pi, { defaultModel: 'a' }), /simulated/);
  assert.deepEqual([await f.text('models'), await f.text('settings')], before);
});
test('first-time import and restore preserve absent files rather than creating empty settings', async t => {
  const f = await fixture(t); await rm(f.piDir, { recursive: true });
  await apply(f.pi, {});
  await assert.rejects(f.text('settings'), { code: 'ENOENT' });
  await f.pi.restore(); await assert.rejects(f.text('models'), { code: 'ENOENT' });
});
test('interrupted write and failed rollback remain recoverable after a service restart', async t => {
  let writes = 0;
  const f = await fixture(t, { writeText: async (file, text) => {
    if (++writes > 1) throw new Error('simulated unavailable disk');
    await writeFile(file, text, { mode: 0o600 });
  } });
  const before = [await f.text('models'), await f.text('settings')];
  await assert.rejects(apply(f.pi, { defaultModel: 'a' }), /写入未完成/);
  const restarted = createPiConfig({ ...f.serviceOptions, writeText: undefined });
  const state = await restarted.state();
  assert.equal(state.pending, true); assert.equal(state.pi.canRestore, true);
  await assert.rejects(restarted.prepare({ ids: ['b'] }), /写入中断/);
  await restarted.restore();
  assert.deepEqual([await f.text('models'), await f.text('settings')], before);
});
test('removed default is cleared without changing thinking, while a surviving default is kept', async t => {
  const f = await fixture(t);
  await writeJson(path.join(f.piDir, 'settings.json'), { ...f.settings, defaultProvider: 'daylight', defaultModel: 'old' });
  const plan = await f.pi.prepare({}); assert.equal(plan.settings.defaultModel, null);
  await apply(f.pi, {});
  const settings = await f.json('settings'); assert.equal(settings.defaultModel, undefined); assert.equal(settings.defaultProvider, undefined); assert.equal(settings.defaultThinkingLevel, 'high');
  await writeJson(path.join(f.piDir, 'settings.json'), { ...settings, defaultProvider: 'daylight', defaultModel: 'a' });
  const before = await f.text('settings'); await apply(f.pi, {}, 'keep-default'); assert.equal(await f.text('settings'), before);
});
test('automatic switch is durable, syncs additions/removals and metadata, and restore turns it off', async t => {
  const f = await fixture(t); await f.pi.start(); t.after(() => f.pi.close());
  const state = await f.pi.state();
  await f.pi.automatic({ enabled: true, expectedVersion: state.version, requestId: 'enable-auto' });
  assert.equal((await f.pi.state()).automatic.enabled, true);
  f.setCatalog([{ id: 'b', name: 'New B', source: 'kimi', pi: {'anthropic-messages':'此通道不能转换 Pi Messages 的缓存与思考字段，请选择 Responses 或 Chat Completions'}, contextWindow: 10000 }, { id: 'new', name: 'New', source: 'qoder' }]);
  assert.equal((await f.pi.autoSync()).ok, true);
  const saved = (await f.json('models')).providers.daylight;
  assert.deepEqual(saved.models.map(m => m.id), ['b', 'new']); assert.equal(saved.models[0].contextWindow, 10000);
  assert(saved.models.every(m => m.api === 'openai-responses'));
  await f.pi.close();
  const restarted = createPiConfig(f.serviceOptions); await restarted.start(); t.after(() => restarted.close());
  assert.equal((await restarted.state()).automatic.enabled, true);
  await restarted.restore(); assert.equal((await restarted.state()).automatic.enabled, false);
  assert.deepEqual((await f.json('models')).providers.daylight.models.map(m => m.id), ['a', 'b']);
  f.setCatalog([]); assert.equal((await restarted.autoSync()).skipped, true);
});
test('automatic sync fails closed on unavailable catalogs or external Pi edits; manual sync resumes it', async t => {
  const f = await fixture(t); await f.pi.start(); t.after(() => f.pi.close());
  await f.pi.automatic({ enabled: true, expectedVersion: (await f.pi.state()).version, requestId: 'enable-auto' });
  const before = await f.text('models');
  f.setCatalog({ models: [{ id: 'a', name: 'A', source: 'codex', pi: {'openai-completions':'Codex 通道需用 Responses，不能接收 Pi 的输出预算','anthropic-messages':'Codex 通道需用 Responses，不能接收 Pi 的输出预算'} }], failedSources: [{ id: 'kimi', name: 'Kimi' }] });
  assert.equal((await f.pi.autoSync()).ok, false); assert.equal(await f.text('models'), before);
  await assert.rejects(apply(f.pi, {}, 'unavailable'), /目录读取失败/);
  f.setCatalog([{ id: 'a', name: 'A', source: 'codex', pi: {'openai-completions':'Codex 通道需用 Responses，不能接收 Pi 的输出预算','anthropic-messages':'Codex 通道需用 Responses，不能接收 Pi 的输出预算'} }]);
  await writeJson(path.join(f.piDir, 'models.json'), { ...await f.json('models'), manual: true });
  const edited = await f.text('models'); assert.match((await f.pi.autoSync()).error, /外部修改/); assert.equal(await f.text('models'), edited);
  await apply(f.pi, {}, 'manual-resume'); assert.equal((await f.pi.state()).automatic.error, '');
  assert.equal((await f.pi.autoSync()).ok, true);
  await f.pi.automatic({ enabled: false }); f.setCatalog([]); assert.equal((await f.pi.autoSync()).skipped, true);
});
test('a successfully read empty catalog clears only Daylight, with backup and exact recovery', async t => {
  const f = await fixture(t), before = await f.text('models'); f.setCatalog([]);
  assert.equal((await apply(f.pi, {})).count, 0); assert.deepEqual((await f.json('models')).providers.daylight.models, []);
  assert.deepEqual((await f.json('models')).providers.other, f.models.providers.other);
  await f.pi.restore(); assert.equal(await f.text('models'), before);
});
test('never configured sources do not block first setup; previously managed sources cannot disappear on a failed refresh after restart', async t => {
  const f = await fixture(t);
  await writeJson(path.join(f.piDir, 'models.json'), { ...f.models, providers: { other: f.models.providers.other } });
  const models = [{ id: 'a', name: 'A', source: 'codex', pi: {'openai-completions':'Codex 通道需用 Responses，不能接收 Pi 的输出预算','anthropic-messages':'Codex 通道需用 Responses，不能接收 Pi 的输出预算'} }];
  f.setCatalog({ models, failedSources: [{ id: 'agy', name: 'AGY', unconfigured: true }] });
  await apply(f.pi, {});
  assert.equal((await f.pi.state()).catalogError, '');
  const before = await f.text('models');
  const restarted = createPiConfig(f.serviceOptions); await restarted.start(); t.after(() => restarted.close());
  f.setCatalog({ models: [], failedSources: [{ id: 'codex', name: 'Codex', unconfigured: true }] });
  await assert.rejects(apply(restarted, {}, 'failed-after-restart'), /目录读取失败/);
  assert.equal(await f.text('models'), before);
});
test('the automatic timer updates the complete model set without an HTTP request', async t => {
  const f = await fixture(t, { syncIntervalMs: 20 }); await f.pi.start(); t.after(() => f.pi.close());
  await f.pi.automatic({ enabled: true, expectedVersion: (await f.pi.state()).version, requestId: 'timer-enable' });
  f.setCatalog([{ id: 'timer', name: 'Timer', source: 'qoder' }]);
  for (let i = 0; i < 40; i++) {
    if ((await f.json('models')).providers.daylight.models[0].id === 'timer') return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('automatic timer did not sync the catalog');
});
test('authenticated Node HTTP endpoints expose Pi state and execute only in the injected test directory', async t => {
  const f = await fixture(t), models = [{ id: 'test', enabled: true, displayName: 'Test', provider: 'qoder', contextWindow: 1000 }];
  const provider = { listModels: async () => models, cache: {}, credits: async () => ({}) };
  const server = await createWorkbench({ dataDir: f.dataDir, proxyOptions: { provider, includeGateway: false, includeAgy: false, includeGrok: false, piOptions: { piDir: f.piDir, getInfo: async () => ({ installed: true, version: 'test' }) } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await server.closeProxy(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port, token = (await (await fetch(base + '/api/state')).json()).token;
  const call = (route, body, headers = {}) => fetch(base + '/api/cli/pi/' + route, { method: body ? 'POST' : 'GET', headers: { 'x-workbench-token': token, 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await fetch(base + '/api/cli/pi/state')).status, 403);
  assert.equal((await call('state', undefined, { Origin: 'https://example.com' })).status, 403);
  const state = await (await call('state')).json(); assert.equal(state.models[0].id, 'test');
  const result = await call('apply', { ids: ['test'], requestId: 'http-test', expectedVersion: state.version });
  assert.equal(result.status, 200); assert.equal((await f.json('models')).providers.daylight.models.at(-1).api, 'openai-responses');
  assert.equal((await call('restore', {})).status, 200);
});

test('Pi writes declared thinking levels and configured output capacity', () => {
  const m=modelConfig({id:'m',name:'M',source:'qoder',isReasoning:true,reasoningEfforts:['low','high','ultra'],maxOutputTokens:32000});
  assert.equal(m.maxTokens,32000);
  assert.deepEqual(m.thinkingLevelMap,{off:null,minimal:null,low:'low',medium:null,high:'high',xhigh:null,max:'ultra'});
});
test('manual Pi capacity and thinking maps persist before sync, across restart, refresh and automatic sync', async t => {
  const f=await fixture(t);
  const overrides={a:{contextWindow:1000000,maxTokens:100000,reasoning:true,input:['text','image'],thinkingLevelMap:{high:'high',max:'high',off:null}}};
  const before=await f.text('models');
  await f.pi.configuration({expectedVersion:(await f.pi.state()).version,modelOverrides:overrides});
  assert.equal(await f.text('models'),before);
  const restarted=createPiConfig(f.serviceOptions);await restarted.start();t.after(()=>restarted.close());
  assert.deepEqual((await restarted.state()).models[0].overrides,overrides.a);
  await apply(restarted,{},'with-custom');
  let m=(await f.json('models')).providers.daylight.models[0];assert.equal(m.maxTokens,100000);assert.equal(m.contextWindow,1000000);assert.equal(m.thinkingLevelMap.max,'high');
  const state=await restarted.state();await restarted.automatic({enabled:true,expectedVersion:state.version,requestId:'enable-custom'});
  f.setCatalog([{id:'a',name:'Changed A',source:'codex',contextWindow:200000,maxOutputTokens:16000}]);
  await restarted.autoSync();m=(await f.json('models')).providers.daylight.models[0];assert.equal(m.contextWindow,1000000);assert.equal(m.maxTokens,100000);
  await restarted.configuration({expectedVersion:(await restarted.state()).version,modelOverrides:{}});
  await apply(restarted,{},'reset-custom');m=(await f.json('models')).providers.daylight.models[0];assert.equal(m.contextWindow,200000);assert.equal(m.maxTokens,16000);
  await restarted.close();
});
test('invalid Pi personal settings fail before changing files', async t => {
 const f=await fixture(t), version=(await f.pi.state()).version;
 for(const fields of [{maxTokens:0},{contextWindow:1.5},{thinkingLevelMap:{wrong:'high'}},{thinkingLevelMap:{high:42}},{input:['audio']}])await assert.rejects(f.pi.configuration({expectedVersion:version,modelOverrides:{a:fields}}));
 await assert.rejects(f.pi.configuration({expectedVersion:'stale',modelOverrides:{}}),e=>e.status===409);
});

test('ordinary Pi reads do not queue behind an explicit slow catalog refresh', async t => {
  const gate = Promise.withResolvers(), started = Promise.withResolvers();
  const models = [{ id: 'a', name: 'A', source: 'qoder' }];
  const f = await fixture(t, { getCatalog: async force => {
    if (force) { started.resolve(); await gate.promise; }
    return models;
  } });
  const refresh = f.pi.state(undefined, true); await started.promise;
  try {
    const state = await f.pi.state(); assert.equal(state.models[0].id, 'a');
  } finally { gate.resolve(); await refresh; }
});

test('automatic Pi sync reads the shared catalog without force and leaves unchanged files/receipts untouched', async t => {
  const flags = [], catalog = [{ id: 'a', name: 'A', source: 'qoder' }];
  const f = await fixture(t, { getCatalog: async force => { flags.push(force); return catalog; } });
  await f.pi.start();
  await f.pi.automatic({ enabled: true, expectedVersion: (await f.pi.state()).version, requestId: 'cached-auto' });
  const before = await f.text('models'), syncFile = path.join(f.dataDir, 'cli/pi-sync.json');
  const receipt = await readFile(syncFile, 'utf8'), lastSyncedAt = (await f.pi.state()).automatic.lastSyncedAt;
  for (let i = 0; i < 3; i++) assert.equal((await f.pi.autoSync()).unchanged, true);
  assert(flags.every(force => force === false));
  assert.equal(await f.text('models'), before); assert.equal(await readFile(syncFile, 'utf8'), receipt);
  assert.equal((await f.pi.state()).automatic.lastSyncedAt, lastSyncedAt);
});

test('Kimi thinking-only restriction preserves its declared effort mappings', () => {
  const configured = modelConfig({ id: 'kimi/k3', name: 'K3', source: 'kimi', pi: {'anthropic-messages':'此通道不能转换 Pi Messages 的缓存与思考字段，请选择 Responses 或 Chat Completions'}, isReasoning: true, reasoningEfforts: ['low', 'high', 'max'], thinkingLevelMap: { off: null } });
  assert.deepEqual(configured.thinkingLevelMap, { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' });
});
