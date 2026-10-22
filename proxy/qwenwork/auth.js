import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {unlink} from 'node:fs/promises';
import {readJson, writeJson, serial} from '../shared/store.js';

// Desktop OAuth client shipped in QwenWorkCN. This is not the Qoder CLI COSY transport.
export const CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb';
const PKCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
const ACCOUNT_CONTEXT = '/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing';

export const authError = (message, status = 401) => Object.assign(new Error(message), {status, code: 'authentication_error'});
export const allowedAuthHost = host => host === 'gateway.qwenwork.cn' || host === 'qwenwork.cn' || host.endsWith('.qwenwork.cn');

// Optional client factors stay absent unless the runtime actually has them.
export function loginSecurityState({userAgent} = {}) {
  return Buffer.from(JSON.stringify({v: 1, ...(userAgent ? {user_agent: userAgent} : {})})).toString('base64url');
}

export function buildQoderWorkLoginUrl(deviceUrl, {userAgent} = {}) {
  const device = new URL(deviceUrl);
  if (device.protocol !== 'https:' || device.username || device.password || device.port || device.hash || !allowedAuthHost(device.hostname) || device.pathname !== '/device/selectAccounts') throw authError('登录地址无效');
  const page = new URL('/users/sign-in', device.origin);
  page.searchParams.set('biz_variant', 'qoderwork');
  page.searchParams.set('oauth_callback', device.href);
  page.searchParams.set('state', loginSecurityState({userAgent}));
  const callback = new URL(page.searchParams.get('oauth_callback'));
  if (page.origin !== device.origin || callback.origin !== device.origin || callback.pathname !== '/device/selectAccounts') throw authError('登录地址无效');
  return page.href;
}

export function httpsOrigin(value, allowed, label) {
  let url;
  try { url = new URL(value); } catch { throw authError(`${label}无效`); }
  const path = url.pathname.replace(/\/+$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || path) throw authError(`${label}无效`);
  if (!allowed(url.hostname)) throw authError(`${label}无效`);
  return url.origin;
}

export function qwenWorkHeaders(config, {token, json = false} = {}) {
  return {
    Accept: 'application/json',
    'X-Request-Id': randomUUID(),
    'User-Agent': `qoderwork/${config.clientVersion}`,
    'X-QwenWork-Version': config.clientVersion,
    'X-QwenWork-Release-Version': config.releaseVersion,
    'X-QwenWork-Build': config.build,
    'X-QwenWork-Platform': config.platform,
    'X-QwenWork-Arch': config.arch,
    'X-QwenWork-Channel': config.channel,
    ...(json ? {'Content-Type': 'application/json'} : {}),
    ...(token ? {Authorization: `Bearer ${token}`} : {}),
  };
}

export function createPkce() {
  const length = 43 + randomBytes(1)[0] % 86;
  const bytes = randomBytes(length);
  let verifier = '';
  for (let i = 0; i < length; i++) verifier += PKCE_ALPHABET[bytes[i] % PKCE_ALPHABET.length];
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return {verifier, challenge};
}

export function startDeviceFlow(config, now = Date.now) {
  const {verifier, challenge} = createPkce();
  const nonce = randomUUID(), machineId = randomUUID();
  const url = new URL('/device/selectAccounts', config.authBase);
  for (const [key, value] of Object.entries({
    challenge, challenge_method: 'S256', nonce, machine_id: machineId, client_id: config.clientId, redirect_uri: config.redirectUri,
  })) url.searchParams.set(key, value);
  return {url: url.href, nonce, verifier, challenge, machineId, expiresAt: now() + 300_000};
}

export function refreshBody(credential) {
  if (credential.target === 'biz') {
    if (!credential.teamId) throw authError('团队身份缺少标识，请重新登录');
    return {refresh_token: credential.refresh, target: 'biz', team_id: credential.teamId};
  }
  return {refresh_token: credential.refresh, target: 'c'};
}

// Device-token expires_in is seconds. expires_at is an absolute timestamp string.
export function expiresAt(data, now = Date.now) {
  if (typeof data.expires_at === 'string' && Number.isFinite(Date.parse(data.expires_at))) return Date.parse(data.expires_at);
  if (typeof data.expires_in === 'number' && data.expires_in > 0) return now() + data.expires_in * 1000;
  return now() + 3_600_000;
}

export function issuerHost(token) {
  const part = typeof token === 'string' ? token.split('.')[1] : '';
  if (!part) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString());
    if (typeof payload.iss !== 'string' || !payload.iss) return undefined;
    return new URL(payload.iss).host;
  } catch { return undefined; }
}

export function assertEnvironment(token, openApiBase) {
  const host = issuerHost(token);
  if (host && host !== new URL(openApiBase).host) throw authError('登录环境与办公网关不一致，请重新登录');
}

const textOf = (value, keys) => {
  for (const key of keys) {
    const found = value?.[key];
    if (typeof found === 'string' && found.trim()) return found.trim();
  }
  return undefined;
};

export function identityFromContext(payload) {
  const data = payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : payload;
  if (!data || typeof data !== 'object') throw authError('账号环境缺少身份信息，请重新登录');
  const user = data.user && typeof data.user === 'object' && !Array.isArray(data.user) ? {...data, ...data.user, organization: data.organization || data.user.organization} : data;
  const organization = user.organization && typeof user.organization === 'object' ? user.organization : undefined;
  const uid = textOf(user, ['id', 'user_id', 'uid']);
  if (!uid) throw authError('账号环境缺少身份信息，请重新登录');
  const orgId = textOf(user, ['orgId', 'organization_id', 'organizationId']) || textOf(organization, ['org_id', 'orgId', 'id']);
  const teamId = textOf(user, ['team_id', 'teamId']) || textOf(organization, ['team_id', 'teamId']);
  const isBiz = user.is_biz === true || user.isBiz === true;
  const target = isBiz && orgId && teamId ? 'biz' : 'c';
  return {
    uid, target, orgId, teamId,
    login: textOf(user, ['name', 'username', 'user_name', 'email']) || uid,
    organization: textOf(organization, ['org_name', 'orgName', 'name']),
  };
}

export function sameIdentity(a, b) {
  return !!a && !!b && a.uid === b.uid && a.target === b.target && (a.target === 'c' || a.orgId === b.orgId && a.teamId === b.teamId);
}

async function readJsonResponse(response) {
  try { return await response.json(); } catch { throw authError(`千问办公返回了无效响应（${response.status}）`, response.status || 502); }
}

export async function officeRequest(fetchImpl, config, path, {method = 'GET', token, body, signal} = {}) {
  const response = await fetchImpl(new URL(path, config.openApiBase), {
    method, redirect: 'error', headers: qwenWorkHeaders(config, {token, json: body !== undefined}),
    ...(body !== undefined ? {body: JSON.stringify(body)} : {}),
    signal,
  });
  return response;
}

export class AccountStore {
  constructor(file) { this.file = file; this.run = serial(); }
  async load() {
    const account = await readJson(this.file, null);
    if (account && (!account.credential?.access || !account.credential?.refresh || !account.credential?.uid || !account.environment)) throw new Error('千问办公账号文件无效，请重新登录');
    this.current = account;
    return account;
  }
  async require() {
    const value = await this.load();
    if (!value) throw authError('请先登录千问办公');
    return value;
  }
  async save(account) { await writeJson(this.file, account); this.current = account; }
  logout() {
    return this.run(async () => {
      await unlink(this.file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      this.current = null;
    });
  }
}

export class QwenWorkAuth {
  constructor({accounts, config, fetchImpl, now = Date.now, onChange = () => {}}) {
    Object.assign(this, {accounts, config, fetchImpl, now, onChange, epoch: 0, pending: null});
  }
  get account() { return this.accounts.current; }
  signal(signal, ms = 30_000) { return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms); }
  async login() {
    this.pending = startDeviceFlow(this.config, this.now);
    return {url: buildQoderWorkLoginUrl(this.pending.url, {userAgent: `qoderwork/${this.config.clientVersion}`}), expiresAt: this.pending.expiresAt};
  }
  async poll() {
    if (!this.pending || this.now() > this.pending.expiresAt) {
      this.pending = null;
      throw Object.assign(new Error('登录链接已过期，请重新登录'), {status: 400});
    }
    if (!this.polling) {
      const login = this.pending;
      this.polling = this.complete(login).then(account => this.accounts.run(async () => {
        if (this.pending !== login) return {authorized: false, status: 'cancelled'};
        if (!account) return {authorized: false};
        await this.accounts.save(account);
        this.pending = null;
        this.epoch++;
        this.onChange();
        return {authorized: true};
      })).finally(() => { this.polling = null; });
    }
    return this.polling;
  }
  async complete(login) {
    const url = new URL('/api/v1/deviceToken/poll', this.config.openApiBase);
    url.searchParams.set('nonce', login.nonce);
    url.searchParams.set('verifier', login.verifier);
    url.searchParams.set('challenge_method', 'S256');
    const response = await this.fetchImpl(url, {method: 'GET', redirect: 'error', headers: qwenWorkHeaders(this.config), signal: this.signal()});
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw authError(`登录查询失败（${response.status}）`, response.status); }
    const data = await readJsonResponse(response);
    if (typeof data.token !== 'string' || !data.token || typeof data.refresh_token !== 'string' || !data.refresh_token) throw authError('登录响应缺少凭据，请重新登录');
    if (data.nonce !== login.nonce || data.code_challenge !== login.challenge || data.code_challenge_method !== 'S256') throw authError('登录校验失败，请重新登录');
    assertEnvironment(data.token, this.config.openApiBase);
    const identity = await this.context(data.token);
    return this.accountFrom(data, identity, login.machineId);
  }
  async context(token, signal) {
    const response = await officeRequest(this.fetchImpl, this.config, ACCOUNT_CONTEXT, {token, signal: this.signal(signal)});
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw authError('千问办公登录已失效，请重新登录', response.status); }
    if (!response.ok) { await response.body?.cancel(); throw authError(`账号环境校准失败（${response.status}）`, response.status); }
    return identityFromContext(await readJsonResponse(response));
  }
  accountFrom(data, identity, machineId = this.accounts.current?.credential?.machineId || randomUUID()) {
    const key = [this.config.openApiBase, identity.uid, identity.target, identity.target === 'biz' ? identity.teamId : ''].join('\0');
    return {
      id: `acc_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`,
      environment: this.config.openApiBase,
      credential: {
        access: data.token || data.device_token, refresh: data.refresh_token, expires: expiresAt(data, this.now),
        ...identity, machineId,
      },
    };
  }
  async refresh() {
    return this.accounts.run(async () => {
      const account = await this.accounts.require();
      if (account.environment !== this.config.openApiBase) throw authError('登录环境已变化，请重新登录');
      const response = await officeRequest(this.fetchImpl, this.config, '/api/v1/deviceToken/refresh', {
        method: 'POST', body: refreshBody(account.credential), signal: this.signal(),
      });
      if (!response.ok) { await response.body?.cancel(); throw authError(`登录已过期，请重新登录（${response.status}）`, response.status); }
      const data = await readJsonResponse(response);
      const access = data.device_token || data.token;
      if (typeof access !== 'string' || !access || typeof data.refresh_token !== 'string' || !data.refresh_token) throw authError('刷新登录失败，请重新登录');
      assertEnvironment(access, this.config.openApiBase);
      const identity = await this.context(access);
      if (!sameIdentity(account.credential, identity)) throw authError('登录身份已变化，请重新登录');
      account.credential = {...account.credential, ...identity, access, refresh: data.refresh_token, expires: expiresAt(data, this.now)};
      await this.accounts.save(account);
      return {ok: true};
    });
  }
  async cancel() { this.pending = null; return {ok: true, status: 'cancelled'}; }
  async logout() {
    this.pending = null;
    await this.accounts.logout();
    this.epoch++;
    this.onChange();
    return {ok: true};
  }
}
