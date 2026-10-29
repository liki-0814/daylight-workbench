import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgyProvider } from '../proxy/agy/provider.js';
import { agyMediaIds } from '../proxy/agy/media.js';

test('agy forwards every gemini image id and defaults to bytes', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'daylight-agy-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  const provider = new AgyProvider({ dataDir: dir, auth: { identity: 'agy-user', epoch: 1, token: async () => 'agy-token' }, fetchImpl: async (url, opts) => {
    calls.push({ url, body: opts.body ? JSON.parse(opts.body) : undefined });
    return Response.json({ response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'abc' } }] } }] } });
  } });
  provider.catalog = async () => ({ project: 'project-1' });
  assert.deepEqual((await provider.mediaModels()).map(row => row.id), agyMediaIds);
  for (const id of agyMediaIds) {
    const result = await provider.executeMedia({ operation: 'image.generate', body: { model: id, prompt: 'lake' }, model: id }, { signal: AbortSignal.timeout(1000), observe() {} });
    assert.equal(result.data[0].b64_json, 'abc');
    assert.equal(calls.at(-1).body.model, id);
    assert.equal(calls.at(-1).url, 'https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent');
    assert.deepEqual(calls.at(-1).body.request.generationConfig.responseModalities, ['IMAGE']);
  }
  await assert.rejects(() => provider.executeMedia({ operation: 'image.generate', body: { model: agyMediaIds[0], prompt: 'lake', response_format: 'url' }, model: agyMediaIds[0] }, { signal: AbortSignal.timeout(1000), observe() {} }), { code: 'response_format_unavailable' });
  const loggedOut = new AgyProvider({ dataDir: dir, auth: { token: async () => { throw new Error('logged out'); } }, fetchImpl: async () => { throw new Error('network'); } });
  assert.deepEqual(await loggedOut.mediaModels(), []);
});

const png = 'image/png';
async function editWith(t, { fetchImpl, lookup = async () => [{ address: '93.184.216.34', family: 4 }], urls = ['https://img.example/a.png'] }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'daylight-agy-ref-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const generated = [];
  const provider = new AgyProvider({ dataDir: dir, lookup, auth: { identity: 'agy-user', epoch: 1, token: async () => 'agy-token' }, fetchImpl: async (url, opts) => {
    if (url.startsWith('https://daily-cloudcode-pa')) { generated.push(JSON.parse(opts.body)); return Response.json({ response: { candidates: [{ content: { parts: [{ inlineData: { data: 'abc' } }] } }] } }); }
    return fetchImpl(url, opts);
  } });
  provider.catalog = async () => ({ project: 'project-1' });
  const run = () => provider.executeMedia({ operation: 'image.edit', body: { model: agyMediaIds[0], prompt: 'edit', images: urls.map(url => ({ type: 'image_url', url })) }, model: agyMediaIds[0] }, { signal: AbortSignal.timeout(2000), observe() {} });
  return { run, generated };
}

function stream(chunks, headers = {}) {
  let sent = 0, cancelled = false;
  const body = new ReadableStream({ pull(controller) { if (sent >= chunks.length) controller.close(); else controller.enqueue(chunks[sent++]); }, cancel() { cancelled = true; } });
  return { response: new Response(body, { headers: { 'content-type': png, ...headers } }), state: () => ({ sent, cancelled }) };
}

test('agy reads a remote reference image through a running byte count and inlines it', async t => {
  const data = new Uint8Array(1000).fill(7);
  const { run, generated } = await editWith(t, { fetchImpl: async () => stream([data.slice(0, 400), data.slice(400)]).response });
  await run();
  assert.equal(generated[0].request.contents[0].parts[1].inlineData.data, Buffer.from(data).toString('base64'));
  assert.equal(generated[0].request.contents[0].parts[1].inlineData.mimeType, png);
});

test('agy rejects an oversized declared content-length without reading the body', async t => {
  const source = stream([new Uint8Array(10)], { 'content-length': '8000001' });
  const { run, generated } = await editWith(t, { fetchImpl: async () => source.response });
  await assert.rejects(run, /8 MB/);
  assert.ok(source.state().sent <= 1, 'body is only prefetched, never consumed');assert.equal(source.state().cancelled, true);assert.equal(generated.length, 0);
});

test('agy aborts a streamed image that exceeds 8 MB without a content-length and stops pulling', async t => {
  const chunk = new Uint8Array(1_000_000);
  const source = stream(Array.from({ length: 50 }, () => chunk));
  const { run, generated } = await editWith(t, { fetchImpl: async () => source.response });
  await assert.rejects(run, /8 MB/);
  assert.equal(source.state().cancelled, true);assert.ok(source.state().sent <= 11, `pulled ${source.state().sent} chunks`);assert.equal(generated.length, 0);
  // Exactly at the cap is still accepted.
  const exact = await editWith(t, { fetchImpl: async () => stream(Array.from({ length: 8 }, () => chunk)).response });
  await exact.run();assert.equal(exact.generated.length, 1);
  const empty = await editWith(t, { fetchImpl: async () => stream([]).response });
  await assert.rejects(empty.run, /8 MB/);
});

test('agy refuses non-https, local and private reference hosts before any request, including IPv6 forms', async t => {
  const bad = ['http://img.example/a.png', 'https://localhost/a.png', 'https://LOCALHOST./a.png', 'https://api.localhost/a.png', 'https://user:pw@img.example/a.png',
    'https://127.0.0.1/a.png', 'https://127.1/a.png', 'https://2130706433/a.png', 'https://0x7f.0.0.1/a.png', 'https://0.0.0.0/a.png', 'https://10.0.0.5/a.png', 'https://172.16.0.1/a.png', 'https://172.31.255.255/a.png', 'https://192.168.1.1/a.png',
    'https://169.254.169.254/latest/meta-data', 'https://100.64.0.1/a.png', 'https://224.0.0.1/a.png', 'https://[::1]/a.png', 'https://[::]/a.png', 'https://[fe80::1]/a.png', 'https://[fc00::1]/a.png', 'https://[fd12:3456::1]/a.png',
    'https://[::ffff:127.0.0.1]/a.png', 'https://[::ffff:10.1.2.3]/a.png', 'https://[::ffff:a9fe:a9fe]/a.png', 'https://[64:ff9b::7f00:1]/a.png', 'https://[2002:7f00:1::]/a.png'];
  let fetched = 0;
  for (const url of bad) {
    const { run } = await editWith(t, { urls: [url], fetchImpl: async () => { fetched++; return stream([new Uint8Array(4)]).response; } });
    await assert.rejects(run, { status: 400 }, url);
  }
  assert.equal(fetched, 0);
  for (const url of ['https://8.8.8.8/a.png', 'https://172.32.0.1/a.png', 'https://[2606:4700:4700::1111]/a.png', 'https://[::ffff:8.8.8.8]/a.png']) {
    const { run, generated } = await editWith(t, { urls: [url], fetchImpl: async () => stream([new Uint8Array(4)]).response });
    await run();assert.equal(generated.length, 1, url);
  }
});

test('agy checks every DNS answer so a public name cannot point at a private address', async t => {
  let fetched = 0;
  const fetchImpl = async () => { fetched++; return stream([new Uint8Array(4)]).response; };
  const cases = [
    [{ address: '127.0.0.1', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.8', family: 4 }],
    [{ address: '::1', family: 6 }], [{ address: '2606:4700::1', family: 6 }, { address: 'fe80::1%eth0', family: 6 }], [{ address: '::ffff:192.168.0.1', family: 6 }], [],
  ];
  for (const answers of cases) {
    const { run } = await editWith(t, { fetchImpl, lookup: async () => answers });
    await assert.rejects(run, { status: 400 }, JSON.stringify(answers));
  }
  const unresolved = await editWith(t, { fetchImpl, lookup: async () => { throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); } });
  await assert.rejects(unresolved.run, /无法解析/);
  assert.equal(fetched, 0);
  const seen = [];
  const ok = await editWith(t, { fetchImpl, lookup: async (host, options) => { seen.push([host, options.all]); return [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800::1', family: 6 }]; } });
  await ok.run();assert.deepEqual(seen, [['img.example', true]]);assert.equal(fetched, 1);
});
