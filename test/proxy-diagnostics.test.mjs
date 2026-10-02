import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RequestRecords, RequestTrace } from '../proxy/shared/request-records.js';
import { SourceState } from '../proxy/shared/source-state.js';
import { CustomSources } from '../proxy/custom/provider.js';
import { createWorkbench } from '../server.mjs';
import { writeJson } from '../proxy/shared/store.js';

async function directory(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'daylight-diagnostics-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const model = id => ({ id, enabled: true, displayName: id, contextWindows: [], reasoningEfforts: [] });

test('enabled custom routes retain failed connection badges across restart and retry the selected model', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'daylight-route-health-'));
  let offline = true, server, token, base;
  const calls = [];
  const custom = new CustomSources({ dataDir: dir, fetchImpl: async (_url, options) => {
    const input = JSON.parse(options.body); calls.push(input.model);
    if (offline) throw new TypeError('private connection failure');
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] });
  } });
  const saved = await custom.save({ name: 'Test source', baseUrl: 'https://fixture.invalid/v1', protocol: 'chat', auth: 'none', models: [model('first-model'), model('selected-model')] });
  async function boot() {
    server = await createWorkbench({ dataDir: dir, proxyOptions: { customSources: custom, provider: { cache: {}, listModels: async () => [] }, includeGateway: false, includeAgy: false, includeGrok: false } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    token = (await (await fetch(base + '/api/state')).json()).token;
  }
  async function stop() {
    await server.closeProxy(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  const api = async (route, input) => {
    const response = await fetch(base + route, { method: input ? 'POST' : 'GET', headers: { 'X-Workbench-Token': token, 'Content-Type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  t.after(async () => { if (server.listening) await stop(); await rm(dir, { recursive: true, force: true }); });
  await boot();
  assert.equal((await api('/api/custom-proxy/test', { id: saved.id })).status, 502);
  await stop(); await boot();
  let routes = (await api('/api/proxy/routes')).data.routes;
  let selected = routes.find(r => r.id === 'selected-model');
  assert.equal(selected.enabled, true); assert.equal(selected.sources[0].available, false);
  assert.doesNotMatch(JSON.stringify(routes), /private connection failure/);
  routes = (await api('/api/proxy/routes?retry=selected-model')).data.routes;
  assert.equal(calls.at(-1), 'selected-model');
  assert.equal(routes.find(r => r.id === 'selected-model').sources[0].available, false);
  offline = false;
  routes = (await api('/api/proxy/routes?retry=selected-model')).data.routes;
  assert.equal(calls.at(-1), 'selected-model');
  assert.equal(routes.find(r => r.id === 'selected-model').sources[0].available, true);
});

test('records preserve legacy rows, serialize concurrent writes and isolate persistence failure', async t => {
  const dir = await directory(t), file = path.join(dir, 'usage.json'), legacy = { provider: 'qoder', model: 'old', status: 200, time: new Date().toISOString() };
  await writeJson(file, [legacy]);
  const records = await RequestRecords.load(file);
  await Promise.all(Array.from({ length: 12 }, (_, i) => records.append({ model: String(i), provider: 'custom:test', outcome: 'completed' })));
  assert.equal((await RequestRecords.load(file)).rows.length, 13);
  assert.deepEqual(records.legacy().today, [legacy]);
  assert.equal(records.query({ source: 'custom:test', limit: 4 }).records.length, 4);
  assert.equal(records.query({ model: 'old' }).records[0].outcome, undefined);
  const blocked = path.join(dir, 'blocked'); await mkdir(blocked);
  const failing = new RequestRecords(blocked, []);
  await failing.append({ model: 'still-visible' });
  assert.match(failing.error, /保存失败/);
  assert.equal(failing.query().records[0].model, 'still-visible');
});

test('trace captures content rather than heartbeat, preserves zero and keeps errors after finish', () => {
  const trace = new RequestTrace('/responses');
  trace.observe({ prompt: 'private-prompt', token: 'private-key', reportedModel: 'actual', usage: { inputTokens: 12, cacheReadTokens: 0, privateText: 'hidden' } });
  trace.observe({ reportedModel: { secret: 'hidden-object' }, usage: { inputDetails: { cached_tokens: 0, 'hidden-key': 42 } } });
  trace.event({ type: 'native_response', event: { type: 'response.created' } });
  assert.equal(trace.entry.firstContentMs, undefined);
  trace.event({ type: 'tool_call', name: 'echo', argumentsDelta: '{"secret":"tool-private"}' });
  trace.observe({ stage: 'response' });
  trace.event({ type: 'error', code: 'incomplete_stream', message: 'private-prompt' });
  trace.event({ type: 'finish', reason: 'stop' });
  const row = trace.finish(502, 200);
  assert.equal(row.outcome, 'failed'); assert.equal(row.error.category, 'interrupted');
  assert.equal(row.httpStatus, 200); assert.equal(row.usage.cacheReadTokens, 0); assert.equal(row.usage.cacheWriteTokens, undefined);
  assert.equal(row.toolCallObserved, true); assert.ok(row.firstContentMs >= 0);
  assert.equal(row.reportedModel, 'actual'); assert.equal(row.usage.inputDetails.cached_tokens, 0);
  assert.doesNotMatch(JSON.stringify(row), /private-prompt|private-key|tool-private|hidden|argumentsDelta/);
  const timeout = new RequestTrace('/chat/completions'); timeout.fail({ name: 'TimeoutError' });
  assert.equal(timeout.finish(502, 502).outcome, 'timeout');
});

test('source snapshots separate configured catalogs from verification and invalidate configuration/identity', () => {
  const state = new SourceState(), p = { source: { id: 's', name: 'S', auth: 'none', enabled: true, models: [model('public')], revision: 'one' } }, providers = { 'custom:s': p };
  state.checked('custom:s', p, p.source.models);
  assert.equal(state.snapshot(providers, [p.source], [], [], false)[0].state, 'unchecked');
  state.discovered(p.source, p.source.models);
  const revision = state.revision('custom:s', p), row = { provider: 'custom:s', sourceRevision: revision, model: 'public', protocol: 'chat', streaming: true, outcome: 'completed', time: '2026-09-30T10:00:00Z', toolCallObserved: true };
  let source = state.snapshot(providers, [p.source], [row], [], false)[0];
  assert.equal(source.verification.streaming, row.time); assert.equal(source.verification.toolCall, row.time);
  const invalid = { ...row, time: '2026-09-30T11:00:00Z', outcome: 'failed', error: { category: 'parameters' } };
  assert.equal(state.snapshot(providers, [p.source], [row, invalid], [], false)[0].state, 'ready');
  const failure = { ...row, time: '2000-01-01T00:00:00Z', outcome: 'failed', error: { category: 'network' } };
  state.invalidate('custom:s');
  assert.equal(state.snapshot(providers, [p.source], [failure], [], false)[0].state, 'unavailable');
  state.discovered(p.source, p.source.models);
  assert.equal(state.snapshot(providers, [p.source], [failure], [], false)[0].state, 'ready');
  p.source = { ...p.source, revision: 'two' }; state.invalidate('custom:s');
  source = state.snapshot(providers, [p.source], [row], [], false)[0];
  assert.equal(source.state, 'unchecked'); assert.equal(source.verification.generation, undefined);
  p.source.enabled = false;
  assert.equal(state.snapshot({}, [p.source], [row], [], false)[0].state, 'disabled');
  const builtin = { cache: { identity: 'account-one' } };
  state.checked('codex', builtin, [model('m')]);
  const before = state.revision('codex', builtin); builtin.cache.identity = 'account-two';
  assert.notEqual(state.revision('codex', builtin), before);
  builtin.cache.at = 1;
  state.checked('codex', builtin, null, { status: 401 });
  assert.ok(Date.parse(state.checks.get('codex').at) > 1);
});

test('authenticated public diagnostics preserve wire responses and capture both execution paths', async t => {
  const dir = await directory(t); let discoveries = 0;
  const vault = new Map();
  const custom = new CustomSources({ dataDir: dir, secrets: { get: async id => vault.get(id), set: async (id, value) => vault.set(id, value), delete: async id => vault.delete(id) }, fetchImpl: async (_url, options) => {
    if (!options.body) { discoveries++; return Response.json({ data: [{ id: 'private-model' }] }); }
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'private-model');
    assert.equal(options.headers.Authorization, 'Bearer private-key');
    if (body.stream) return new Response('data: ' + JSON.stringify({ model: 'reported-model', choices: [{ delta: { content: 'OK' } }] }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
    return Response.json({ model: 'reported-model', choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } }, opaque_field: 'preserved' });
  } });
  const saved = await custom.save({ name: 'Custom', baseUrl: 'https://example.test/v1', protocol: 'chat', apiKey: 'private-key', models: [{ id: 'public', upstreamId: 'private-model' }] });
  const q = {
    listModels: async () => [model('q'), model('cancel')],
    async *stream(request, { signal }) {
      yield { type: 'text', delta: 'Q' };
      if (request.model === 'cancel') { await once(signal, 'abort'); signal.throwIfAborted(); }
      yield { type: 'usage', usage: { inputTokens: 5, cacheReadTokens: 0 } };
      yield { type: 'finish', reason: 'length' };
      signal.throwIfAborted();
    },
  };
  const app = await createWorkbench({ dataDir: dir, proxyOptions: { provider: q, includeAgy: false, includeGrok: false, includeGateway: false, customSources: custom } });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { await app.closeProxy(); app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); });
  const base = `http://127.0.0.1:${app.address().port}`, token = (await (await fetch(base + '/api/state')).json()).token;
  const api = async (route, body) => { const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'x-workbench-token': token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); assert.equal(response.status, 200); return response.json(); };
  assert.equal((await fetch(base + '/api/proxy/sources')).status, 403);
  for (const route of ['/api/proxy/status', '/api/proxy/sources', '/api/proxy/requests']) await api(route);
  assert.equal(discoveries, 0);
  assert.equal((await api('/api/proxy/sources')).sources.find(s => s.id === 'custom:' + saved.id).state, 'unchecked');
  const socket = http.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening'); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  await api('/api/qoder/settings', { port, autoStart: false }); await api('/api/qoder/service', { enabled: true });
  const key = (await api('/api/qoder/key')).apiKey;
  const call = body => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'private-prompt' }], ...body }) });
  const json = await (await call({ model: 'public' })).json();
  assert.equal(json.model, 'public'); assert.equal(json.opaque_field, 'preserved'); assert.equal(json.usage.prompt_tokens_details.cached_tokens, 0);
  const stream = await call({ model: 'public', stream: true }); assert.equal(stream.status, 200); assert.match(await stream.text(), /OK|上游连接提前结束/);
  assert.equal((await (await call({ model: 'q' })).json()).choices[0].finish_reason, 'length');
  const cancel = await call({ model: 'cancel', stream: true });
  const reader = cancel.body.getReader(); await reader.read(); await reader.cancel();
  let data;
  for (let i = 0; i < 50; i++) {
    data = await api('/api/proxy/requests');
    if (data.records.some(r => r.model === 'cancel')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(data.records.length, 4);
  const cancelled = data.records.find(r => r.model === 'cancel');
  assert.equal(cancelled.outcome, 'cancelled'); assert.equal(cancelled.httpStatus, 200);
  const customRows = data.records.filter(r => r.provider === 'custom:' + saved.id);
  assert.ok(customRows.every(r => r.reportedModel === 'reported-model' && r.upstreamModel === 'private-model'));
  assert.equal(customRows[0].httpStatus, 200); assert.equal(customRows[0].outcome, 'failed'); assert.equal(customRows[0].error.category, 'interrupted');
  const truncated = data.records.find(r => r.model === 'q');
  assert.equal(truncated.outcome, 'truncated'); assert.equal(truncated.usage.cacheWriteTokens, undefined);
  assert.doesNotMatch(await readFile(path.join(dir, 'qoder/usage.json'), 'utf8'), /private-key|private-prompt|opaque_field/);
  assert.equal((await api('/api/proxy/requests?source=' + encodeURIComponent('custom:' + saved.id))).matched, 2);
  assert.equal((await fetch(base + '/api/proxy/requests?limit=0', { headers: { 'x-workbench-token': token } })).status, 400);
  await api('/api/custom-proxy/save', { ...saved, apiKey: '', enabled: false });
  assert.equal((await api('/api/proxy/sources')).sources.find(s => s.id === 'custom:' + saved.id).verification.generation, undefined);
  assert.equal((await api('/api/qoder/usage')).retained, 4);
  assert.equal((await fetch(base + '/components/proxy-diagnostics.js')).status, 200);
});
