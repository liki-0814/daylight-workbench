import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGateway } from '../proxy/gateway.js';
import { createMediaJobs } from '../proxy/shared/media-jobs.js';
import { selectMedia } from '../proxy/shared/media.js';
import { GrokProvider } from '../proxy/grok/provider.js';
import { grokMediaIds } from '../proxy/grok/media.js';

const key = 'synthetic-test-key';

async function listen(gateway) {
  const server = http.createServer(gateway);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

function post(port, route, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/v1' + route, method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Length': payload.length, ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part; }); res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : {} }));
    });
    req.on('error', reject); req.end(payload);
  });
}

test('media gateway forwards every grok id, rejects the bare codex name, and keeps chat models separate', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'daylight-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  const grok = new GrokProvider({ dataDir: dir, auth: { credential: async () => ({ token: 'grok-token', identity: 'user-1', version: '1.0.41' }) }, fetchImpl: async (url, opts) => {
    calls.push({ url, body: opts.body ? JSON.parse(opts.body) : undefined, accept: opts.headers.Accept });
    if (url.includes('/videos/generations')) return Response.json({ request_id: 'req-1' });
    if (url.includes('/videos/')) return Response.json({ status: 'done', video: { url: 'https://vidgen.x.ai/a.mp4' } });
    return Response.json({ data: [{ url: 'https://imgen.x.ai/a.jpeg' }] });
  } });
  const jobs = createMediaJobs(dir);
  const records = [];
  let port;
  const gateway = createGateway({
    getSettings: () => ({ port, apiKey: key }), jobs, records: { append: async row => records.push(row) }, active: new Set(), finishing: new Set(),
    sourceState: { revision: () => 1 }, router: { listModels: async () => [{ id: 'grok-4.7', enabled: true, contextWindows: [] }] },
    registry: { providers: { grok }, execute: async () => { throw new Error('chat execute'); } },
  });
  const server = await listen(gateway);
  port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const models = await new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: '/v1/models', headers: { Authorization: `Bearer ${key}` } }, res => {
      let text = ''; res.on('data', part => { text += part; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    }).on('error', reject);
  });
  assert.equal(models.status, 200);
  assert.deepEqual(models.body.data.map(item => item.id), ['grok-4.7']);
  for (const id of grokMediaIds) {
    const route = id.includes('video') ? '/videos/generations' : '/images/generations';
    const result = await post(port, route, { model: id, prompt: 'a red door' });
    assert.equal(result.status, 200, id);
    assert.equal(calls.at(-1).body.model, id);
    assert.equal(calls.at(-1).accept, 'application/json');
    assert.match(calls.at(-1).url, /^https:\/\/cli-chat-proxy\.grok\.com\/v1\//);
  }
  const imageId = 'grok-imagine-image-2.0';
  await grok.setMediaModel({ id: imageId, field: 'enabled', value: false });
  const beforeDisabled = calls.length;
  const disabled = await post(port, '/images/generations', { model: imageId, prompt: 'x' });
  assert.equal(disabled.status, 400);
  assert.equal(disabled.body.error.code, 'model_not_found');
  assert.equal(calls.length, beforeDisabled);
  await grok.setMediaModel({ id: imageId, field: 'enabled', value: true });
  const bare = await post(port, '/images/generations', { model: 'gpt-image-2.5', prompt: 'x' });
  assert.equal(bare.status, 400);
  assert.match(bare.body.error.message, /gpt-image-2\.5-flare/);
  assert.match(bare.body.error.message, /gpt-image-2\.5-sunburst/);
  const rejected = await post(port, '/videos/generations', { model: 'grok-imagine-video-1.5', prompt: 'x', reference_images: ['a'] });
  assert.equal(rejected.status, 400);
  assert.equal(calls.filter(call => call.body?.reference_images).length, 0);
  const submitted = await post(port, '/videos/generations', { model: 'grok-imagine-video-1.5', prompt: 'wave' });
  const polled = await new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: '/v1/videos/' + submitted.body.id, headers: { Authorization: `Bearer ${key}` } }, res => {
      let text = ''; res.on('data', part => { text += part; }); res.on('end', () => resolve(JSON.parse(text)));
    }).on('error', reject);
  });
  assert.equal(polled.status, 'succeeded');
  assert.match(polled.url, /^https:\/\/vidgen\.x\.ai\//);
  const again = calls.length;
  await new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: '/v1/videos/' + submitted.body.id, headers: { Authorization: `Bearer ${key}` } }, res => { res.resume(); res.on('end', resolve); }).on('error', reject);
  });
  assert.equal(calls.length, again);
  await jobs.dropAccount('grok', 'user-1');
  assert.equal(await jobs.get(submitted.body.id), undefined);
  assert.equal(records.some(row => row.mediaOperation === 'image.generate' && row.model && !row.prompt), true);
  await assert.rejects(() => selectMedia({ providers: { grok: { mediaModels: async () => [], mediaOwns: () => false } } }, 'missing'), { code: 'model_not_found' });
});
