import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createExtensionsService } from '../extensions/service.mjs';

const mcpFixture = fileURLToPath(new URL('../fixtures/extensions/mcp-server.mjs', import.meta.url));
async function fixture(t, environment = { PATH: process.env.PATH }) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'daylight-ext-mcp-ui-')));
  const agentsRoot = path.join(temp, 'agents'), clientRoots = Object.fromEntries(['codex', 'qoder', 'pi'].map(id => [id, path.join(temp, id)]));
  await fs.mkdir(path.join(agentsRoot, 'daylight'), { recursive: true });
  await fs.writeFile(path.join(agentsRoot, 'daylight/clients.json'), JSON.stringify({ schemaVersion: 1, clients: [], selectedClients: ['codex', 'qoder', 'pi'] }));
  const service = await createExtensionsService({ agentsRoot, clientRoots, environment, cacheMs: 0, probeTimeoutMs: 5000 });
  const server = http.createServer((req, res) => { void service.handle(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.close(); await service.close(); await fs.rm(temp, { recursive: true, force: true }); });
  const call = async (route, input, method = 'POST') => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/extensions' + route, { method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, value: await response.json() };
  };
  const apply = async (action, requestId = randomUUID()) => { const plan = await service.prepare(action); return service.apply({ requestId, expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction }); };
  const stdio = (id, extra = {}) => ({ id, name: id, transport: 'stdio', command: process.execPath, args: [mcpFixture, path.join(temp, id)], ...extra });
  return { temp, service, call, apply, stdio, state: () => service.state(true) };
}

test('shared MCP row toggle disables and re-enables without touching other fields; repeats and bad input are rejected', async t => {
  const f = await fixture(t);
  await f.apply({ type: 'mcp.save', create: true, server: f.stdio('alpha', { envRefs: { TOKEN: 'ALPHA_TOKEN' } }) });
  await f.apply({ type: 'mcp.save', create: true, server: f.stdio('beta') });
  const before = (await f.state()).servers.find(server => server.id === 'alpha');
  const plan = await f.service.prepare({ type: 'mcp.toggle', id: 'alpha', enabled: false });
  assert.deepEqual(plan.changedIds, ['alpha']); assert.ok(plan.impact.some(line => /不启动服务/.test(line)));
  const requestId = randomUUID();
  const receipt = await f.service.apply({ requestId, expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction });
  assert.equal((await f.service.apply({ requestId, expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction })).operationId, receipt.operationId);
  let state = await f.state(); const off = state.servers.find(server => server.id === 'alpha');
  assert.equal(off.enabled, false); assert.deepEqual({ ...off, enabled: true, revision: 0, lastProbe: null }, { ...before, revision: 0, lastProbe: null });
  assert.equal(state.servers.find(server => server.id === 'beta').enabled, true);
  await assert.rejects(f.service.prepare({ type: 'mcp.toggle', id: 'alpha', enabled: false }), failure => failure.status === 409 && failure.code === 'EXTENSIONS_ALREADY_DISABLED');
  await f.apply({ type: 'mcp.toggle', id: 'alpha', enabled: true });
  assert.equal((await f.state()).servers.find(server => server.id === 'alpha').enabled, true);
  await assert.rejects(f.service.prepare({ type: 'mcp.toggle', id: 'alpha', enabled: true }), failure => failure.status === 409 && failure.code === 'EXTENSIONS_ALREADY_ENABLED');
  await assert.rejects(f.service.prepare({ type: 'mcp.toggle', id: 'alpha', enabled: 'no' }), failure => failure.status === 400 && failure.field === 'enabled');
  await assert.rejects(f.service.prepare({ type: 'mcp.toggle', id: 'ghost', enabled: false }), failure => failure.status === 404);
  // operation.restore reverses the toggle
  const toggled = await f.apply({ type: 'mcp.toggle', id: 'beta', enabled: false });
  await f.apply({ type: 'operation.restore', operationId: toggled.operationId });
  assert.equal((await f.state()).servers.find(server => server.id === 'beta').enabled, true);
});

test('a disabled shared server cannot be probed, and disabling cancels a running probe', async t => {
  const f = await fixture(t);
  await f.apply({ type: 'mcp.save', create: true, server: { ...f.stdio('slow'), args: [mcpFixture, path.join(f.temp, 'slow'), 'slow'] } });
  let state = await f.state();
  const started = await f.call('/probes', { id: 'slow', expectedVersion: state.version }); assert.equal(started.status, 200); assert.equal(started.value.status, 'running');
  await f.apply({ type: 'mcp.toggle', id: 'slow', enabled: false });
  const finished = await f.call('/probes/' + started.value.id, undefined, 'GET');
  for (let i = 0; i < 100 && !(await f.call('/probes/' + started.value.id, undefined, 'GET')).value.finishedAt; i++) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await f.call('/probes/' + started.value.id, undefined, 'GET')).value.status, 'cancelled'); void finished;
  state = await f.state();
  const refused = await f.call('/probes', { id: 'slow', expectedVersion: state.version }); assert.equal(refused.status, 400);
  assert.equal(state.servers.find(server => server.id === 'slow').lastProbe.stale, true);
});

test('refStatus reports variable names and whether they are set, never values', async t => {
  const secret = 'value-that-must-not-leak';
  const f = await fixture(t, { PATH: process.env.PATH, MY_TOKEN: secret });
  await f.apply({ type: 'mcp.save', create: true, server: f.stdio('refs', { envRefs: { TOKEN: 'MY_TOKEN', OTHER: 'NOT_SET_VAR' } }) });
  await f.apply({ type: 'mcp.save', create: true, server: { id: 'remote', name: 'remote', transport: 'http', url: 'https://x.example.com/mcp', headerRefs: { Authorization: 'MY_TOKEN' } } });
  const state = await f.call('/state', undefined, 'GET'), refs = state.value.servers.find(server => server.id === 'refs').refStatus;
  assert.deepEqual(refs.toSorted((a, b) => a.key.localeCompare(b.key)), [{ kind: 'env', key: 'OTHER', ref: 'NOT_SET_VAR', set: false, internal: false }, { kind: 'env', key: 'TOKEN', ref: 'MY_TOKEN', set: true, internal: false }]);
  assert.deepEqual(state.value.servers.find(server => server.id === 'remote').refStatus, [{ kind: 'header', key: 'Authorization', ref: 'MY_TOKEN', set: true, internal: false }]);
  assert.equal(state.value.servers.every(server => Array.isArray(server.refStatus)), true);
  const detail = await f.call('/objects/refs', undefined, 'GET'); assert.equal(detail.value.refStatus.length, 2);
  assert.equal(JSON.stringify(state.value).includes(secret) || JSON.stringify(detail.value).includes(secret), false);
});

test('probe-all over HTTP: one confirmation, skips disabled servers, queues beyond two, validates input', async t => {
  const f = await fixture(t);
  for (const id of ['p1', 'p2', 'p3', 'p4']) await f.apply({ type: 'mcp.save', create: true, server: f.stdio(id) });
  await f.apply({ type: 'mcp.toggle', id: 'p4', enabled: false });
  const state = await f.state();
  const bad = [{ ids: [], expectedVersion: state.version }, { ids: ['p1', 'p1'], expectedVersion: state.version }, { ids: ['p1'], id: 'p1', expectedVersion: state.version }, { ids: [3], expectedVersion: state.version }];
  for (const body of bad) assert.equal((await f.call('/probes', body)).status, 400, JSON.stringify(body));
  assert.equal((await f.call('/probes', { ids: ['ghost'], expectedVersion: state.version })).status, 404);
  assert.equal((await f.call('/probes', { ids: ['p1'], expectedVersion: 'stale' })).status, 409);
  const all = await f.call('/probes', { ids: ['p1', 'p2', 'p3', 'p4'], expectedVersion: state.version });
  assert.equal(all.status, 200); assert.deepEqual(all.value.skipped, [{ id: 'p4', reason: 'disabled' }]);
  assert.deepEqual(all.value.probes.map(probe => probe.serverId), ['p1', 'p2', 'p3']); assert.deepEqual(all.value.probes.map(probe => probe.status), ['running', 'running', 'queued']);
  for (const probe of all.value.probes) {
    let value; for (let i = 0; i < 200; i++) { value = (await f.call('/probes/' + probe.id, undefined, 'GET')).value; if (value.finishedAt) break; await new Promise(resolve => setTimeout(resolve, 30)); }
    assert.equal(value.status, 'succeeded', JSON.stringify(value));
  }
});
