import { bindMediaModelSettings } from '../shared/model-settings.js';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { oauthError } from '../shared/oauth-account.js';
import { assertImageUrl, assertMediaOk, fail, imageResult, onlyKeys, readJsonLimited } from '../shared/media.js';

const ORIGIN = 'https://chatgpt.com/backend-api/codex';
const CLIENT_VERSION = '0.161.0';
const FLARE = new Set(['gpt-image-2.5-flare', 'gpt-image-2.5-flare-2026-09-08', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst-2026-09-08', 'chatgpt-image-latest']);
const IMAGE2 = new Set(['gpt-image-2', 'gpt-image-2-2026-04-21']);
const LEGACY = new Set(['gpt-image-1.5', 'gpt-image-1-mini']);
export const codexMediaIds = [...FLARE, ...IMAGE2, ...LEGACY];
const FLEX = { '1:1': [1024, 1024], '16:9': [1536, 864], '9:16': [864, 1536], '4:3': [1024, 768], '3:4': [768, 1024], '3:2': [1536, 1024], '2:3': [1024, 1536], '21:9': [1792, 768], '5:2': [1600, 640] };
const KEYS = new Set(['model', 'prompt', 'n', 'response_format', 'quality', 'aspect_ratio', 'resolution', 'size', 'image', 'images', 'background', 'input_fidelity']);

const row = id => ({ id, displayName: id, output: 'image', status: 'ready', source: 'codex' });
const loginError = () => oauthError('请在 Daylight 中网页登录 Codex');
const RULE_CODES = new Set(['hardened_oauth_rule_missing', 'no_matching_rule']);

function emailOf(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    return typeof payload.email === 'string' ? payload.email : '';
  } catch { return ''; }
}

async function cliImageAuth(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    const token = data.tokens?.access_token, account = data.tokens?.account_id, idToken = data.tokens?.id_token;
    if (typeof token !== 'string' || typeof account !== 'string' || typeof idToken !== 'string') return null;
    return { token, account, email: emailOf(idToken) };
  } catch { return null; }
}

function family(model) {
  if (FLARE.has(model)) return 'flare';
  if (IMAGE2.has(model)) return 'image2';
  return 'legacy';
}

function checkSize(model, size) {
  const kind = family(model);
  if (kind === 'legacy') {
    if (!['1024x1024', '1536x1024', '1024x1536', 'auto'].includes(size)) fail('该 Codex 模型不支持此 size');
    return;
  }
  if (size === 'auto') return;
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) fail('size 无效');
  const width = Number(match[1]), height = Number(match[2]);
  if (width % 16 || height % 16 || Math.max(width, height) > 3840 || Math.max(width, height) / Math.min(width, height) > 3) fail('size 超出允许范围');
  const pixels = width * height;
  if (kind === 'image2' && (pixels < 655360 || pixels > 8294400)) fail('size 超出允许范围');
}

function resolveSize(model, body) {
  if (body.size !== undefined) { checkSize(model, body.size); return body.size; }
  if (body.aspect_ratio === undefined && body.resolution === undefined) return undefined;
  const kind = family(model);
  if (kind === 'legacy') {
    if (body.resolution !== undefined && body.resolution !== '1k') fail('该 Codex 模型不支持此分辨率');
    const legacy = { '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536', auto: 'auto' };
    if (!legacy[body.aspect_ratio ?? '1:1']) fail('该 Codex 模型不支持此宽高比');
    return legacy[body.aspect_ratio ?? '1:1'];
  }
  const base = FLEX[body.aspect_ratio ?? '1:1'];
  if (!base) fail('aspect_ratio 无效');
  const scale = body.resolution === '2k' ? 2 : body.resolution === undefined || body.resolution === '1k' ? 1 : fail('resolution 无效');
  const size = `${base[0] * scale}x${base[1] * scale}`;
  checkSize(model, size);
  return size;
}

function imagesOf(body) {
  const single = body.image !== undefined, many = body.images !== undefined;
  if (!single && !many) return {};
  if (single === many) fail('image 与 images 必须二选一');
  const list = single ? [body.image] : body.images;
  if (!Array.isArray(list) || !list.length || list.length > 5) fail('图片数量无效');
  const urls = list.map(item => {
    const url = typeof item === 'string' ? item : item?.url;
    if (item && typeof item === 'object' && item.type && item.type !== 'image_url') fail('图片格式无效');
    assertImageUrl(url);
    return url;
  });
  return single ? { image: urls[0] } : { images: urls };
}

async function session(provider) {
  try { return await provider.auth.read(); }
  catch { return null; }
}

export function attachCodexMedia(provider) {
  provider.mediaOwns = model => codexMediaIds.includes(model);
  provider.mediaLoginError = async () => await session(provider) ? null : loginError();
  provider.mediaModels = async () => await session(provider) ? codexMediaIds.map(row) : [];
  bindMediaModelSettings(provider);
  provider.executeMedia = (input, context) => execute(provider, input, context);
}

async function execute(provider, { operation, body, model }, { signal, observe = () => {} }) {
  if (operation !== 'image.generate' && operation !== 'image.edit') fail('Codex 没有视频生成');
  onlyKeys(body, KEYS);
  if (typeof body.prompt !== 'string' || !body.prompt) fail('prompt 无效');
  const format = body.response_format ?? 'url';
  if (format !== 'url' && format !== 'b64_json') fail('response_format 无效');
  const n = body.n ?? 1;
  if (!Number.isInteger(n) || n < 1 || (format === 'b64_json' ? n !== 1 : n > 10)) fail('n 超出允许范围');
  const kind = family(model);
  const qualities = kind === 'flare' ? ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] : ['low', 'medium', 'high', 'auto'];
  if (body.quality !== undefined && !qualities.includes(body.quality)) fail('quality 无效');
  if (body.input_fidelity !== undefined) fail('input_fidelity 无效');
  if (body.background !== undefined && !(kind === 'flare' && body.background === 'transparent')) fail('该 Codex 模型不支持此背景');
  if (operation === 'image.generate' && (body.image !== undefined || body.images !== undefined)) fail('生成不接受参考图');
  if (operation === 'image.edit' && body.image === undefined && body.images === undefined) fail('编辑需要图片');
  const size = resolveSize(model, body);
  const upstream = { model, prompt: body.prompt, n, ...(body.response_format ? { response_format: format } : {}), ...(body.quality ? { quality: body.quality } : {}), ...(size ? { size } : {}), ...(body.background ? { background: body.background } : {}), ...(operation === 'image.edit' ? imagesOf(body) : {}) };
  const endpoint = operation === 'image.edit' ? 'images/edits' : 'images/generations';
  const send = async (credential, retried) => {
    observe({ stage: 'upstream' });
    const headers = { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json', Accept: 'application/json', originator: 'codex_cli_rs', 'User-Agent': `codex_cli_rs/${CLIENT_VERSION}` };
    if (credential.account) headers['chatgpt-account-id'] = credential.account;
    const response = await provider.fetchImpl(`${ORIGIN}/${endpoint}`, { method: 'POST', redirect: 'error', signal, headers, body: JSON.stringify(upstream) });
    if (response.status === 401 && !retried) {
      await response.body?.cancel();
      observe({ stage: 'authentication', retries: 1 });
      const fresh = await provider.auth.read(true);
      if (fresh.identity !== credential.identity) throw loginError();
      return send(fresh, true);
    }
    return response;
  };
  let credential = await provider.auth.read();
  let response = await send(credential, false);
  if (response.status === 401) {
    const failure = await readJsonLimited(response).catch(() => ({}));
    const code = failure.error?.code;
    const cli = RULE_CODES.has(code) ? await cliImageAuth(provider.imageAuthFile || path.join(os.homedir(), '.codex', 'auth.json')) : null;
    const session = cli ? await provider.auth.readSession?.().catch(() => null) : null;
    if (cli && session?.id_token && emailOf(session.id_token) === cli.email) {
      credential = { ...credential, token: cli.token, account: cli.account };
      response = await send(credential, true);
    } else {
      fail(code === 'hardened_oauth_rule_missing' || code === 'no_matching_rule' ? '当前 ChatGPT 登录不能调用图像接口。本机 Codex CLI 已登录同一邮箱时会自动改用它。' : 'Codex 图像请求被拒绝', response.status, code || 'unauthorized');
    }
  }
  await assertMediaOk(response);
  const payload = await readJsonLimited(response);
  const items = payload.data || [];
  const returned = body.response_format ?? (items.every(item => item.url) ? 'url' : 'b64_json');
  return imageResult(payload, returned, items);
}
