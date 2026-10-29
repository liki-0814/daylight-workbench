import { randomUUID } from 'node:crypto';
import { oauthError } from '../shared/oauth-account.js';
import { bindMediaModelSettings } from '../shared/model-settings.js';
import { IMAGE_BYTES, assertImageUrl, assertMediaOk, fail, imageResult, onlyKeys, readBytesLimited, readJsonLimited } from '../shared/media.js';
import { assertPublicImageUrl } from '../shared/remote-image.js';

const HOST = 'https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent';
export const agyMediaIds = ['gemini-3-pro-image', 'gemini-3.1-flash-image', 'gemini-3.1-flash-image-preview', 'gemini-2.5-flash-image-preview'];
const KEYS = new Set(['model', 'prompt', 'n', 'response_format', 'aspect_ratio', 'resolution', 'quality', 'image', 'images']);
const row = id => ({ id, displayName: id, output: 'image', status: 'ready', source: 'agy' });
const loginError = () => oauthError('请在 Daylight 中网页登录 AGY');

async function session(provider) {
  try { await provider.auth.token(); return provider.auth.identity; }
  catch { return null; }
}

async function inlineImage(url, { fetchImpl, lookup }, signal) {
  assertImageUrl(url);
  if (url.startsWith('data:')) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
    return { mimeType: match[1], data: match[2].replace(/\s/g, '') };
  }
  await assertPublicImageUrl(url, { lookup, signal });
  const response = await fetchImpl(url, { redirect: 'error', signal });
  if (!response.ok) { await response.body?.cancel(); fail('参考图无法读取'); }
  const type = response.headers.get('content-type')?.split(';')[0];
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) { await response.body?.cancel(); fail('参考图格式无效'); }
  const bytes = await readBytesLimited(response, IMAGE_BYTES, '单张图片不能超过 8 MB');
  if (!bytes.length) fail('单张图片不能超过 8 MB');
  return { mimeType: type, data: bytes.toString('base64') };
}

export function attachAgyMedia(provider) {
  provider.mediaOwns = model => agyMediaIds.includes(model);
  provider.mediaLoginError = async () => await session(provider) ? null : loginError();
  provider.mediaModels = async () => await session(provider) ? agyMediaIds.map(row) : [];
  bindMediaModelSettings(provider);
  provider.executeMedia = (input, context) => execute(provider, input, context);
}

async function execute(provider, { operation, body, model }, { signal, observe = () => {} }) {
  if (operation !== 'image.generate' && operation !== 'image.edit') fail('AGY 没有视频生成');
  onlyKeys(body, KEYS);
  if (body.quality !== undefined) fail('AGY 图像不支持 quality');
  if (body.resolution !== undefined && !['1k', '2k'].includes(body.resolution)) fail('resolution 无效');
  if (typeof body.prompt !== 'string' || !body.prompt) fail('prompt 无效');
  const format = body.response_format ?? 'b64_json';
  if (format !== 'url' && format !== 'b64_json') fail('response_format 无效');
  if (body.n !== undefined && body.n !== 1) fail('n 超出允许范围');
  const parts = [{ text: body.prompt }];
  if (operation === 'image.edit') {
    const single = body.image !== undefined, many = body.images !== undefined;
    if (single === many) fail('image 与 images 必须二选一');
    const list = single ? [body.image] : body.images;
    if (!Array.isArray(list) || !list.length || list.length > 5) fail('图片数量无效');
    for (const item of list) {
      if (!item || typeof item !== 'object' || item.type !== 'image_url') fail('图片格式无效');
      parts.push({ inlineData: await inlineImage(item.url, provider, signal) });
    }
  }
  const imageConfig = {};
  if (body.aspect_ratio !== undefined) imageConfig.aspectRatio = body.aspect_ratio;
  if (body.resolution !== undefined) imageConfig.imageSize = body.resolution === '1k' ? '1K' : '2K';
  const catalog = await provider.catalog();
  const identity = provider.auth.identity, epoch = provider.auth.epoch;
  observe({ stage: 'upstream' });
  const response = await provider.fetchImpl(HOST, {
    method: 'POST', redirect: 'error', signal,
    headers: { Authorization: `Bearer ${await provider.auth.token()}`, 'Content-Type': 'application/json', 'User-Agent': 'antigravity/hub/2.8.0' },
    body: JSON.stringify({ project: catalog.project, model, userAgent: 'antigravity', requestId: randomUUID(), request: { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['IMAGE'], ...(Object.keys(imageConfig).length ? { imageConfig } : {}) } } }),
  });
  if (provider.auth.identity !== identity || provider.auth.epoch !== epoch) throw loginError();
  if (response.status === 401) { await response.body?.cancel(); observe({ stage: 'authentication', retries: 1 }); await provider.auth.token(true); fail('AGY 登录已失效，请重新网页登录', 401, 'unauthorized'); }
  await assertMediaOk(response);
  const payload = await readJsonLimited(response);
  const envelope = payload.response || payload;
  const inline = [];
  for (const candidate of envelope.candidates || []) for (const part of candidate.content?.parts || []) if (part.inlineData?.data) inline.push({ b64_json: part.inlineData.data });
  if (format === 'url') fail('上游没有返回图像地址。不要用同一描述立即重试，请先到来源网页确认这次是否已经生成', 502, 'response_format_unavailable');
  return imageResult(payload, 'b64_json', inline);
}
