import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGateway } from '../proxy/gateway.js';
import { QoderProvider, loadConfig } from '../proxy/qoder/provider.js';
import { AccountStore } from '../proxy/qoder/auth.js';
import { QoderHttp } from '../proxy/qoder/transport.js';
import { createMediaJobs } from '../proxy/shared/media-jobs.js';
import { decodeBody } from '../fixtures/qoder/wire.mjs';
import { PNG_B64, imageResponse, videoId, videoQueued, videoRunning, videoCompleted, videoUrl, serverError } from '../fixtures/qoder/media.mjs';

const key = 'synthetic-test-key';
const account = { id: 'acc_test', profile: 'qoder', credential: { uid: 'test', access: 'private-access', refresh: 'private-refresh', machineId: 'test-machine', machineToken: 'private-machine', expires: Date.now() + 3600000 } };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const context = jobs => ({ signal: AbortSignal.timeout(2000), observe() {}, jobs });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function setup(t, handler, { login = true } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'daylight-qoder-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = loadConfig(dir);
  if (login) { await mkdir(path.dirname(config.accountFile), { recursive: true }); await writeFile(config.accountFile, JSON.stringify(account)); }
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const call = { url, method: options.method, headers: options.headers, body: options.body, envelope: options.body ? decodeBody(options.body) : undefined };
    if (call.envelope) call.inner = JSON.parse(call.envelope.payload);
    calls.push(call);
    return handler(call, options);
  };
  const provider = new QoderProvider(config, new QoderHttp(config, fetchImpl), new AccountStore(config.accountFile));
  return { dir, provider, calls, jobs: createMediaJobs(dir) };
}

test('qoder media lists real names only while logged in and keeps toggles beside chat settings', async t => {
  const { provider, dir } = await setup(t, () => { throw new Error('no network'); }, { login: false });
  assert.deepEqual(await provider.mediaModels(), []);
  assert.equal((await provider.mediaLoginError()).status, 401);
  assert.equal(provider.mediaOwns('wan30'), true);
  assert.equal(provider.mediaOwns('wan3.0'), false);
  await mkdir(path.dirname(provider.config.accountFile), { recursive: true });
  await writeFile(provider.config.accountFile, JSON.stringify(account));
  await writeFile(path.join(path.dirname(provider.config.accountFile), 'settings.json'), JSON.stringify({ disabled: ['chat-model'], queueRetry: { attempts: 2 } }));
  const rows = await provider.mediaModels();
  assert.deepEqual(rows.map(row => [row.id, row.displayName, row.output, row.status, row.enabled]), [
    ['qwen-image-3.0', 'Qwen-Image 3.0 (映射待确认)', 'image', 'ready', true],
    ['wan3.0-video', '万相 3.0', 'video', 'ready', true],
  ]);
  assert.equal(JSON.stringify(rows).includes('ge3i') && JSON.stringify(rows).includes('wan30'), true);
  const after = await provider.setMediaModel({ id: 'wan3.0-video', field: 'enabled', value: false });
  assert.equal(after.find(row => row.id === 'wan3.0-video').enabled, false);
  const saved = JSON.parse(await readFile(path.join(dir, 'qoder', 'settings.json'), 'utf8'));
  assert.deepEqual(saved.disabled.sort(), ['chat-model', 'wan3.0-video']);
  assert.deepEqual(saved.queueRetry, { attempts: 2 });
  await assert.rejects(() => provider.setMediaModel({ id: 'wan3.0-video', field: 'effort', value: 'high' }), { status: 400 });
  await assert.rejects(() => provider.setMediaModel({ id: 'ge3i', field: 'enabled', value: false }), { status: 400 });
});

test('qoder image uses a signed encoded envelope with a non-empty session and returns b64_json', async t => {
  const { provider, calls } = await setup(t, () => json(imageResponse));
  const result = await provider.executeMedia({ operation: 'image.generate', model: 'qwen-image-3.0', body: { model: 'qwen-image-3.0', prompt: 'a red circle', size: '1536x1024' } }, context());
  assert.deepEqual(result.data, [{ b64_json: PNG_B64 }]);
  assert.equal(JSON.stringify(result).includes('usage'), false);
  const [call] = calls;
  assert.equal(new URL(call.url).pathname + new URL(call.url).search, '/algo/api/v2/service/pro/generateImage?Encode=1');
  assert.equal(call.method, 'POST');
  assert.deepEqual(Object.keys(call.envelope).sort(), ['encodeVersion', 'payload', 'requestId', 'sessionId']);
  assert.equal(call.envelope.encodeVersion, '1');
  assert.match(call.envelope.sessionId, UUID);
  assert.match(call.envelope.requestId, UUID);
  assert.deepEqual(call.inner, { model: 'ge3i', prompt: 'a red circle', size: '1536x1024' });
  assert.equal(call.headers.accept, 'application/json');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.match(call.headers.authorization, /^Bearer COSY\./);
  assert.equal(call.headers['x-model-key'], undefined);
  assert.equal(call.headers['cosy-scene'], undefined);
  const defaulted = await provider.executeMedia({ operation: 'image.generate', model: 'qwen-image-3.0', body: { model: 'qwen-image-3.0', prompt: 'x', n: 1 } }, context());
  assert.equal(defaulted.data.length, 1);
  assert.equal(calls[1].inner.size, '1024x1024');
  assert.notEqual(calls[1].envelope.sessionId, call.envelope.sessionId);
});

test('qoder image rejects unsupported requests before any upstream call', async t => {
  const { provider, calls } = await setup(t, () => json(imageResponse));
  const run = body => provider.executeMedia({ operation: 'image.generate', model: 'qwen-image-3.0', body: { model: 'qwen-image-3.0', prompt: 'x', ...body } }, context());
  for (const body of [{ response_format: 'url' }, { n: 2 }, { size: '640x480' }, { quality: 'hd' }, { prompt: '' }]) await assert.rejects(() => run(body), { status: 400 }, JSON.stringify(body));
  await assert.rejects(() => provider.executeMedia({ operation: 'image.edit', model: 'qwen-image-3.0', body: {} }, context()), { status: 400 });
  assert.equal(calls.length, 0);
});

test('qoder image never converts a missing b64 and surfaces content filters and 500s once', async t => {
  let mode = 'https';
  const { provider, calls } = await setup(t, () => mode === 'https' ? json({ data: [{ url: 'https://example.com/a.png' }] }) : mode === 'filter' ? json({ error: { code: 'content_filter', message: 'secret prompt' } }, 400) : json(serverError, 500));
  const run = () => provider.executeMedia({ operation: 'image.generate', model: 'qwen-image-3.0', body: { model: 'qwen-image-3.0', prompt: 'x' } }, context());
  await assert.rejects(run, { status: 502, code: 'response_format_unavailable' });
  mode = 'filter';
  await assert.rejects(run, error => error.status === 400 && /修改描述/.test(error.message) && !error.message.includes('secret'));
  mode = '500';
  const before = calls.length;
  await assert.rejects(run, { status: 500 });
  assert.equal(calls.length, before + 1);
});

test('qoder video submits wan30 with string seconds, stores a job and maps polls without re-asking finished jobs', async t => {
  const states = [videoQueued, videoRunning, videoCompleted];
  const { provider, calls, jobs, dir } = await setup(t, call => call.method === 'POST' ? json(videoQueued) : json(states.shift()));
  const submitted = await provider.executeMedia({ operation: 'video.submit', model: 'wan3.0-video', body: { model: 'wan3.0-video', prompt: '热咖啡', duration: 5, size: '1280x720' } }, context(jobs));
  assert.match(submitted.id, /^vid_/);
  assert.deepEqual({ ...submitted, id: undefined }, { id: undefined, object: 'video', status: 'in_progress', model: 'wan3.0-video', source: 'qoder' });
  const [submit] = calls;
  assert.equal(new URL(submit.url).pathname + new URL(submit.url).search, '/algo/api/v2/service/pro/videos?Encode=1');
  assert.deepEqual(submit.inner, { model: 'wan30', prompt: '热咖啡', seconds: '5', size: '1280x720' });
  assert.match(submit.envelope.sessionId, UUID);
  const stored = await jobs.get(submitted.id);
  assert.deepEqual([stored.provider, stored.account, stored.model, stored.upstreamId], ['qoder', 'acc_test', 'wan3.0-video', videoId]);
  assert.equal((await readFile(path.join(dir, 'proxy', 'media-jobs.json'), 'utf8')).includes('热咖啡'), false);
  const poll = () => provider.executeMedia({ operation: 'video.poll', model: 'wan3.0-video', body: { id: submitted.id } }, context(jobs));
  assert.equal((await poll()).status, 'in_progress');
  assert.equal((await poll()).status, 'in_progress');
  const done = await poll();
  assert.equal(done.status, 'succeeded');
  assert.equal(done.url, videoUrl);
  assert.equal(done.expires_at, 1795837072);
  const get = calls.at(-1);
  assert.equal(get.method, 'GET');
  assert.equal(get.body, undefined);
  assert.equal(new URL(get.url).pathname + new URL(get.url).search, `/algo/api/v2/service/pro/videos/${videoId}`);
  assert.equal(get.headers['content-type'], undefined);
  const upstreamCalls = calls.length;
  assert.equal((await poll()).status, 'succeeded');
  assert.equal(calls.length, upstreamCalls);
  assert.equal(JSON.stringify(await jobs.get(submitted.id)).includes('usage'), false);
});

test('qoder video validates fields, keeps failures out of the job row and refuses submissions without an id', async t => {
  let reply = videoQueued;
  const { provider, calls, jobs } = await setup(t, call => call.method === 'POST' ? (reply === serverError ? json(serverError, 500) : json(reply)) : json({ id: videoId, status: 'failed', error: { code: 'content_filter', message: 'secret prompt' } }));
  const submit = body => provider.executeMedia({ operation: 'video.submit', model: 'wan3.0-video', body: { model: 'wan3.0-video', prompt: 'x', ...body } }, context(jobs));
  for (const body of [{ duration: 1 }, { duration: 31 }, { duration: 2.5 }, { duration: '5' }, { size: '800x600' }, { image: 'https://example.com/a.png' }, { mode: 'first_frame' }, { input_reference: {} }, { seconds: '5' }, { unknown: 1 }]) await assert.rejects(() => submit(body), { status: 400 }, JSON.stringify(body));
  assert.equal(calls.length, 0);
  assert.equal((await submit({ duration: 30, size: '1080P' })).status, 'in_progress');
  assert.deepEqual([calls[0].inner.seconds, calls[0].inner.size], ['30', '1080P']);
  const job = (await jobs.get((await submit({})).id));
  assert.deepEqual([calls[1].inner.seconds, calls[1].inner.size], ['5', '1280x720']);
  const failed = await provider.executeMedia({ operation: 'video.poll', model: job.model, body: { id: job.id } }, context(jobs));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.url, undefined);
  const row = await jobs.get(job.id);
  assert.equal(row.errorCode, 'content_filter');
  assert.equal(JSON.stringify(row).includes('secret'), false);
  reply = serverError;
  const before = calls.length;
  await assert.rejects(() => submit({}), { status: 500 });
  assert.equal(calls.length, before + 1);
  reply = { object: 'video', status: 'queued' };
  await assert.rejects(() => submit({}), { status: 502, code: 'invalid_upstream' });
  await assert.rejects(() => provider.executeMedia({ operation: 'video.poll', model: 'wan3.0-video', body: { id: 'vid_missing' } }, context(jobs)), { status: 404 });
});

test('qoder auth exposes the account key for media job cleanup', async t => {
  const { provider } = await setup(t, () => json({}));
  assert.equal(await provider.auth.accountKey(), 'acc_test');
  const loggedOut = await setup(t, () => json({}), { login: false });
  assert.equal(await loggedOut.provider.auth.accountKey(), undefined);
});

test('media gateway routes the wan30 alias to the canonical id and hides a disabled qoder model', async t => {
  const { provider, calls, jobs } = await setup(t, call => call.method === 'POST' ? (call.url.includes('generateImage') ? json(imageResponse) : json(videoQueued)) : json(videoCompleted));
  let port;
  const records = [];
  const gateway = createGateway({
    getSettings: () => ({ port, apiKey: key }), jobs, records: { append: async row => records.push(row) }, active: new Set(), finishing: new Set(),
    sourceState: { revision: () => 1 }, router: { listModels: async () => [] }, registry: { providers: { qoder: provider }, execute: async () => { throw new Error('chat execute'); } },
  });
  const server = http.createServer(gateway);
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (method, route, body) => new Promise((resolve, reject) => {
    const payload = body && Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v1' + route, method, headers: { Authorization: `Bearer ${key}`, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part; }); res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : {} }));
    });
    req.on('error', reject); req.end(payload);
  });
  const image = await request('POST', '/images/generations', { model: 'ge3i', prompt: 'x' });
  assert.equal(image.status, 200);
  assert.equal(image.body.data[0].b64_json, PNG_B64);
  const video = await request('POST', '/videos/generations', { model: 'wan30', prompt: 'x' });
  assert.equal(video.status, 200);
  assert.equal(video.body.model, 'wan3.0-video');
  assert.equal(calls.at(-1).inner.model, 'wan30');
  const polled = await request('GET', '/videos/' + video.body.id);
  assert.equal(polled.body.status, 'succeeded');
  assert.equal(polled.body.url, videoUrl);
  assert.equal(records.some(row => row.mediaOperation === 'video.submit' && !JSON.stringify(row).includes('"x"')), true);
  await provider.setMediaModel({ id: 'wan3.0-video', field: 'enabled', value: false });
  const sent = calls.length;
  const hidden = await request('POST', '/videos/generations', { model: 'wan3.0-video', prompt: 'x' });
  assert.equal(hidden.status, 400);
  assert.equal(hidden.body.error.code, 'model_not_found');
  assert.equal(calls.length, sent);
});
