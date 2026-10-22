import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {QwenWorkProvider} from '../proxy/qwenwork/provider.js';
import {adaptChatModes} from '../proxy/qwenwork/models.js';
import {MaasCredentials, conversationScope, mintBody, preferMaasBase, exchangeUrl} from '../proxy/qwenwork/credentials.js';
import {refreshBody, startDeviceFlow, expiresAt, buildQoderWorkLoginUrl, allowedAuthHost} from '../proxy/qwenwork/auth.js';
import {loadConfig} from '../proxy/qwenwork/provider.js';
import {createWorkbench} from '../server.mjs';
import {definitions} from '../ai/tools/definitions.mjs';
import {proxySourceNames, proxySourceTabs} from '../core/proxy-sources.js';

const OFFICE = 'synthetic-office-token';
const REFRESH = 'synthetic-office-refresh';
const MAAS = 'synthetic-maas-token';
const SECRETS = [OFFICE, REFRESH, MAAS, 'synthetic-maas-token-2', 'synthetic-office-next'];

function jwt(payload) { return `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`; }
function challengeOf(verifier) { return createHash('sha256').update(verifier).digest('base64url'); }
const catalog = () => ({schema_version: 2, catalog: [
  {key: 'mode-chat', harness: 'oc', format: 'openai/chat-completions', i18n: {display_name: {zh: 'Qwen3.8-Flash'}}, max_input_tokens: 128000, max_output_tokens: 8192, is_reasoning: true, thinking_config: {efforts: ['low', 'high']}, model_id: 'qwen-real-chat', tools: true},
  {key: 'mode-responses', harness: 'oc', format: 'openai/responses', execution: {preferred_harness: 'opencode', routes: {opencode: {modelId: 'qwen-real-responses', apiProtocol: 'openai_responses', enabled: true, limits: {context_window: 200000, max_output_tokens: 16000}}}}},
  {key: 'mode-off', enable: false, format: 'openai/chat-completions'},
]});
const contextFor = kind => kind === 'biz'
  ? {user: {id: 'user-1', name: '成员', is_biz: true, orgId: 'org-1', team_id: 'team-1'}, organization: {org_name: '示例团队'}}
  : {user: {id: 'user-1', name: '个人', is_biz: false}};
function chatStream(tool) {
  const delta = tool ? {tool_calls: [{index: 0, id: 'call_echo', type: 'function', function: {name: 'echo', arguments: '{}'}}]} : {content: 'OK'};
  const chunk = (choice, finish) => `data: ${JSON.stringify({choices: [{delta: choice, finish_reason: finish || null}]})}\n\n`;
  return new Response(chunk(delta) + chunk({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', {headers: {'Content-Type': 'text/event-stream'}});
}

async function setup(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'daylight-qwenwork-'));
  const state = {calls: [], identity: 'personal', poll: 'ok', baseUrl: '', inferenceStatus: 200, exchangeStatus: 200, minted: 0, time: Date.now()};
  const fetchImpl = async (url, init = {}) => {
    const href = url instanceof URL ? url.href : String(url);
    const parsed = new URL(href);
    state.calls.push({href, path: parsed.pathname, init});
    const json = (body, status = 200) => Response.json(body, {status});
    if (parsed.pathname === '/api/v1/deviceToken/poll') {
      if (state.poll === 'pending') return json({}, 404);
      const verifier = parsed.searchParams.get('verifier');
      const challenge = state.poll === 'mismatch' ? 'not-the-challenge' : challengeOf(verifier);
      const token = state.poll === 'environment' ? jwt({iss: 'https://evil.example/auth'}) : OFFICE;
      return json({token, refresh_token: REFRESH, nonce: parsed.searchParams.get('nonce'), code_challenge: challenge, code_challenge_method: 'S256', expires_in: 3600});
    }
    if (parsed.pathname === '/api/v1/deviceToken/refresh') return json({device_token: 'synthetic-office-next', refresh_token: 'synthetic-office-refresh-2', expires_in: 3600});
    if (parsed.pathname.startsWith('/api/v1/adapter/user/account-context')) return json(contextFor(state.identity));
    if (parsed.pathname === '/api/desktop/chat-modes') return json(catalog());
    if (parsed.pathname === '/api/desktop-sessions') {
      state.minted++;
      const requested = JSON.parse(init.body || '{}').session_id;
      const sessionId = requested || (state.uniqueSessions ? `synthetic-session-${state.minted}` : 'synthetic-session');
      return json({access_token: state.minted === 1 ? MAAS : 'synthetic-maas-token-2', expires_at_ms: state.time + 60_000, ttl_ms: 60_000, session_id: sessionId, ...(state.baseUrl ? {base_url: state.baseUrl} : {})});
    }
    if (parsed.pathname === '/v1/access-tokens/exchange') return json(state.exchangeStatus === 200 ? {access_token: 'synthetic-maas-token-2', expires_at: state.time + 60_000} : {}, state.exchangeStatus);
    if (parsed.pathname.startsWith('/v1/')) {
      const body = JSON.parse(init.body || '{}');
      if (state.inferenceStatus === 401) { state.inferenceStatus = 200; return json({}, 401); }
      return chatStream(!!body.tools?.length || !!body.input);
    }
    return json({}, 404);
  };
  const provider = new QwenWorkProvider({dataDir, fetchImpl, now: () => state.time, config: loadConfig(dataDir, {})});
  t.after(async () => { provider.close(); await rm(dataDir, {recursive: true, force: true, maxRetries: 3}); });
  return {dataDir, state, provider};
}
const safe = value => { for (const secret of SECRETS) assert.equal(JSON.stringify(value).includes(secret), false); };

test('PKCE login stays on the office site and poll binds the verifier without storing a pending token', async t => {
  const {provider, state} = await setup(t);
  const login = await provider.auth.login();
  const url = new URL(login.url);
  const callback = new URL(url.searchParams.get('oauth_callback'));
  assert.equal(url.origin, 'https://gateway.qwenwork.cn');
  assert.equal(url.pathname, '/users/sign-in');
  assert.equal(url.searchParams.get('biz_variant'), 'qoderwork');
  assert.equal(callback.origin, url.origin);
  assert.equal(callback.pathname, '/device/selectAccounts');
  assert.equal(callback.searchParams.get('challenge_method'), 'S256');
  assert.equal(callback.searchParams.get('redirect_uri'), 'qwenwork-cn://');
  assert.ok(callback.searchParams.get('challenge'));
  assert.ok(callback.searchParams.get('nonce'));
  assert.ok(callback.searchParams.get('machine_id'));
  assert.equal(callback.searchParams.get('client_id'), 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb');
  assert.equal(callback.searchParams.has('verifier'), false);
  assert.equal(url.searchParams.has('verifier'), false);
  assert.equal(url.searchParams.get('type'), null);
  assert.deepEqual([...url.searchParams.keys()].sort(), ['biz_variant', 'oauth_callback', 'state']);
  for (const name of ['email', 'sso', 'sso_email', 'connection_id', 'tenant', 'type']) assert.equal(url.searchParams.has(name), false);
  const security = JSON.parse(Buffer.from(url.searchParams.get('state'), 'base64url').toString());
  assert.equal(security.v, 1);
  assert.equal(security.user_agent, 'qoderwork/1.3.0');
  assert.equal(security.umid_token, undefined);
  assert.equal(security.x_mini_wua, undefined);
  safe(login);
  assert.equal(state.calls.length, 0);
  state.poll = 'pending';
  assert.equal((await provider.auth.poll()).authorized, false);
  state.poll = 'ok';
  assert.equal((await provider.auth.poll()).authorized, true);
  const poll = state.calls.find(call => call.path === '/api/v1/deviceToken/poll');
  assert.equal(poll.init.headers['X-QwenWork-Version'], '1.3.0');
  assert.equal(poll.init.headers['X-QwenWork-Build'], '26101007');
  assert.equal(poll.init.headers['X-QwenWork-Channel'], 'stable');
  assert.equal(poll.init.headers.Authorization, undefined);
  assert.equal(provider.snapshot().account.login, '个人');
  safe(provider.snapshot());
});

test('poll rejects a mismatched binding or a token issued for another environment', async t => {
  const {provider, state} = await setup(t);
  await provider.auth.login();
  state.poll = 'mismatch';
  await assert.rejects(provider.auth.poll(), /登录校验失败/);
  await provider.auth.login();
  state.poll = 'environment';
  await assert.rejects(provider.auth.poll(), /环境/);
  assert.equal(provider.auth.account, undefined);
});

test('personal and team refresh targets stay distinct and a changed identity is not saved', async t => {
  const {provider, state, dataDir} = await setup(t);
  await provider.auth.login();
  assert.equal((await provider.auth.poll()).authorized, true);
  assert.equal((await provider.auth.refresh()).ok, true);
  assert.equal(JSON.parse(state.calls.filter(call => call.path === '/api/v1/deviceToken/refresh').at(-1).init.body).target, 'c');
  state.identity = 'biz';
  await assert.rejects(provider.auth.refresh(), /身份已变化/);
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'qwenwork/account.json'), 'utf8')).credential.target, 'c');
  assert.deepEqual(refreshBody({target: 'c', refresh: 'ignored'}), {refresh_token: 'ignored', target: 'c'});
  assert.deepEqual(refreshBody({target: 'biz', teamId: 'team-1', refresh: 'ignored'}), {refresh_token: 'ignored', target: 'biz', team_id: 'team-1'});
  await provider.auth.logout();
  state.identity = 'biz';
  await provider.auth.login();
  assert.equal((await provider.auth.poll()).authorized, true);
  state.identity = 'biz';
  assert.equal((await provider.auth.refresh()).ok, true);
  const refresh = state.calls.filter(call => call.path === '/api/v1/deviceToken/refresh').at(-1);
  assert.equal(refresh.init.headers.Authorization, undefined);
  assert.equal(JSON.parse(refresh.init.body).target, 'biz');
  assert.equal(JSON.parse(refresh.init.body).team_id, 'team-1');
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'qwenwork/account.json'), 'utf8')).credential.organization, '示例团队');
});

test('chat-modes map a mode key to the upstream model and protocol', () => {
  const models = adaptChatModes(catalog());
  assert.deepEqual(models.map(model => [model.id, model.upstreamId, model.nativeProtocols[0], model.displayName]), [
    ['mode-chat', 'qwen-real-chat', 'chat', 'Qwen3.8-Flash'],
    ['mode-responses', 'qwen-real-responses', 'responses', 'mode-responses'],
  ]);
  assert.deepEqual(models[0].reasoningEfforts, ['low', 'high']);
  assert.equal(models[0].contextWindow, 128000);
  assert.equal(models[1].maxOutputTokens, 16000);
  assert.equal(preferMaasBase('https://evil.example/v1', 'https://maas.xiaoluozi.cn/v1'), 'https://maas.xiaoluozi.cn/v1');
  assert.equal(preferMaasBase('https://session.maas.xiaoluozi.cn/v1', 'https://maas.xiaoluozi.cn/v1'), 'https://session.maas.xiaoluozi.cn/v1');
  assert.deepEqual(mintBody(), {});
  assert.deepEqual(mintBody(' session-1 '), {session_id: 'session-1'});
  const routed = adaptChatModes({catalog: [
    {key: 'disabled-route', execution: {preferredHarness: 'opencode', routes: {opencode: {enabled: false, modelId: 'upstream-disabled', apiProtocol: 'openai'}}}},
    {key: 'bad-protocol', execution: {preferredHarness: 'opencode', routes: {opencode: {enabled: true, modelId: 'upstream-bad', apiProtocol: 'not-a-protocol'}}}},
    {key: 'unsupported-harness', execution: {preferredHarness: 'qwencode', routes: {qwencode: {enabled: true, modelId: 'upstream-anthropic', apiProtocol: 'anthropic'}}}},
    {key: 'backup-route', execution: {preferredHarness: 'opencode', routes: {
      opencode: {enabled: false, modelId: 'upstream-disabled', apiProtocol: 'openai'},
      'qoder-cli': {enabled: true, modelId: 'upstream-cli', apiProtocol: 'openai'},
    }}},
    {key: 'legacy-chat', format: 'openai/chat-completions', model_id: 'legacy-upstream'},
    {key: 'legacy-key-only', harness: 'oc', format: 'openai/chat-completions'},
  ]});
  assert.deepEqual(routed.map(model => [model.id, model.upstreamId, model.enabled]), [
    ['backup-route', 'upstream-cli', true],
    ['legacy-chat', 'legacy-upstream', true],
    ['legacy-key-only', 'legacy-key-only', true],
  ]);
});

test('auth clock helpers use a function as the default now', () => {
  const flow = startDeviceFlow({authBase: 'https://qwenwork.cn', clientId: 'client', redirectUri: 'qwenwork-cn://'});
  assert.ok(flow.expiresAt > Date.now());
  assert.equal(new URL(flow.url).searchParams.get('challenge_method'), 'S256');
  const expiry = expiresAt({expires_in: 60});
  assert.ok(expiry > Date.now() && expiry <= Date.now() + 61_000);
});

test('login wrapper keeps the device callback and rejects origins outside the allowlist', () => {
  assert.equal(loadConfig('/tmp/daylight-qwenwork-config', {}).authBase, 'https://gateway.qwenwork.cn');
  for (const injected of ['https://evil.example', 'https://gateway.qwenwork.cn.evil.example', 'https://user:pass@gateway.qwenwork.cn', 'http://gateway.qwenwork.cn']) assert.throws(() => loadConfig('/tmp/daylight-qwenwork-config', {QWENWORK_AUTH_BASE: injected}), /无效/);
  const device = new URL('https://gateway.qwenwork.cn/device/selectAccounts');
  for (const [key, value] of Object.entries({challenge: 'abc', challenge_method: 'S256', nonce: 'n', machine_id: 'm', client_id: 'c', redirect_uri: 'qwenwork-cn://'})) device.searchParams.set(key, value);
  const page = new URL(buildQoderWorkLoginUrl(device.href, {userAgent: 'qoderwork/1.3.0'}));
  const callback = new URL(page.searchParams.get('oauth_callback'));
  assert.equal(page.origin, 'https://gateway.qwenwork.cn');
  assert.equal(page.pathname, '/users/sign-in');
  assert.equal(callback.href, device.href);
  assert.equal(allowedAuthHost('evil.example'), false);
  for (const bad of ['https://evil.example/device/selectAccounts?challenge=x', 'https://gateway.qwenwork.cn.evil.example/device/selectAccounts', 'http://gateway.qwenwork.cn/device/selectAccounts', 'https://gateway.qwenwork.cn/users/sign-in', 'https://user:secret@gateway.qwenwork.cn/device/selectAccounts']) assert.throws(() => buildQoderWorkLoginUrl(bad), /无效/);
});

test('MaaS credentials are isolated, rotated once, and retried after rejection', async () => {
  let now = 1_000_000, minted = 0, exchanges = 0, held;
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === '/api/desktop-sessions') {
      minted++;
      const requested = JSON.parse(init.body || '{}').session_id;
      if (minted === 1) { await new Promise(resolve => { held = resolve; }); }
      return Response.json({access_token: `synthetic-maas-${minted}`, expires_at_ms: now + 100_000, ttl_ms: 100_000, session_id: requested || `session-${minted}`});
    }
    exchanges++;
    return Response.json({}, {status: exchanges === 1 ? 503 : 401});
  };
  const credentials = new MaasCredentials({now: () => now});
  const input = (identity, force = false) => ({identity, officeToken: OFFICE, openApiBase: 'https://gateway.qwenwork.cn', headers: {}, fetchImpl, force});
  const first = credentials.resolve(input('env-a'));
  const second = credentials.resolve(input('env-a'));
  held();
  assert.equal((await first).accessToken, (await second).accessToken);
  assert.equal(minted, 1);
  await credentials.resolve(input('env-b'));
  assert.equal(minted, 2);
  now += 60_000;
  const kept = await credentials.resolve(input('env-a'));
  assert.equal(kept.accessToken, 'synthetic-maas-1');
  assert.equal(exchanges, 1);
  now += 31_000;
  const rotated = await credentials.resolve(input('env-a'));
  assert.equal(rotated.accessToken, 'synthetic-maas-3');
  assert.equal(exchangeUrl(rotated.baseUrl), 'https://maas.xiaoluozi.cn/v1/access-tokens/exchange');
});

test('conversations isolate MaaS sessions without sending the external conversation id', async t => {
  const {provider, state} = await setup(t);
  await provider.auth.login();
  assert.equal((await provider.auth.poll()).authorized, true);
  state.uniqueSessions = true;
  const raw = {model: 'mode-chat', messages: [{role: 'user', content: 'Hi'}]};
  const mints = () => state.calls.filter(call => call.path === '/api/desktop-sessions');
  const sessionHeader = () => state.calls.filter(call => call.path === '/v1/chat/completions').at(-1).init.headers['x-session-id'];
  await provider.execute({raw, protocol: 'chat', conversationId: 'conv alpha'}, {});
  await provider.forward(raw, 'chat', {conversationId: 'conv/beta'});
  assert.deepEqual(mints().map(call => JSON.parse(call.init.body)), [{}, {}]);
  const issued = state.calls.filter(call => call.path === '/v1/chat/completions').map(call => call.init.headers['x-session-id']);
  assert.deepEqual(issued, ['synthetic-session-1', 'synthetic-session-2']);
  await provider.execute({raw, protocol: 'chat', conversationId: 'conv alpha'}, {conversationId: 'conv alpha'});
  assert.equal(mints().length, 2);
  assert.equal(sessionHeader(), 'synthetic-session-1');
  state.inferenceStatus = 401;
  await provider.forward(raw, 'chat', {conversationId: 'conv alpha'});
  assert.equal(mints().length, 3);
  assert.deepEqual(JSON.parse(mints().at(-1).init.body), {session_id: 'synthetic-session-1'});
  assert.equal(sessionHeader(), 'synthetic-session-1');
  await provider.forward(raw, 'chat', {conversationId: 'conv/beta'});
  assert.equal(mints().length, 3);
  assert.equal(sessionHeader(), 'synthetic-session-2');
  assert.equal(JSON.stringify(mints().map(call => call.init.body)).includes('conv alpha'), false);
  assert.equal(JSON.stringify(mints().map(call => call.init.body)).includes('conv/beta'), false);
  let isolated = 0;
  const credentials = new MaasCredentials({now: () => Date.now()});
  const fetchImpl = async (url, init = {}) => {
    isolated++;
    assert.equal(JSON.parse(init.body || '{}').session_id, undefined);
    return Response.json({access_token: `synthetic-maas-iso-${isolated}`, expires_at_ms: Date.now() + 60_000, ttl_ms: 60_000, session_id: `iso-${isolated}`});
  };
  const scope = conversationScope('conv alpha');
  const input = identity => ({identity, sessionId: scope, officeToken: OFFICE, openApiBase: 'https://gateway.qwenwork.cn', headers: {}, fetchImpl});
  await credentials.resolve(input('https://gateway.qwenwork.cn\0acc-a'));
  await credentials.resolve(input('https://other.gateway.qwenwork.cn\0acc-a'));
  await credentials.resolve(input('https://gateway.qwenwork.cn\0acc-b'));
  await credentials.resolve(input('https://gateway.qwenwork.cn\0acc-a'));
  assert.equal(isolated, 3);
});

test('native chat keeps tools and a responses model is converted onto its catalog protocol', async t => {
  const {provider, state} = await setup(t);
  await provider.auth.login();
  assert.equal((await provider.auth.poll()).authorized, true);
  state.baseUrl = 'https://session.maas.xiaoluozi.cn/v1';
  const raw = {model: 'mode-chat', messages: [{role: 'user', content: 'Hi'}], tools: [{type: 'function', function: {name: 'echo', parameters: {type: 'object'}}}], stream: true, temperature: 0.2};
  const result = await provider.forward(raw, 'chat');
  assert.equal(result.protocol, 'chat');
  assert.equal(result.streaming, true);
  const call = state.calls.at(-1);
  assert.equal(call.href, 'https://session.maas.xiaoluozi.cn/v1/chat/completions');
  const body = JSON.parse(call.init.body);
  assert.equal(body.model, 'qwen-real-chat');
  assert.equal(body.temperature, 0.2);
  assert.equal(body.tools[0].function.name, 'echo');
  assert.equal(body.client_type, undefined);
  assert.equal(call.init.headers.Authorization, `Bearer ${MAAS}`);
  assert.equal(call.init.headers['x-session-id'], 'synthetic-session');
  assert.equal(call.init.headers['x-qw-invocation-ref'], undefined);
  assert.equal(call.href.includes('127.0.0.1'), false);
  await provider.setModel({id: 'mode-chat', field: 'effort', value: 'low'});
  await provider.forward({model: 'mode-chat', messages: [{role: 'user', content: 'Hi'}]}, 'chat');
  assert.equal(JSON.parse(state.calls.at(-1).init.body).reasoning_effort, 'low');
  await provider.forward({model: 'mode-responses', messages: [{role: 'user', content: 'Hi'}], max_tokens: 32}, 'chat');
  const converted = state.calls.at(-1);
  assert.equal(converted.href, 'https://session.maas.xiaoluozi.cn/v1/responses');
  assert.equal(JSON.parse(converted.init.body).model, 'qwen-real-responses');
  assert.equal(JSON.parse(converted.init.body).max_output_tokens, 32);
  state.inferenceStatus = 401;
  await provider.forward({model: 'mode-chat', messages: [{role: 'user', content: 'Hi'}]}, 'chat');
  assert.equal(state.minted, 2);
  safe(provider.snapshot());
});

test('management login, public streaming and tool calls share the provider without writing Qoder credentials', async t => {
  const f = await setup(t);
  await f.provider.auth.login();
  assert.equal((await f.provider.auth.poll()).authorized, true);
  const server = await createWorkbench({dataDir: f.dataDir, proxyOptions: {provider: {listModels: async () => []}, qwenworkProvider: f.provider, includeGateway: false, includeAgy: false, includeGrok: false, pricingOptions: {enabled: false}, piOptions: {piDir: path.join(f.dataDir, 'pi'), getInfo: async () => ({installed: true})}}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await server.closeProxy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = (await (await fetch(`${base}/api/state`)).json()).token;
  const api = async (route, body) => {
    const response = await fetch(base + route, {method: body === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json', 'x-workbench-token': token}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    safe(value);
    return value;
  };
  const sources = (await api('/api/proxy/sources')).sources;
  assert.equal(sources.find(source => source.id === 'qwenwork').name, '千问办公');
  assert.equal(sources.find(source => source.id === 'qwenwork').account.login, '个人');
  assert.equal(proxySourceNames.qwenwork, '千问办公');
  assert.equal(proxySourceTabs.find(source => source.id === 'qwenwork').name, '千问办公');
  assert.equal(definitions.find(item => item.name === 'daylight_get_proxy_login').inputSchema.properties.sourceId.enum.includes('qwenwork'), true);
  const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  await api('/api/proxy/settings', {port, autoStart: false});
  await api('/api/proxy/service', {enabled: true});
  const key = (await api('/api/proxy/key')).apiKey;
  const catalog = await (await fetch(`http://127.0.0.1:${port}/v1/models`, {headers:{Authorization:`Bearer ${key}`}})).json();
  assert.ok(catalog.data.some(model=>model.id==='qwen3.8-flash'));
  assert.ok(!catalog.data.some(model=>model.id==='mode-chat'));
  const namedResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'qwen3.8-flash',stream:true,messages:[{role:'user',content:'Hi'}]})});
  assert.equal(namedResponse.status,200);await namedResponse.text();
  assert.equal(JSON.parse(f.state.calls.filter(call=>call.path==='/v1/chat/completions').at(-1).init.body).model,'qwen-real-chat');
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {method: 'POST', headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json'}, body: JSON.stringify({model: 'mode-chat', stream: true, messages: [{role: 'user', content: 'Hi'}], tools: [{type: 'function', function: {name: 'echo', parameters: {type: 'object'}}}]})});
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(await response.text(), /echo/);
  const upstream = f.state.calls.filter(call => call.path === '/v1/chat/completions').at(-1);
  assert.equal(JSON.parse(upstream.init.body).tools[0].function.name, 'echo');
  assert.equal(upstream.init.headers.Authorization, `Bearer ${MAAS}`);
  await api('/api/proxy/sources/qwenwork/auth/logout', {});
  await assert.rejects(readFile(path.join(f.dataDir, 'qoder/account.json')));
  assert.equal((await api('/api/proxy/sources')).sources.find(source => source.id === 'qwenwork').configured, false);
  safe(JSON.parse(await readFile(path.join(f.dataDir, 'qwenwork/settings.json'), 'utf8').catch(() => '{}')));
});
