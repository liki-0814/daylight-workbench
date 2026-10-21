import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateImages } from '../ai/images.mjs';
import { createQuickAnswers } from '../ai/quick.mjs';
import { createAIService } from '../ai/service.mjs';
import { AIStore } from '../ai/store.mjs';
import { promptContent } from '../ai/adapters/qoder.mjs';

const png = size => { const bytes = Buffer.alloc(size || 16); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes); return { mimeType: 'image/png', data: bytes.toString('base64') }; };
const settings = { backend: 'qoder', qoder: { model: 'm' } };
test('image input bounds count, bytes, MIME, canonical encoding and file signatures', () => {
  assert.deepEqual(validateImages([png()]), [png()]);
  assert.equal(validateImages([png(2_000_000)])[0].data.length, png(2_000_000).data.length);
  for (const input of [null, {}, Array(5).fill(png()), [{ ...png(), mimeType: 'image/svg+xml' }], [{ ...png(), mimeType: 'image/jpeg' }], [{ mimeType: 'image/png', data: 'not base64' }], [{ mimeType: 'image/png', data: 'a===' }], [png(1_100_000), png(1_100_000)]]) assert.throws(() => validateImages(input));
});
test('image-only quick answers reach the provider without creating conversation history', async () => {
  let received;
  const quick = createQuickAnswers({ store: { settings }, providers: { qoder: { run: async args => { received = args; } } } });
  try {
    const job = quick.start({ text: '', images: [png()] });
    for (let i=0; i<100; i++) { if (quick.get(job.id).status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.deepEqual(received.images, [png()]); assert.match(received.text, /图片/); assert.equal(received.ephemeral, true);
    assert.throws(() => quick.get(job.id), error => error.status === 404);
  } finally { await quick.close(); }
});
test('quick image HTTP input permits valid payloads over 1 MB and still keeps normal API body limits', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'daylight-image-http-'));
  new AIStore(dir).write('settings.json', settings);
  let received;
  const ai = await createAIService({ dataDir: dir, adapters: { qoder: { run: async args => { received = args; } } } });
  const server = http.createServer(ai.handle); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await ai.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(dir, { recursive: true, force: true }); });
  const post = (route, body) => fetch(`http://127.0.0.1:${server.address().port}/api/ai/${route}`, { method: 'POST', body: JSON.stringify(body) });
  const image = png(1_050_000), response = await post('quick', { text: '识别图片', images: [image] });
  assert.equal(response.status, 200); assert.deepEqual(received.images, [image]);
  assert.equal((await post('settings', { padding: 'x'.repeat(1_000_001) })).status, 400);
  assert.deepEqual(await readdir(path.join(dir, 'ai/conversations')), []);
});
test('Qoder receives native image blocks alongside text while text-only callers remain unchanged', () => {
  assert.equal(promptContent('text'), 'text');
  assert.deepEqual(promptContent('text', [png()]), [{ type: 'text', text: 'text' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png().data } }]);
});
