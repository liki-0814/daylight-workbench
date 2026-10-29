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

test('grok video submit passes supported reference inputs per model and rejects what upstream or the model cannot take', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'daylight-grok-video-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sent = [];
  const provider = new GrokProvider({ dataDir: dir, auth: { credential: async () => ({ token: 't', identity: 'user-1', version: '1.0.41' }) }, fetchImpl: async (url, opts) => {
    if (url.endsWith('/videos/generations')) { sent.push(JSON.parse(opts.body)); return Response.json({ request_id: `req-${sent.length}` }); }
    if (url.endsWith('/videos/req-moderated')) return Response.json({ status: 'done', video: { url: 'https://vidgen.x.ai/a.mp4', respect_moderation: false } });
    throw new Error('unexpected ' + url);
  } });
  const jobs = createMediaJobs(dir);
  const submit = (model, body) => provider.executeMedia({ operation: 'video.submit', body: { model, ...body }, model }, { signal: AbortSignal.timeout(1000), observe() {}, jobs });
  const reject = async (model, body, pattern) => {
    const before = sent.length;
    await assert.rejects(() => submit(model, body), error => error.status === 400 && (!pattern || pattern.test(error.message)));
    assert.equal(sent.length, before);
  };
  const png = bytes => `data:image/png;base64,${Buffer.alloc(bytes, 1).toString('base64')}`;
  const url = n => ({ url: `https://example.com/${n}.png` });
  const V15 = 'grok-imagine-video-1.5', LITE = 'grok-imagine-video-1.5-lite', CLASSIC = 'grok-imagine-video';

  // 1.5: every supported field is forwarded exactly; the prompt is optional once an image input is present.
  const full = { prompt: 'p', duration: 15, aspect_ratio: '9:16', resolution: '720p', generate_audio: false, reference_images: Array.from({ length: 14 }, (_, i) => url(i)), reference_audios: [{ voice_id: 'eve' }, { voice_id: 'ara' }, { voice_id: 'leo' }] };
  assert.equal((await submit(V15, full)).status, 'in_progress');
  assert.deepEqual(sent.at(-1), { model: V15, ...full });
  await submit(V15, { reference_images: [url(1)] });
  assert.deepEqual(sent.at(-1), { model: V15, reference_images: [url(1)] });
  await submit(V15, { image: url('first'), last_frame: url('last'), keyframes: [{ image: url('k1'), timestamp_s: 2 }, { image: url('k2'), timestamp_s: 4.333 }] });
  assert.equal(sent.at(-1).prompt, undefined);
  assert.deepEqual(sent.at(-1).last_frame, url('last'));
  assert.equal(sent.at(-1).keyframes.length, 2);
  await submit(V15, { prompt: 'x', image: url('a'), reference_images: [url('b')] });
  await submit(V15, { prompt: 'x', generate_audio: true });
  assert.equal(sent.at(-1).generate_audio, true);

  // Field validation on 1.5.
  await reject(V15, {}, /prompt/);
  await reject(V15, { reference_audios: [{ voice_id: 'eve' }] }, /prompt/);
  await reject(V15, { prompt: '' , image: url(1) }, /prompt/);
  await reject(V15, { prompt: 'x', reference_images: [] });
  await reject(V15, { prompt: 'x', reference_images: Array.from({ length: 15 }, (_, i) => url(i)) }, /14/);
  await reject(V15, { prompt: 'x', reference_images: ['https://example.com/a.png'] });
  await reject(V15, { prompt: 'x', reference_images: [{ url: 'https://example.com/a.png', extra: 1 }] });
  await reject(V15, { prompt: 'x', reference_images: [{ url: 'file:///tmp/a.png' }] });
  await reject(V15, { prompt: 'x', reference_audios: [{ voice_id: 'eve' }, { voice_id: 'a' }, { voice_id: 'b' }, { voice_id: 'c' }] }, /3/);
  await reject(V15, { prompt: 'x', reference_audios: [{ url: 'https://example.com/a.mp3' }] });
  await reject(V15, { prompt: 'x', reference_audios: [{ voice_id: '' }] });
  await reject(V15, { prompt: 'x', generate_audio: 'false' }, /generate_audio/);
  await reject(V15, { prompt: 'x', last_frame: 'https://example.com/a.png' });
  await reject(V15, { prompt: 'x', keyframes: Array.from({ length: 5 }, (_, i) => ({ image: url(i), timestamp_s: i + 1 })) }, /4/);
  await reject(V15, { prompt: 'x', duration: 5, keyframes: [{ image: url(1), timestamp_s: 5 }] }, /timestamp_s/);
  await reject(V15, { prompt: 'x', keyframes: [{ image: url(1), timestamp_s: 0 }] }, /timestamp_s/);
  await reject(V15, { prompt: 'x', keyframes: [{ image: url(1), timestamp_s: 'a' }] }, /timestamp_s/);
  await reject(V15, { prompt: 'x', keyframes: [{ image: url(1), timestamp_s: 2 }, { image: url(2), timestamp_s: 2.1 }] }, /1\/3/);
  await reject(V15, { prompt: 'x', keyframes: [{ image: url(1), timestamp_s: 2, extra: 1 }] });
  await reject(V15, { prompt: 'x', duration: 16 }, /duration/);

  // Still-unsupported fields; voices/voice point at reference_audios, first_frame at image.
  await reject(V15, { prompt: 'x', voices: ['eve'] }, /reference_audios/);
  await reject(V15, { prompt: 'x', voice: 'eve' }, /reference_audios/);
  await reject(V15, { prompt: 'x', first_frame: url(1) }, /image/);
  for (const key of ['extend', 'video', 'video_url', 'mode', 'size', 'n', 'response_format', 'file_id', 'seed', 'negative_prompt', 'unknown']) await reject(V15, { prompt: 'x', [key]: 1 }, /不支持的字段/);

  // lite takes no reference inputs; classic has its own caps.
  await reject(LITE, { prompt: 'x', reference_images: [url(1)] }, /不支持/);
  await reject(LITE, { prompt: 'x', reference_audios: [{ voice_id: 'eve' }] }, /不支持/);
  await reject(LITE, { prompt: 'x', last_frame: url(1) }, /不支持/);
  await reject(LITE, { prompt: 'x', keyframes: [{ image: url(1), timestamp_s: 2 }] }, /不支持/);
  await submit(LITE, { prompt: 'x', image: url(1), duration: 15, resolution: '1080p' });
  await reject(CLASSIC, { prompt: 'x', resolution: '1080p' }, /resolution/);
  await reject(CLASSIC, { prompt: 'x', reference_images: Array.from({ length: 8 }, (_, i) => url(i)) }, /7/);
  await reject(CLASSIC, { prompt: 'x', duration: 11, reference_images: [url(1)] }, /10/);
  await reject(CLASSIC, { prompt: 'x', image: url(1), reference_images: [url(2)] }, /image/);
  await reject(CLASSIC, { prompt: 'x', reference_audios: [{ voice_id: 'eve' }] }, /不支持/);
  await reject(CLASSIC, { prompt: 'x', last_frame: url(1) }, /不支持/);
  await submit(CLASSIC, { prompt: 'x', duration: 10, resolution: '720p', reference_images: Array.from({ length: 7 }, (_, i) => url(i)) });
  await submit(CLASSIC, { prompt: 'x', duration: 15 });
  await reject('grok-imagine-image-2.0', { prompt: 'x' }, /视频模型/);

  // Embedded data URIs: 8 MB each, ~40 MB in total per request; https URLs do not count.
  const big = { url: png(7_900_000) };
  await submit(V15, { prompt: 'x', reference_images: [big, big, big, big, big] });
  await reject(V15, { prompt: 'x', reference_images: [big, big, big, big, big, big] }, /40 MB/);
  await reject(V15, { prompt: 'x', image: big, last_frame: big, reference_images: [big, big, big, big] }, /40 MB/);
  await reject(V15, { prompt: 'x', reference_images: [{ url: png(8_100_000) }] }, /8 MB/);
  await submit(V15, { prompt: 'x', reference_images: [big, big, big, big, big, ...Array.from({ length: 9 }, (_, i) => url(i))] });

  // A done video that the upstream flags as not respecting moderation is a failure, not a success.
  const job = await jobs.create({ provider: 'grok', account: 'user-1', model: V15, upstreamId: 'req-moderated' });
  const moderated = await provider.executeMedia({ operation: 'video.poll', body: { id: job.id }, model: V15 }, { signal: AbortSignal.timeout(1000), observe() {}, jobs });
  assert.equal(moderated.status, 'failed');
  assert.equal(moderated.url, undefined);
  assert.equal((await jobs.get(job.id)).errorCode, 'moderation_rejected');
});
