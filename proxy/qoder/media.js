import { uuid } from '../shared/utils.js';
import { loadSettings, saveSettings } from './models.js';
import { sessionFromAccount } from './transport.js';
import { bindMediaModelSettings, updateModelSetting } from '../shared/model-settings.js';
import { assertMediaOk, fail, imageResult, onlyKeys, readJsonLimited } from '../shared/media.js';
import { encodeBody } from './body-codec.js';

// Qoder 的媒体接口走 COSY 签名的 /algo/api/v2/service/pro，请求体用与聊天相同的 encodeBody。
// 客户端 id 是对外名字，upstream 是探针里确认过的上游模型串。
const IMAGE_PATH = '/algo/api/v2/service/pro/generateImage?Encode=1';
const VIDEO_PATH = '/algo/api/v2/service/pro/videos';
const VIDEO_SUBMIT_PATH = `${VIDEO_PATH}?Encode=1`;
export const QODER_MEDIA = [
  { id: 'qwen-image-3.0', upstream: 'ge3i', aliases: ['ge3i'], output: 'image', displayName: 'Qwen-Image 3.0 (映射待确认)', note: '上游代号 ge3i，对应 Qwen-Image 3.0 大概率但未确认 · 团队 Credits 计费，实测约 4 / 张' },
  { id: 'wan3.0-video', upstream: 'wan30', aliases: ['wan30'], output: 'video', displayName: '万相 3.0', note: '上游代号 wan30 · 团队 Credits 计费，实测 5 秒 720p 约 40 · 文生视频' },
];
export const qoderMediaIds = new Set(QODER_MEDIA.flatMap(item => [item.id, ...item.aliases]));
const IMAGE_SIZES = new Set(['1024x1024', '1536x1024', '1024x1536', '768x1024', '1024x768', '1024x1280', '1280x1024', '1024x1792', '1792x1024', '2560x1080']);
const VIDEO_SIZES = new Set(['1280x720', '1920x1080', '720x1280', '1080x1920', '720P', '1080P']);
const IMAGE_KEYS = new Set(['model', 'prompt', 'size', 'n', 'response_format']);
const VIDEO_KEYS = new Set(['model', 'prompt', 'duration', 'size']);
// 第一刀不做的视频模式与字段：显式 400，不删字段后继续发送。
const VIDEO_LATER = ['image', 'images', 'mode', 'input_reference', 'first_frame', 'last_frame', 'references', 'media', 'reference_images', 'seconds', 'resolution', 'aspect_ratio', 'n', 'response_format'];
const loginError = () => Object.assign(new Error('请在 Daylight 中登录 Qoder'), { status: 401, code: 'unauthenticated' });
const upstreamOf = id => QODER_MEDIA.find(item => item.id === id)?.upstream;
const row = item => ({ id: item.id, displayName: item.displayName, output: item.output, status: 'ready', source: 'qoder', aliases: item.aliases, note: item.note });

async function account(provider) {
  try { return await provider.accounts.load(); }
  catch { return null; }
}

export function attachQoderMedia(provider) {
  provider.mediaOwns = model => qoderMediaIds.has(model);
  provider.mediaLoginError = async () => await account(provider) ? null : loginError();
  provider.mediaModels = async () => await account(provider) ? QODER_MEDIA.map(row) : [];
  provider.settings = {
    read: () => loadSettings(provider.config.accountFile),
    save: (model, input, options) => provider.mutate(async () => {
      const settings = await loadSettings(provider.config.accountFile);
      updateModelSetting(settings, model, input, options);
      await saveSettings(provider.config.accountFile, settings);
    }),
  };
  bindMediaModelSettings(provider);
  provider.executeMedia = (input, context) => execute(provider, input, context);
}


// sessionId 必须是非空 UUID：空串会让视频提交返回 500。
async function post(provider, pathname, inner, signal, observe) {
  const current = await provider.ready();
  const session = sessionFromAccount(provider.config, current);
  const requestId = uuid();
  const envelope = { payload: JSON.stringify(inner), encodeVersion: '1', sessionId: uuid(), requestId };
  observe({ stage: 'upstream' });
  return { current, response: await provider.http.signedMedia(provider.http.algoUrl(pathname), { session, method: 'POST', body: encodeBody(envelope), requestId, signal }) };
}

function imageBody(body, model) {
  onlyKeys(body, IMAGE_KEYS);
  if (typeof body.prompt !== 'string' || !body.prompt || body.prompt.length > 20_000) fail('prompt 无效');
  if (body.n !== undefined && body.n !== 1) fail('Qoder 图像一次只生成一张，n 只能是 1');
  const format = body.response_format ?? 'b64_json';
  if (format !== 'b64_json') fail('Qoder 图像上游只返回图像数据，response_format 只支持 b64_json');
  const size = body.size ?? '1024x1024';
  if (!IMAGE_SIZES.has(size)) fail('size 无效');
  return { model: upstreamOf(model), prompt: body.prompt, size };
}

function videoBody(body, model) {
  for (const key of VIDEO_LATER) if (body[key] !== undefined) fail(`暂不支持：${key}（Qoder 视频目前只有文生视频，时长用 duration、尺寸用 size）`);
  onlyKeys(body, VIDEO_KEYS);
  if (typeof body.prompt !== 'string' || !body.prompt || body.prompt.length > 20_000) fail('prompt 无效');
  const duration = body.duration ?? 5;
  if (!Number.isInteger(duration) || duration < 2 || duration > 30) fail('duration 需要是 2 到 30 的整数');
  const size = body.size ?? '1280x720';
  if (!VIDEO_SIZES.has(size)) fail('size 无效');
  return { model: upstreamOf(model), prompt: body.prompt, seconds: String(duration), size };
}

// data URL 才是上游图像的形状；也容忍未来直接给 base64。https 地址不下载，也不假装成 b64。
function imageItems(payload) {
  return (Array.isArray(payload.data) ? payload.data : []).map(item => {
    const match = typeof item?.url === 'string' ? /^data:image\/[a-z0-9.+-]+;base64,(.+)$/is.exec(item.url) : null;
    return { b64_json: match?.[1] ?? (typeof item?.b64_json === 'string' ? item.b64_json : undefined) };
  });
}

const STATUS = { queued: 'in_progress', in_progress: 'in_progress', completed: 'succeeded', failed: 'failed' };

async function execute(provider, { operation, body, model }, { signal, observe = () => {}, jobs }) {
  if (operation === 'image.generate') {
    const inner = imageBody(body, model);
    const { response } = await post(provider, IMAGE_PATH, inner, signal, observe);
    await assertMediaOk(response);
    const payload = await readJsonLimited(response);
    return imageResult(payload, 'b64_json', imageItems(payload));
  }
  if (operation === 'image.edit') fail('Qoder 暂不支持图像编辑', 400, 'media_unsupported');
  if (operation === 'video.submit') {
    const inner = videoBody(body, model);
    const { current, response } = await post(provider, VIDEO_SUBMIT_PATH, inner, signal, observe);
    await assertMediaOk(response);
    const payload = await readJsonLimited(response);
    if (typeof payload.id !== 'string' || !payload.id) fail('上游没有返回视频任务号。不要再次提交，请先到 Qoder 用量页核对是否已经计费', 502, 'invalid_upstream');
    const job = await jobs.create({ provider: 'qoder', account: current.id, model, upstreamId: payload.id });
    return { id: job.id, object: 'video', status: 'in_progress', model, source: 'qoder' };
  }
  const job = await jobs.get(body.id);
  if (!job || job.provider !== 'qoder') fail('任务不存在', 404, 'job_not_found');
  if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'expired') return publicJob(job);
  const current = await provider.ready();
  const session = sessionFromAccount(provider.config, current);
  observe({ stage: 'upstream' });
  const response = await provider.http.signedMedia(provider.http.algoUrl(`${VIDEO_PATH}/${encodeURIComponent(job.upstreamId)}`), { session, method: 'GET', signal });
  await assertMediaOk(response);
  const payload = await readJsonLimited(response);
  let status = STATUS[payload.status] ?? 'in_progress';
  if (status === 'succeeded' && !(typeof payload.video_url === 'string' && payload.video_url.startsWith('https://'))) status = 'in_progress';
  const next = {
    ...job, status, updatedAt: new Date().toISOString(),
    ...(status === 'succeeded' ? { outputUrl: payload.video_url, ...(Number.isFinite(payload.expires_at) ? { expiresAt: new Date(payload.expires_at * 1000).toISOString() } : {}) } : {}),
    ...(status === 'failed' ? { errorCode: typeof payload.error?.code === 'string' ? payload.error.code : 'upstream_failed' } : {}),
  };
  await jobs.save(next);
  return publicJob(next);
}

function publicJob(job) {
  return { id: job.id, object: 'video', status: job.status, model: job.model, source: 'qoder', ...(job.status === 'succeeded' ? { url: job.outputUrl, ...(job.expiresAt ? { expires_at: Math.floor(Date.parse(job.expiresAt) / 1000) } : {}) } : {}) };
}
