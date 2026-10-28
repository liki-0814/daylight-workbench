import { bindMediaModelSettings } from '../shared/model-settings.js';
import { randomUUID } from 'node:crypto';
import { authError } from './auth.js';
import { assertImageUrl, assertMediaOk, fail, imageResult, onlyKeys, readJsonLimited } from '../shared/media.js';

const ORIGIN = 'https://cli-chat-proxy.grok.com/v1';
const IMAGES = ['grok-imagine-image-2.0', 'grok-imagine-image', 'grok-imagine-image-quality'];
const VIDEOS = ['grok-imagine-video-1.5', 'grok-imagine-video-1.5-lite', 'grok-imagine-video'];
const RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20', '21:9', '5:2', 'auto']);
const VIDEO_RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '5:2']);
const IMAGE_KEYS = new Set(['model', 'prompt', 'n', 'response_format', 'aspect_ratio', 'resolution', 'quality']);
const EDIT_KEYS = new Set(['model', 'prompt', 'image', 'images', 'aspect_ratio', 'resolution', 'quality', 'response_format']);
const VIDEO_KEYS = new Set(['model', 'prompt', 'duration', 'aspect_ratio', 'resolution', 'image']);
const VIDEO_REJECTED = ['reference_images', 'voices', 'voice', 'first_frame', 'last_frame', 'keyframes', 'extend', 'video', 'mode', 'size', 'n', 'response_format', 'file_id'];

const row = (id, output) => ({ id, displayName: id, output, status: 'ready', source: 'grok' });
export const grokMediaIds = new Set([...IMAGES, ...VIDEOS]);

async function loggedIn(provider) {
  try { return await provider.auth.credential(); }
  catch { return null; }
}

function formatOf(body) {
  const format = body.response_format ?? 'url';
  if (format !== 'url' && format !== 'b64_json') fail('response_format 无效');
  return format;
}

function count(body, format) {
  const n = body.n ?? 1;
  if (!Number.isInteger(n) || n < 1 || (format === 'b64_json' ? n !== 1 : n > 10)) fail('n 超出允许范围');
  return n;
}

function imageField(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('图片格式无效');
  if (value.type !== 'image_url' || Object.keys(value).some(key => key !== 'type' && key !== 'url')) fail('图片格式无效');
  assertImageUrl(value.url);
  return { type: 'image_url', url: value.url };
}

function imageOptions(body) {
  if (body.aspect_ratio !== undefined && !RATIOS.has(body.aspect_ratio)) fail('aspect_ratio 无效');
  if (body.resolution !== undefined && !['1k', '2k'].includes(body.resolution)) fail('resolution 无效');
  if (body.quality !== undefined && !['low', 'medium', 'auto'].includes(body.quality)) fail('quality 无效');
}

async function jsonCall(provider, endpoint, body, signal, observe) {
  const send = async (credential, retried) => {
    observe({ stage: 'upstream' });
    const response = await provider.fetchImpl(`${ORIGIN}/${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${credential.token}`, 'X-XAI-Token-Auth': 'xai-grok-cli', 'x-grok-client-identifier': 'grok-shell', 'x-grok-client-version': credential.version, 'Content-Type': 'application/json', Accept: 'application/json', 'x-grok-req-id': randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 401 && !retried) {
      await response.body?.cancel();
      observe({ stage: 'authentication', retries: 1 });
      const fresh = await provider.auth.credential(true);
      if (fresh.identity !== credential.identity) throw authError();
      return send(fresh, true);
    }
    return response;
  };
  return send(await provider.auth.credential(), false);
}

export function attachGrokMedia(provider) {
  provider.mediaOwns = model => grokMediaIds.has(model);
  provider.mediaLoginError = async () => await loggedIn(provider) ? null : authError();
  provider.mediaModels = async () => await loggedIn(provider) ? [...IMAGES.map(id => row(id, 'image')), ...VIDEOS.map(id => row(id, 'video'))] : [];
  bindMediaModelSettings(provider);
  provider.executeMedia = (input, context) => execute(provider, input, context);
}

async function execute(provider, { operation, body, model }, { signal, observe = () => {}, jobs }) {
  const credential = await provider.auth.credential();
  if (operation === 'image.generate') {
    onlyKeys(body, IMAGE_KEYS);
    imageOptions(body);
    const format = formatOf(body), n = count(body, format);
    if (typeof body.prompt !== 'string' || !body.prompt) fail('prompt 无效');
    const upstream = { model, prompt: body.prompt, n, ...(body.response_format ? { response_format: format } : {}), ...(body.aspect_ratio ? { aspect_ratio: body.aspect_ratio } : {}), ...(body.resolution ? { resolution: body.resolution } : {}), ...(body.quality ? { quality: body.quality } : {}) };
    const response = await jsonCall(provider, 'images/generations', upstream, signal, observe);
    await assertMediaOk(response);
    const payload = await readJsonLimited(response);
    return imageResult(payload, format, payload.data || []);
  }
  if (operation === 'image.edit') {
    onlyKeys(body, EDIT_KEYS);
    imageOptions(body);
    const format = formatOf(body);
    if (body.n !== undefined) fail('编辑不接受 n');
    if (typeof body.prompt !== 'string' || !body.prompt) fail('prompt 无效');
    const single = body.image !== undefined, many = body.images !== undefined;
    if (single === many) fail('image 与 images 必须二选一');
    const images = single ? [imageField(body.image)] : body.images;
    if (!single && (!Array.isArray(images) || images.length < 2 || images.length > 5)) fail('images 需要 2 到 5 张图片');
    const normalized = single ? images : images.map(imageField);
    const upstream = { model, prompt: body.prompt, ...(single ? { image: normalized[0] } : { images: normalized }), ...(body.response_format ? { response_format: format } : {}), ...(body.aspect_ratio ? { aspect_ratio: body.aspect_ratio } : {}), ...(body.resolution ? { resolution: body.resolution } : {}), ...(body.quality ? { quality: body.quality } : {}) };
    const response = await jsonCall(provider, 'images/edits', upstream, signal, observe);
    await assertMediaOk(response);
    const payload = await readJsonLimited(response);
    return imageResult(payload, format, payload.data || []);
  }
  if (operation === 'video.submit') {
    for (const key of VIDEO_REJECTED) if (body[key] !== undefined) fail(`不支持的字段：${key}`);
    onlyKeys(body, VIDEO_KEYS);
    if (typeof body.prompt !== 'string' || !body.prompt) fail('prompt 无效');
    if (body.duration !== undefined && (!Number.isInteger(body.duration) || body.duration < 1 || body.duration > 15)) fail('duration 无效');
    if (body.aspect_ratio !== undefined && !VIDEO_RATIOS.has(body.aspect_ratio)) fail('aspect_ratio 无效');
    if (body.resolution !== undefined && !['480p', '720p', '1080p'].includes(body.resolution)) fail('resolution 无效');
    if (body.image !== undefined) {
      if (!body.image || typeof body.image !== 'object' || Array.isArray(body.image) || Object.keys(body.image).some(key => key !== 'url')) fail('视频参考图只接受 url');
      assertImageUrl(body.image.url);
    }
    const upstream = { model, prompt: body.prompt, ...(body.duration ? { duration: body.duration } : {}), ...(body.aspect_ratio ? { aspect_ratio: body.aspect_ratio } : {}), ...(body.resolution ? { resolution: body.resolution } : {}), ...(body.image ? { image: { url: body.image.url } } : {}) };
    const response = await jsonCall(provider, 'videos/generations', upstream, signal, observe);
    await assertMediaOk(response);
    const payload = await readJsonLimited(response);
    if (typeof payload.request_id !== 'string' || !payload.request_id) fail('上游没有返回视频任务号', 502, 'invalid_upstream');
    const job = await jobs.create({ provider: 'grok', account: credential.identity, model, upstreamId: payload.request_id });
    return { id: job.id, object: 'video', status: 'in_progress', model, source: 'grok' };
  }
  const job = await jobs.get(body.id);
  if (!job || job.provider !== 'grok') fail('任务不存在', 404, 'job_not_found');
  if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'expired') return publicJob(job);
  const response = await jsonCall(provider, `videos/${encodeURIComponent(job.upstreamId)}`, undefined, signal, observe);
  await assertMediaOk(response);
  const payload = await readJsonLimited(response);
  const status = response.status === 202 || payload.status === 'pending' ? 'in_progress' : payload.status === 'done' && payload.video?.url ? 'succeeded' : payload.status === 'failed' ? 'failed' : payload.status === 'expired' ? 'expired' : 'in_progress';
  const next = { ...job, status, updatedAt: new Date().toISOString(), ...(status === 'succeeded' ? { outputUrl: payload.video.url } : {}), ...(status === 'failed' && typeof payload.error?.code === 'string' ? { errorCode: payload.error.code } : {}) };
  delete next.error;
  await jobs.save(next);
  return publicJob(next);
}

function publicJob(job) {
  return { id: job.id, object: 'video', status: job.status, model: job.model, source: 'grok', ...(job.status === 'succeeded' ? { url: job.outputUrl } : {}) };
}
