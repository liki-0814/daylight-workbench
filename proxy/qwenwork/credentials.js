import {createHash} from 'node:crypto';
import {authError} from './auth.js';

const REFRESH_FALLBACK_MS = 600_000;
const ROTATION_RETRY_MS = 30_000;
const DEFAULT_SCOPE = '__default__';

export function normalizeMaasBase(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw authError('模型服务地址无效', 502); }
  const path = url.pathname.replace(/\/+$/, '');
  const host = url.hostname;
  const allowed = host === 'maas.xiaoluozi.cn' || host.endsWith('.xiaoluozi.cn') || host.endsWith('.qwenwork.cn');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !allowed || path && path !== '/v1') throw authError('模型服务地址无效', 502);
  return `${url.origin}/v1`;
}

export function preferMaasBase(responseBase, fallback) {
  if (typeof responseBase === 'string' && responseBase.trim()) {
    try { return normalizeMaasBase(responseBase); } catch { /* The office response address is optional. */ }
  }
  return normalizeMaasBase(fallback);
}

// Internal cache scope only. The raw Daylight conversation id is not a MaaS session id.
export function conversationScope(conversationId) {
  if (typeof conversationId !== 'string') return undefined;
  const id = conversationId.trim();
  if (!id || id.length > 200) return undefined;
  return createHash('sha256').update(id).digest('hex');
}

export function mintBody(sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  return id ? {session_id: id} : {};
}

export function exchangeUrl(apiBase) {
  return `${apiBase.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/access-tokens/exchange`;
}

export function inferenceUrl(apiBase, protocol) {
  const path = {chat: '/chat/completions', responses: '/responses', messages: '/messages'}[protocol];
  if (!path) throw authError('模型协议不受支持', 400);
  return `${apiBase.replace(/\/+$/, '')}${path}`;
}

function sessionIdOf(value, requested) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200 || /[\r\n]/.test(value)) throw authError('签发接口返回了无效的会话标识', 502);
  const id = value.trim();
  if (requested && requested.toLowerCase() !== id.toLowerCase()) throw authError('签发接口返回的会话标识与请求不一致', 502);
  return id;
}

async function discard(response) { await response.body?.cancel().catch(() => {}); }

export class MaasCredentials {
  constructor({now = Date.now, fallbackBase = 'https://maas.xiaoluozi.cn/v1'} = {}) {
    this.now = now;
    this.fallbackBase = fallbackBase;
    this.cache = new Map();
    this.inflight = new Map();
    this.retryAfter = new Map();
  }
  scope(sessionId) { return (typeof sessionId === 'string' && sessionId.trim()) || DEFAULT_SCOPE; }
  key(identity, sessionId) { return `${identity}\0${this.scope(sessionId)}`; }
  clear(identity) {
    for (const key of [...this.cache.keys(), ...this.retryAfter.keys()]) {
      if (!identity || key.startsWith(`${identity}\0`)) { this.cache.delete(key); this.retryAfter.delete(key); }
    }
  }
  invalidate(identity, sessionId) {
    const key = this.key(identity, sessionId);
    this.cache.delete(key);
    this.retryAfter.delete(key);
  }
  usable(credential, key) {
    if (!credential) return false;
    if (!credential.expiresAtMs) return true;
    if (credential.expiresAtMs <= this.now()) return false;
    if ((this.retryAfter.get(key) || 0) > this.now()) return true;
    const lead = credential.ttlMs > 0 ? Math.floor(credential.ttlMs / 2) : REFRESH_FALLBACK_MS;
    return credential.expiresAtMs - this.now() > lead;
  }
  async resolve(input) {
    const key = this.key(input.identity, input.sessionId);
    const existing = this.cache.get(key);
    if (input.force) this.invalidate(input.identity, input.sessionId);
    if (!input.force && this.usable(existing, key)) return existing;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    // A rejected token keeps the server-issued session, never the external conversation id.
    const current = input.force ? (existing?.sessionId ? {sessionId: existing.sessionId} : undefined) : existing;
    const task = this.refresh(key, current, input).finally(() => {
      if (this.inflight.get(key) === task) this.inflight.delete(key);
    });
    this.inflight.set(key, task);
    return task;
  }
  async refresh(key, current, input) {
    if (current && current.expiresAtMs > this.now() && current.ttlMs > 0) {
      const exchanged = await this.exchange(current, input);
      if (exchanged.status === 'success') { this.retryAfter.delete(key); this.cache.set(key, exchanged.credential); return exchanged.credential; }
      if (exchanged.status === 'unavailable') { this.retryAfter.set(key, this.now() + ROTATION_RETRY_MS); return current; }
      this.retryAfter.delete(key);
    }
    const minted = await this.mint(current?.sessionId, input);
    this.retryAfter.delete(key);
    this.cache.set(key, minted);
    return minted;
  }
  async mint(sessionId, {officeToken, openApiBase, headers, fetchImpl, signal}) {
    const response = await fetchImpl(new URL('/api/desktop-sessions', openApiBase), {
      method: 'POST', redirect: 'error', headers: {...headers, Authorization: `Bearer ${officeToken}`, 'Content-Type': 'application/json', Accept: 'application/json'},
      body: JSON.stringify(mintBody(sessionId)), signal,
    });
    if (!response.ok) { await discard(response); throw authError(`签发模型服务凭据失败（${response.status}）`, response.status); }
    const data = await response.json().catch(() => { throw authError('签发接口返回了无效响应', 502); });
    if (typeof data.access_token !== 'string' || !data.access_token) throw authError('签发接口未返回模型服务凭据', 502);
    const issuedSession = sessionIdOf(data.session_id, sessionId);
    return {
      accessToken: data.access_token,
      expiresAtMs: typeof data.expires_at_ms === 'number' && data.expires_at_ms > 0 ? data.expires_at_ms : 0,
      ttlMs: typeof data.ttl_ms === 'number' && data.ttl_ms > 0 ? data.ttl_ms : 0,
      sessionId: issuedSession,
      baseUrl: preferMaasBase(data.base_url, this.fallbackBase),
    };
  }
  async exchange(credential, {fetchImpl, signal}) {
    try {
      const response = await fetchImpl(exchangeUrl(credential.baseUrl), {
        method: 'POST', redirect: 'error',
        headers: {Authorization: `Bearer ${credential.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json'},
        body: JSON.stringify({ttl_ms: credential.ttlMs}), signal,
      });
      if (!response.ok) { await discard(response); return {status: response.status === 401 ? 'rejected' : 'unavailable'}; }
      const data = await response.json().catch(() => null);
      if (!data || typeof data.access_token !== 'string' || !data.access_token || typeof data.expires_at !== 'number' || data.expires_at <= 0) return {status: 'unavailable'};
      return {status: 'success', credential: {...credential, accessToken: data.access_token, expiresAtMs: data.expires_at, ttlMs: credential.ttlMs}};
    } catch { return {status: 'unavailable'}; }
  }
}
