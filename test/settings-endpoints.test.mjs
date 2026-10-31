import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server.mjs';
import { createConversations } from '../ai/conversations.mjs';

// 设置页即时保存：每个设置项一个单项写入接口。
async function freePort() {
  const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  return port;
}
async function boot(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'daylight-settings-'));
  const server = await createWorkbench({ dataDir, proxyOptions: { provider: { listModels: async () => [] }, includeGateway: false, includeAgy: false, includeGrok: false, pricingOptions: { enabled: false }, piOptions: { piDir: path.join(dataDir, 'pi'), getInfo: async () => ({ installed: true }) } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await server.closeProxy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = (await (await fetch(`${base}/api/state`)).json()).token;
  const call = async (route, body) => {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'x-workbench-token': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { call, dataDir };
}

test('proxy settings: port and autoStart are written one key at a time', async t => {
  const { call, dataDir } = await boot(t);
  const port = await freePort();
  let r = await call('/api/proxy/settings/port', { value: port });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.port, port); assert.equal(r.body.autoStart, false);
  r = await call('/api/proxy/settings/autoStart', { value: true });
  assert.equal(r.status, 200); assert.equal(r.body.autoStart, true); assert.equal(r.body.port, port, 'autoStart must not change the port');
  const saved = JSON.parse(await readFile(path.join(dataDir, 'proxy/service.json'), 'utf8').catch(() => readFile(path.join(dataDir, 'qoder/service.json'), 'utf8')));
  assert.equal(saved.port, port); assert.equal(saved.autoStart, true);
});

test('proxy settings: invalid values and unknown keys are rejected without writing', async t => {
  const { call } = await boot(t);
  const before = (await call('/api/proxy/status')).body;
  for (const [key, value, status] of [['port', 80, 400], ['port', '4319', 400], ['port', 70000, 400], ['autoStart', 'yes', 400], ['apiKey', 'x', 404]]) {
    const r = await call('/api/proxy/settings/' + key, { value });
    assert.equal(r.status, status, `${key}=${value}`);
  }
  const after = (await call('/api/proxy/status')).body;
  assert.equal(after.port, before.port); assert.equal(after.autoStart, before.autoStart);
});

test('proxy settings: changing the port while running restarts on the new port', async t => {
  const { call } = await boot(t);
  const first = await freePort();
  await call('/api/proxy/settings/port', { value: first });
  let r = await call('/api/proxy/service', { enabled: true });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.state, 'running');
  const second = await freePort();
  r = await call('/api/proxy/settings/port', { value: second });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.state, 'running'); assert.equal(r.body.port, second);
  const key = (await call('/api/proxy/key')).body.apiKey;
  assert.equal((await fetch(`http://127.0.0.1:${second}/v1/models`, { headers: { Authorization: `Bearer ${key}` } })).status, 200);
  await assert.rejects(fetch(`http://127.0.0.1:${first}/v1/models`));
  // autoStart is editable while running and does not restart.
  r = await call('/api/proxy/settings/autoStart', { value: true });
  assert.equal(r.status, 200); assert.equal(r.body.state, 'running');
  await call('/api/proxy/service', { enabled: false });
});

test('proxy settings: a busy new port leaves the service stopped with a readable error and the port saved', async t => {
  const { call } = await boot(t);
  const first = await freePort();
  await call('/api/proxy/settings/port', { value: first });
  await call('/api/proxy/service', { enabled: true });
  const blocker = http.createServer(); await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  const busy = blocker.address().port;
  const r = await call('/api/proxy/settings/port', { value: busy });
  assert.equal(r.status, 409); assert.match(r.body.error?.message || r.body.error, /已被占用/);
  const status = (await call('/api/proxy/status')).body;
  assert.equal(status.state, 'stopped'); assert.equal(status.port, busy); assert.match(status.lastError, /已被占用/);
});

test('ai settings: single keys update the current backend; model resets effort', async () => {
  let saved;
  const store = { settings: { backend: 'codex', codex: { model: 'a', effort: 'high', contextWindow: 1000, accessMode: 'standard' }, qoder: { model: 'q' }, pi: { model: '' } }, read: () => ({}), write: (name, value) => { saved = { name, value }; }, workspace: () => '/tmp', conversations: new Map() };
  const conversations = createConversations({ store, providers: {}, api: async () => ({}), isRunning: () => false });
  let r = conversations.setting('backend', { value: 'qoder' });
  assert.equal(r.settings.backend, 'qoder'); assert.equal(saved.name, 'settings.json');
  r = conversations.setting('accessMode', { value: 'full', backend: 'codex' });
  assert.equal(r.settings.codex.accessMode, 'full'); assert.equal(r.settings.codex.effort, 'high', 'other keys untouched');
  r = conversations.setting('model', { value: 'b', backend: 'codex' });
  assert.equal(r.settings.codex.model, 'b'); assert.equal(r.settings.codex.effort, ''); assert.equal(r.settings.codex.contextWindow, null);
  assert.equal(r.settings.backend, 'qoder', 'writing another backend never switches the default');
  assert.throws(() => conversations.setting('backend', { value: 'nope' }), /Codex、Qoder 或 Pi/);
  assert.throws(() => conversations.setting('accessMode', { value: 'root' }), /访问模式无效/);
  assert.throws(() => conversations.setting('secret', { value: 'x' }), /接口不存在/);
  assert.throws(() => conversations.setting('model', {}), /缺少 value/);
  assert.equal(store.settings.codex.model, 'b', 'rejected writes leave the saved settings alone');
});
