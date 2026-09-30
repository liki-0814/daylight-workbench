import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createQoderBridge, send } from '../qoder/bridge.js';
import { encodeBody, decodeBody } from '../qoder/body-codec.js';
import { signCosy, aesDecryptInfo } from '../qoder/cosy.js';
import { parseModelList } from '../qoder/models.js';
import { createWorkbench } from '../server.mjs';

const teamModel = { key: 'team-model', display_name: 'Qwen3.8-Max（采供线专属）', source: 'byokTeams', format: 'openai' };
const enterpriseModel = { key: 'mode-24b28efaa85443a5bf7eac4de15190f5', display_name: 'Qwen3.8-Max-DogFooding', source: 'organization', format: 'openai', context_config: [{ token_count: 1000000, is_default: true }], thinking_config: { enabled: { efforts: { high: {} } } } };
const teamDogfood = { ...enterpriseModel, key: 'team-dogfood', source: 'byokTeams' };
const catalog = {
  assistant: [{ key: 'test-model', display_name: 'Test Model', source: 'system', format: 'openai', context_config: [{ token_count: 128000, is_default: true }, { token_count: 256000 }], thinking_config: { enabled: { efforts: { low: {}, high: {} } } }, feature_switches: { highspeed: true } }],
  byok_teams: [teamModel, teamDogfood], byok_enterprise: [enterpriseModel],
};
const account = { id: 'acc_test', profile: 'qoder', credential: { uid: 'test', access: 'private-access', refresh: 'private-refresh', machineId: 'test-machine', machineToken: 'private-machine', expires: Date.now() + 3600000 } };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const frame = value => `data: ${JSON.stringify({ body: JSON.stringify(value) })}\n\n`;
function fakeUpstream() {
  const calls = []; let queues = 0, never = false, truncated = false, pendingLogin = true, refreshes = 0;
  return { calls, get refreshes() { return refreshes; }, queue: n => { queues = n; }, hang: () => { never = true; }, truncate: () => { truncated = true; }, authorize: () => { pendingLogin = false; },
    fetch: async (url, options = {}) => {
      const route = new URL(url).pathname;
      if (route.endsWith('/model/list')) return json(catalog);
      if (route.endsWith('/quota/usage')) return json({ usageType: 'credits', userQuota: { total: 0, used: 0, remaining: 0 }, orgResourcePackage: { used: 38, remaining: 25962, cap: 26000, available: true } });
      if (route.endsWith('/deviceToken/poll')) return pendingLogin ? json({}, 404) : json({ token: 'login-access', refresh_token: 'login-refresh', uid: 'test', expires_in: 3600000 });
      if (route.endsWith('/deviceToken/refresh')) { refreshes++; return json({ device_token: 'refreshed-access', expires_in: 3600000 }); }
      if (route.endsWith('/user/status')) return json({ uid: 'test', plan: 'test' });
      if (route.endsWith('/getDataPolicy')) return json({ policy: 'AGREE' });
      if (!route.endsWith('/agent_chat_generation')) throw new Error('unexpected upstream route');
      calls.push({ body: decodeBody(options.body), headers: options.headers });
      if (queues-- > 0) return new Response(frame({ code: '10605', message: 'queued' }));
      if (never) return new Response(new ReadableStream({ start(controller) { options.signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true }); } }));
      const text = frame({ choices: [{ delta: { content: '你好' }, finish_reason: null }] });
      if (truncated) return new Response(text);
      const wire = text + frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{"city":"杭州"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 } }) + 'event: finish\ndata: {}\n\n';
      // Deliberately split a multibyte UTF-8 character across network chunks.
      const bytes = Buffer.from(wire); let offset = 0;
      return new Response(new ReadableStream({ pull(controller) { if (offset >= bytes.length) return controller.close(); controller.enqueue(bytes.subarray(offset, offset += 7)); } }));
    },
  };
}
async function freePort() { const s = http.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const port = s.address().port; await new Promise(r => s.close(r)); return port; }
async function fixture(t, seed = true) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'daylight-qoder-'));
  const fake = fakeUpstream(); const bridge = await createQoderBridge({ dataDir, fetchImpl: fake.fetch });
  if (seed) await bridge.accounts.save(structuredClone(account));
  const management = http.createServer((req, res) => { if (req.headers['x-workbench-token'] !== 'test') return send(res, 403, {}); void bridge.handle(req, res); });
  management.listen(0, '127.0.0.1'); await once(management, 'listening');
  const url = `http://127.0.0.1:${management.address().port}/api/qoder/`;
  const api = async (route, body) => { const response = await fetch(url + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-workbench-token': 'test', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const port = await freePort(); await api('settings', { port, autoStart: false });
  const key = (await api('key')).body.apiKey;
  const client = (route, body, headers = {}) => fetch(`http://127.0.0.1:${port}/v1/${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  t.after(async () => { await bridge.close(); management.closeAllConnections(); await new Promise(r => management.close(r)); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, fake, bridge, api, port, key, client };
}

test('protocol codec and COSY signing preserve Unicode and exact signed path', () => {
  const body = { message: '中文😀', tool: { x: 1 } }; assert.deepEqual(decodeBody(encodeBody(body)), body);
  const sig = signCosy({ url: 'https://api3.qoder.sh/algo/test?Encode=1', body: encodeBody(body), temporaryKey: '0123456789abcdef', timestamp: 1000, requestId: 'test', identity: { uid: 'u', securityOauthToken: 'secret', cosyVersion: '1.0.41' } });
  assert.equal(sig.signedPath, '/test');
  const payload = JSON.parse(Buffer.from(sig.payload, 'base64'));
  assert.deepEqual(JSON.parse(aesDecryptInfo(payload.info, '0123456789abcdef')), { uid: 'u', security_oauth_token: 'secret' });
});

test('model discovery excludes team and labeled exclusive models while preserving organization models and their settings', () => {
  const models = parseModelList({ data: catalog });
  assert.deepEqual(models.map(m => m.id), ['test-model', enterpriseModel.key]);
  assert.deepEqual(models[1].contextWindows, [{ length: 1000000, isDefault: true }]);
  assert.deepEqual(models[1].reasoningEfforts, ['high']);
  const shared = { key: 'shared-without-source', format: 'openai' };
  const chat = [...catalog.assistant, shared, teamModel, teamDogfood, enterpriseModel];
  assert.deepEqual(parseModelList({ assistant: [], chat }).map(m => m.id), ['test-model', shared.key, enterpriseModel.key]);
  assert.deepEqual(parseModelList({ assistant: [], byok_teams: [teamModel], byok_enterprise: [enterpriseModel] }).map(m => m.id), [enterpriseModel.key]);
  const enterpriseExclusive = { ...teamModel, source: 'organization' };
  assert.deepEqual(parseModelList({ assistant: [], byok_teams: [teamDogfood], byok_enterprise: [enterpriseExclusive] }).map(m => m.id), []);
  assert.deepEqual(parseModelList({ assistant: [teamDogfood, { ...enterpriseModel, source: 'byokTeams' }], byok_enterprise: [enterpriseModel] }).map(m => m.id), [enterpriseModel.key]);
});

test('manual lifecycle, PKCE login, key protection, overlay, non-streaming and streaming across all three protocols', async t => {
  const f = await fixture(t, false);
  assert.equal((await f.api('status')).body.state, 'stopped');
  assert.equal((await f.api('service', { enabled: true })).status, 409);
  const login = await f.api('auth/device', {});
  assert.equal(new URL(login.body.url).searchParams.get('challenge_method'), 'S256');
  assert.equal(JSON.stringify(login.body).includes('verifier'), false);
  assert.equal((await f.api('auth/poll', {})).body.authorized, false);
  f.fake.authorize(); assert.equal((await f.api('auth/poll', {})).body.authorized, true);
  assert.equal((await stat(path.join(f.dataDir, 'qoder/account.json'))).mode & 0o777, 0o600);
  const credits = await f.api('credits'); assert.equal(credits.status, 200);
  assert.deepEqual(credits.body.buckets, [{ id: 'organization', label: '团队资源包', used: 38, remaining: 25962, total: 26000 }]);
  assert.equal((await f.api('status')).body.state, 'stopped');
  assert.equal((await f.api('service', { enabled: true })).body.state, 'running');
  assert.equal((await f.client('models', null, { Authorization: 'Bearer invalid' })).status, 401);
  assert.equal((await f.client('models', null, { Origin: 'https://example.com' })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => { const req = http.get({ host: '127.0.0.1', port: f.port, path: '/v1/models', headers: { Host: 'evil.test', Authorization: `Bearer ${f.key}` } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(wrongHost, 403);
  assert.deepEqual((await f.api('models')).body.models.map(m => m.id), ['test-model', enterpriseModel.key]);
  const clientModels = await f.client('models'); assert.equal(clientModels.status, 200);
  assert.deepEqual((await clientModels.json()).data.map(m => m.id), ['test-model', enterpriseModel.key]);
  assert.equal((await f.client('responses', { model: teamModel.key, input: 'hi' })).status, 400);
  assert.equal((await f.client('responses', { model: teamDogfood.key, input: 'hi' })).status, 400);
  assert.equal(f.fake.calls.length, 0);
  const dogfoodResponse = await f.client('responses', { model: enterpriseModel.key, input: 'hi' });
  assert.equal(dogfoodResponse.status, 200); await dogfoodResponse.json();
  assert.equal((await f.api('settings', { port: 5000, autoStart: false })).status, 409);
  assert.equal((await f.api('test', {})).status, 200);
  const requests = [ ['chat/completions', { messages: [{ role: 'user', content: 'private-prompt' }] }], ['responses', { input: 'private-prompt' }], ['messages', { messages: [{ role: 'user', content: 'private-prompt' }], max_tokens: 100 }] ];
  for (const [route, body] of requests) {
    const response = await f.client(route, { model: 'test-model', ...body }); assert.equal(response.status, 200); const result = await response.json(); assert.match(JSON.stringify(result), /你好/); assert.match(JSON.stringify(result), /lookup/);
    const streamed = await f.client(route, { model: 'test-model', ...body, stream: true }); assert.match(streamed.headers.get('content-type'), /event-stream/); const text = await streamed.text(); assert.match(text, /你好/); assert.match(text, /lookup/);
  }
  assert.equal((await f.client('chat/completions', { model: 'test-model', messages: [], reasoning_effort: 'invalid' })).status, 400);
  assert.equal((await f.api('models/setting', { id: 'test-model', field: 'context', value: 123 })).status, 400);
  assert.equal((await f.api('models/setting', { id: 'test-model', field: 'enabled', value: false })).status, 200);
  assert.deepEqual((await (await f.client('models')).json()).data.map(m => m.id), [enterpriseModel.key]);
  assert.equal((await f.client('responses', { model: 'test-model', input: 'hi' })).status, 400);
  const usage = JSON.stringify((await f.api('usage')).body); assert.ok(!usage.includes('private-prompt')); assert.ok(!usage.includes('private-access')); assert.ok(usage.includes('12'));
  assert.equal((await f.api('service', { enabled: false })).body.state, 'stopped');
  await assert.rejects(fetch(`http://127.0.0.1:${f.port}/v1/models`));
});

test('queue retries reuse conversation, rotate request id, exhaust as 503, and reject truncated streams', async t => {
  const f = await fixture(t); await f.api('service', { enabled: true });
  await writeFile(path.join(f.dataDir, 'qoder/settings.json'), JSON.stringify({ queueRetry: { enabled: true, maxRetries: 2, delayMs: 100 } }));
  f.fake.queue(2);
  const response = await f.client('chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }); assert.equal(response.status, 200); await response.json();
  assert.equal(f.fake.calls.length, 3);
  const bodies = f.fake.calls.map(c => c.body);
  assert.equal(new Set(bodies.map(b => b.request_id)).size, 3);
  assert.equal(new Set(bodies.map(b => b.request_set_id)).size, 1);
  f.fake.queue(3); assert.equal((await f.client('responses', { model: 'test-model', input: 'hi', stream: true })).status, 503);
  f.fake.truncate(); const truncated = await f.client('responses', { model: 'test-model', input: 'hi' }); assert.equal(truncated.status, 502);
});

test('port collision restores stopped state; force stop cancels active requests; refresh is serialized', async t => {
  const f = await fixture(t); const occupied = http.createServer(); occupied.listen(f.port, '127.0.0.1'); await once(occupied, 'listening');
  assert.equal((await f.api('service', { enabled: true })).status, 409); assert.equal((await f.api('status')).body.state, 'stopped');
  await new Promise(r => occupied.close(r));
  await f.bridge.accounts.save({ ...account, credential: { ...account.credential, expires: 1 } });
  await Promise.all([f.api('models'), f.api('models')]); assert.equal(f.fake.refreshes, 1);
  await f.api('service', { enabled: true }); f.fake.hang();
  const request = f.client('responses', { model: 'test-model', input: 'hi' }).catch(() => null);
  for (let i = 0; i < 50 && !(await f.api('status')).body.activeRequests; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal((await f.api('service', { enabled: false })).status, 409);
  assert.equal((await f.api('service', { enabled: false, force: true })).body.state, 'stopped'); await request;
});

test('auto-start persists; corrupt proxy configuration leaves task APIs available and protected', async t => {
  const f = await fixture(t);
  await f.api('settings', { port: f.port, autoStart: true });
  const reloaded = await createQoderBridge({ dataDir: f.dataDir, fetchImpl: f.fake.fetch });
  await reloaded.initialize(); assert.equal((await reloaded.status()).state, 'running'); await reloaded.close();
  const state = await readFile(path.join(f.dataDir, 'qoder/service.json'), 'utf8'); assert.ok(!state.includes('private-access'));
  await writeFile(path.join(f.dataDir, 'qoder/service.json'), '{broken');
  const workbench = await createWorkbench({ dataDir: f.dataDir }); workbench.listen(0, '127.0.0.1'); await once(workbench, 'listening');
  t.after(() => new Promise(resolve => { workbench.closeAllConnections(); workbench.close(resolve); }));
  const url = `http://127.0.0.1:${workbench.address().port}`;
  const snapshot = await (await fetch(url + '/api/state')).json(); assert.deepEqual(snapshot.state.tasks, []);
  assert.equal((await fetch(url + '/api/qoder/status')).status, 403);
  assert.equal((await fetch(url + '/api/qoder/credits')).status, 403);
  assert.equal((await fetch(url + '/api/qoder/status', { headers: { 'x-workbench-token': snapshot.token } })).status, 503);
  assert.equal((await fetch(url + '/proxy.html')).status, 200);
});
