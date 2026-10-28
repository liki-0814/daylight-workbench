import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GrokProvider } from '../proxy/grok/provider.js';
import { createMediaJobs } from '../proxy/shared/media-jobs.js';

test('grok image edits reject bad urls and a failed video does not keep the upstream message', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'daylight-grok-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let videoCalls = 0;
  const provider = new GrokProvider({ dataDir: dir, auth: { credential: async () => ({ token: 't', identity: 'user-1', version: '1.0.41' }) }, fetchImpl: async (url, opts) => {
    if (url.endsWith('/videos/req-fail')) { videoCalls += 1; return Response.json({ status: 'failed', error: { code: 'content_filter', message: 'secret prompt' } }); }
    if (opts.body?.includes('images/edits') || url.endsWith('/images/edits')) return Response.json({ data: [{ url: 'https://imgen.x.ai/edited.jpeg' }] });
    return Response.json({ data: [{ url: 'https://imgen.x.ai/a.jpeg' }] });
  } });
  await assert.rejects(() => provider.executeMedia({ operation: 'image.edit', body: { model: 'grok-imagine-image-2.0', prompt: 'x', image: { type: 'image_url', url: 'file:///tmp/a.png' } }, model: 'grok-imagine-image-2.0' }, { signal: AbortSignal.timeout(1000), observe() {} }), { status: 400 });
  const many = Array.from({ length: 6 }, () => ({ type: 'image_url', url: 'https://example.com/a.png' }));
  await assert.rejects(() => provider.executeMedia({ operation: 'image.edit', body: { model: 'grok-imagine-image-2.0', prompt: 'x', images: many }, model: 'grok-imagine-image-2.0' }, { signal: AbortSignal.timeout(1000), observe() {} }), { status: 400 });
  const edited = await provider.executeMedia({ operation: 'image.edit', body: { model: 'grok-imagine-image-2.0', prompt: 'pencil', image: { type: 'image_url', url: 'https://example.com/a.png' } }, model: 'grok-imagine-image-2.0' }, { signal: AbortSignal.timeout(1000), observe() {} });
  assert.equal(edited.data[0].url, 'https://imgen.x.ai/edited.jpeg');
  const jobs = createMediaJobs(dir);
  const job = await jobs.create({ provider: 'grok', account: 'user-1', model: 'grok-imagine-video-1.5', upstreamId: 'req-fail' });
  const failed = await provider.executeMedia({ operation: 'video.poll', body: { id: job.id }, model: job.model }, { signal: AbortSignal.timeout(1000), observe() {}, jobs });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.url, undefined);
  const stored = await jobs.get(job.id);
  assert.equal(stored.errorCode, 'content_filter');
  assert.equal(JSON.stringify(stored).includes('secret prompt'), false);
  await provider.executeMedia({ operation: 'video.poll', body: { id: job.id }, model: job.model }, { signal: AbortSignal.timeout(1000), observe() {}, jobs });
  assert.equal(videoCalls, 1);
  const loggedOut = new GrokProvider({ dataDir: dir, auth: { credential: async () => { throw Object.assign(new Error('请在 Daylight 中网页登录 Grok'), { status: 401 }); } }, fetchImpl: async () => { throw new Error('network'); } });
  assert.deepEqual(await loggedOut.mediaModels(), []);
});
