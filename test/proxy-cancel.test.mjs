import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../server.mjs';

async function boot(t, listModels = async () => []) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'daylight-settings-'));
  const server = await createWorkbench({ dataDir, proxyOptions: { provider: { listModels }, includeGateway: false, includeAgy: false, includeGrok: false, pricingOptions: { enabled: false }, piOptions: { piDir: path.join(dataDir, 'pi'), getInfo: async () => ({ installed: true }) } } });
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


// 取消启动：启动卡在「检查来源」时，service/cancel 让它回到 stopped，不记错误；进行中的 service 请求以 409「已取消启动」返回。
test('proxy start can be cancelled while starting', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const { call } = await boot(t, async () => { await gate; return []; });
  t.after(() => release());
  const starting = call('/api/proxy/service', { enabled: true });
  for (let i = 0; i < 50 && (await call('/api/proxy/status')).body.state !== 'starting'; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await call('/api/proxy/status')).body.state, 'starting');
  const cancelled = await call('/api/proxy/service/cancel', {});
  assert.equal(cancelled.status, 200);
  const result = await starting;
  assert.equal(result.status, 409); assert.match(result.body.error, /已取消启动/);
  const after = (await call('/api/proxy/status')).body;
  assert.equal(after.state, 'stopped'); assert.equal(after.lastError, '');
});

test('proxy cancel outside of starting is a harmless no-op', async t => {
  const { call } = await boot(t);
  const r = await call('/api/proxy/service/cancel', {});
  assert.equal(r.status, 200); assert.equal(r.body.state, 'stopped');
});
