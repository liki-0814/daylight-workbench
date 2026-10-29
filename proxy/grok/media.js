import { bindMediaModelSettings } from '../shared/model-settings.js';
import { randomUUID } from 'node:crypto';
import { authError } from './auth.js';
import { assertImageUrl, assertMediaOk, fail, imageBudget, imageResult, onlyKeys, readJsonLimited } from '../shared/media.js';

const ORIGIN = 'https://cli-chat-proxy.grok.com/v1';
const IMAGES = ['grok-imagine-image-2.0', 'grok-imagine-image', 'grok-imagine-image-quality'];
const VIDEOS = ['grok-imagine-video-1.5', 'grok-imagine-video-1.5-lite', 'grok-imagine-video'];
const RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20', '21:9', '5:2', 'auto']);
const VIDEO_RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '5:2']);
const IMAGE_KEYS = new Set(['model', 'prompt', 'n', 'response_format', 'aspect_ratio', 'resolution', 'quality']);
const EDIT_KEYS = new Set(['model', 'prompt', 'image', 'images', 'aspect_ratio', 'resolution', 'quality', 'response_format']);
const VIDEO_KEYS = new Set(['model', 'prompt', 'duration', 'aspect_ratio', 'resolution', 'image', 'reference_images', 'reference_audios', 'last_frame', 'keyframes', 'generate_audio']);
const VIDEO_REJECTED = ['voices', 'voice', 'first_frame', 'extend', 'video', 'video_url', 'mode', 'size', 'n', 'response_format', 'file_id', 'seed', 'negative_prompt', 'seconds'];
// Fields whose upstream name differs from a plausible client spelling: say which one to use instead of a bare "unsupported".
const VIDEO_REDIRECTS = {
  voices: 'voices 不被支持，请改用 reference_audios（例如 [{"voice_id":"eve"}]）',
  voice: 'voice 不被支持，请改用 reference_audios（例如 [{"voice_id":"eve"}]）',
  first_frame: 'first_frame 不被支持，首帧请使用 image',
};
// Upstream limits per model (docs.x.ai video overview / reference-to-video). `refDuration` caps duration only when reference_images are sent.
const VIDEO_CAPS = {
  'grok-imagine-video-1.5': { resolutions: ['480p', '720p', '1080p'], refs: 14, voices: 3, lastFrame: true, keyframes: 4, refDuration: 15, imageWithRefs: true },
  'grok-imagine-video-1.5-lite': { resolutions: ['480p', '720p', '1080p'], refs: 0, voices: 0, lastFrame: false, keyframes: 0, refDuration: 15, imageWithRefs: false },
  'grok-imagine-video': { resolutions: ['480p', '720p'], refs: 7, voices: 0, lastFrame: false, keyframes: 0, refDuration: 10, imageWithRefs: false },
};
const VIDEO_DEFAULT_DURATION = 8;

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

function videoImage(value, budget, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'url')) fail(`${label} 只接受 { url }`);
  budget(assertImageUrl(value.url));
  return { url: value.url };
}

function videoList(value, label, max, model) {
  if (!Array.isArray(value) || !value.length) fail(`${label} 需要非空数组`);
  if (!max) fail(`${model} 不支持 ${label}`);
  if (value.length > max) fail(`${label} 最多 ${max} 项`);
  return value;
}

// Validates a client video body against the model's caps and returns the exact upstream body. Anything not named here is never forwarded.
function videoUpstream(body, model) {
  const caps = VIDEO_CAPS[model];
  if (!caps) fail('模型不是视频模型');
  for (const key of VIDEO_REJECTED) if (body[key] !== undefined) fail(VIDEO_REDIRECTS[key] || `不支持的字段：${key}`);
  onlyKeys(body, VIDEO_KEYS);
  const budget = imageBudget();
  const pinned = body.image !== undefined || body.reference_images !== undefined || body.last_frame !== undefined || body.keyframes !== undefined;
  if (body.prompt === undefined ? !pinned : typeof body.prompt !== 'string' || !body.prompt) fail(body.prompt === undefined ? 'prompt 无效：未提供 image、reference_images、last_frame 或 keyframes 时必填' : 'prompt 无效');
  if (body.duration !== undefined && (!Number.isInteger(body.duration) || body.duration < 1 || body.duration > 15)) fail('duration 无效');
  if (body.aspect_ratio !== undefined && !VIDEO_RATIOS.has(body.aspect_ratio)) fail('aspect_ratio 无效');
  if (body.resolution !== undefined && !caps.resolutions.includes(body.resolution)) fail('resolution 无效');
  if (body.generate_audio !== undefined && typeof body.generate_audio !== 'boolean') fail('generate_audio 必须是布尔值');
  const upstream = { model, ...(body.prompt !== undefined ? { prompt: body.prompt } : {}), ...(body.duration ? { duration: body.duration } : {}), ...(body.aspect_ratio ? { aspect_ratio: body.aspect_ratio } : {}), ...(body.resolution ? { resolution: body.resolution } : {}) };
  if (body.image !== undefined) upstream.image = videoImage(body.image, budget, 'image');
  if (body.reference_images !== undefined) {
    const list = videoList(body.reference_images, 'reference_images', caps.refs, model);
    if (body.image !== undefined && !caps.imageWithRefs) fail(`${model} 不支持同时传 image 与 reference_images`);
    if (body.duration !== undefined && body.duration > caps.refDuration) fail(`${model} 带参考图时 duration 最长 ${caps.refDuration} 秒`);
    upstream.reference_images = list.map((item, index) => videoImage(item, budget, `reference_images[${index}]`));
  }
  if (body.reference_audios !== undefined) {
    const list = videoList(body.reference_audios, 'reference_audios', caps.voices, model);
    upstream.reference_audios = list.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => key !== 'voice_id') || typeof item.voice_id !== 'string' || !item.voice_id.trim()) fail(`reference_audios[${index}] 只接受 { voice_id }`);
      return { voice_id: item.voice_id };
    });
  }
  if (body.last_frame !== undefined) {
    if (!caps.lastFrame) fail(`${model} 不支持 last_frame`);
    upstream.last_frame = videoImage(body.last_frame, budget, 'last_frame');
  }
  if (body.keyframes !== undefined) {
    const list = videoList(body.keyframes, 'keyframes', caps.keyframes, model);
    const duration = body.duration ?? VIDEO_DEFAULT_DURATION, slots = new Set();
    upstream.keyframes = list.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => key !== 'image' && key !== 'timestamp_s')) fail(`keyframes[${index}] 只接受 image 与 timestamp_s`);
      if (typeof item.timestamp_s !== 'number' || !Number.isFinite(item.timestamp_s) || item.timestamp_s <= 0 || item.timestamp_s >= duration) fail(`keyframes[${index}].timestamp_s 必须大于 0 且小于 duration`);
      const slot = Math.round(item.timestamp_s * 3);
      if (slots.has(slot)) fail('keyframes 的时间点至少相隔 1/3 秒');
      slots.add(slot);
      return { image: videoImage(item.image, budget, `keyframes[${index}].image`), timestamp_s: item.timestamp_s };
    });
  }
  if (body.generate_audio !== undefined) upstream.generate_audio = body.generate_audio;
  return upstream;
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
    const upstream = videoUpstream(body, model);
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
  const moderated = payload.status === 'done' && payload.video?.respect_moderation === false;
  const status = moderated ? 'failed' : response.status === 202 || payload.status === 'pending' ? 'in_progress' : payload.status === 'done' && payload.video?.url ? 'succeeded' : payload.status === 'failed' ? 'failed' : payload.status === 'expired' ? 'expired' : 'in_progress';
  const errorCode = moderated ? 'moderation_rejected' : status === 'failed' && typeof payload.error?.code === 'string' ? payload.error.code : undefined;
  const next = { ...job, status, updatedAt: new Date().toISOString(), ...(status === 'succeeded' ? { outputUrl: payload.video.url } : {}), ...(errorCode ? { errorCode } : {}) };
  delete next.error;
  await jobs.save(next);
  return publicJob(next);
}

function publicJob(job) {
  return { id: job.id, object: 'video', status: job.status, model: job.model, source: 'grok', ...(job.status === 'succeeded' ? { url: job.outputUrl } : {}) };
}
