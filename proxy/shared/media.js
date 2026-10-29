import { RequestTrace } from './request-records.js';
import { readUpstreamError } from './upstream-error.js';

export const fail = (message, status = 400, code = 'invalid_request', extra) => { throw Object.assign(new Error(message), { status, code, ...extra }); };
const POLICY = new Set(['content_filter', 'content_safety', 'content_safety_rejected', 'image_gen_content_safety_rejected', 'moderation_rejected', 'policy_violation', 'safety_rejection']);
export const IMAGE_BYTES = 8_000_000;
const RESPONSE_BYTES = 32_000_000;

export function assertImageUrl(url) {
  if (typeof url !== 'string' || !url) fail('图片地址无效');
  if (url.startsWith('https://')) {
    let parsed;
    try { parsed = new URL(url); } catch { fail('图片地址无效'); }
    if (parsed.protocol !== 'https:') fail('图片地址无效');
    return;
  }
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
  if (!match) fail('图片地址无效');
  const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!bytes.length || bytes.length > IMAGE_BYTES) fail('单张图片不能超过 8 MB');
}

// Reads at most maxBytes: trusts a declared content-length only to reject early, then counts the bytes actually received.
export async function readBytesLimited(response, maxBytes, message) {
  const declared = Number(response.headers?.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) { await response.body?.cancel(); fail(message); }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      size += step.value.length;
      if (size > maxBytes) { await reader.cancel(); fail(message); }
      chunks.push(step.value);
    }
  } finally { reader.releaseLock?.(); }
  return Buffer.concat(chunks);
}

export function jsonType(header) {
  if (typeof header !== 'string') return false;
  const [type, ...params] = header.split(';').map(part => part.trim()).filter(Boolean);
  return type.toLowerCase() === 'application/json' && params.every(part => /^charset=utf-8$/i.test(part));
}

export function matchMedia(route, method) {
  if (route === '/images/generations' && method === 'POST') return { operation: 'image.generate', limit: 1_000_000, timeout: 180_000, trace: '/images/generations' };
  if (route === '/images/edits' && method === 'POST') return { operation: 'image.edit', limit: 64_000_000, timeout: 180_000, trace: '/images/edits' };
  if (route === '/videos/generations' && method === 'POST') return { operation: 'video.submit', limit: 64_000_000, timeout: 45_000, trace: '/videos/generations' };
  const video = /^\/videos\/(vid_[0-9a-f-]{36})$/.exec(route);
  if (video && method === 'GET') return { operation: 'video.poll', id: video[1], timeout: 30_000, trace: '/videos/{id}' };
  if (route.startsWith('/images/') || route.startsWith('/videos/')) return { unknown: true };
  return null;
}

export async function mediaCatalog(registry) {
  const rows = [];
  for (const provider of Object.values(registry.providers)) {
    if (typeof provider.mediaModels !== 'function') continue;
    rows.push(...await provider.mediaModels());
  }
  return rows.filter(row => row.status === 'ready' && row.enabled !== false);
}

export async function selectMedia(registry, model, source) {
  if (model === 'gpt-image-2.5') fail('没有 gpt-image-2.5。请使用 gpt-image-2.5-flare 或 gpt-image-2.5-sunburst');
  const ready = await mediaCatalog(registry);
  const matches = ready.filter(row => row.id === model && (!source || row.source === source));
  if (matches.length > 1) fail('模型对应多个来源', 400, 'model_ambiguous', { sources: [...new Set(matches.map(row => row.source))] });
  if (matches.length === 1) return matches[0];
  for (const provider of Object.values(registry.providers)) {
    if (typeof provider.mediaLoginError !== 'function' || !provider.mediaOwns?.(model)) continue;
    const error = await provider.mediaLoginError();
    if (error) throw error;
  }
  fail('模型不存在或已停用', 400, 'model_not_found');
}

export async function readJsonLimited(response, maxBytes = RESPONSE_BYTES) {
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      size += step.value.length;
      if (size > maxBytes) {
        await reader.cancel();
        fail('图像响应超过 32 MB。不要用同一描述立即重试，请先到来源网页确认这次是否已经生成', 502, 'response_too_large');
      }
      chunks.push(step.value);
    }
  } finally { reader.releaseLock?.(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { fail('上游响应不是有效 JSON', 502, 'invalid_upstream'); }
}

export async function assertMediaOk(response) {
  if (response.ok || response.status === 202) return;
  const error = await readUpstreamError(response);
  if (POLICY.has(error.code)) fail('上游拒绝了该内容，请修改描述后重试。', response.status, error.code);
  throw error;
}

export function onlyKeys(body, allowed) {
  const unknown = Object.keys(body).filter(key => !allowed.has(key));
  if (unknown.length) fail(`不支持的字段：${unknown.join('、')}`);
}

export async function serveMedia({ match, body, res, send, registry, jobs, records, signal, sourceState }) {
  const trace = new RequestTrace(match.trace);
  const stop = AbortSignal.any([signal, AbortSignal.timeout(match.timeout)]);
  let code = 200;
  trace.observe({ mediaOperation: match.operation, streaming: false });
  try {
    if (match.operation === 'video.poll') {
      const job = await jobs.get(match.id);
      if (!job) fail('任务不存在', 404, 'job_not_found');
      const provider = registry.providers[job.provider];
      if (!provider?.executeMedia) fail('任务不存在', 404, 'job_not_found');
      trace.observe({ provider: job.provider, model: job.model, sourceRevision: sourceState.revision(job.provider, provider) });
      const value = await provider.executeMedia({ operation: 'video.poll', body: { id: job.id }, model: job.model }, { signal: stop, observe: info => trace.observe(info), jobs });
      trace.observe({ finish: 'stop' });
      send(res, 200, value);
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('请求格式不正确');
    if (body.source !== undefined && (typeof body.source !== 'string' || !body.source.trim())) fail('source 无效');
    if (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 200) fail('需要有效的 model');
    const selected = await selectMedia(registry, body.model, body.source);
    const provider = registry.providers[selected.source];
    trace.observe({ provider: selected.source, model: selected.id, sourceRevision: sourceState.revision(selected.source, provider) });
    const { source: _source, ...rest } = body;
    const value = await provider.executeMedia({ operation: match.operation, body: rest, model: selected.id }, { signal: stop, observe: info => trace.observe(info), jobs });
    trace.observe({ finish: 'stop' });
    send(res, 200, value);
  } catch (error) {
    code = signal.aborted ? 499 : error.status || 502;
    trace.fail(error, signal.aborted ? 'cancelled' : 'failed');
    if (!res.headersSent) send(res, code, { error: { message: error.status ? error.message : '代理请求失败，请检查账号与网络后重试', code: error.code, type: code === 400 ? 'invalid_request_error' : 'upstream_error', ...(error.sources ? { sources: error.sources } : {}) } });
  } finally {
    await records.append(trace.finish(code));
  }
}

export function imageResult(payload, format, urls) {
  const created = Math.floor(Date.now() / 1000);
  if (format === 'b64_json') {
    if (!urls.every(item => item.b64_json)) fail('上游没有返回请求的图像数据。不要用同一描述立即重试，请先到来源网页确认这次是否已经生成', 502, 'response_format_unavailable');
    return { created, data: urls.map(item => ({ b64_json: item.b64_json })) };
  }
  if (!urls.every(item => item.url)) fail('上游没有返回请求的图像地址。不要用同一描述立即重试，请先到来源网页确认这次是否已经生成', 502, 'response_format_unavailable');
  return { created, data: urls.map(item => ({ url: item.url })) };
}
