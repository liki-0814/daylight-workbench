import {randomBytes, createHash, randomUUID} from 'node:crypto';
import {sessionFromAccount} from './transport.js';
import {unlink} from 'node:fs/promises';
import {readJson, writeJson, serial} from '../shared/store.js';

export function startAuthorize(config) {
  const verifier = randomBytes(32).toString('base64url');
  const nonce = randomBytes(16).toString('hex'), machineId = randomUUID();
  const url = new URL(config.loginUrl);
  for (const [key, value] of Object.entries({ challenge_method: 'S256', challenge: createHash('sha256').update(verifier).digest('base64url'), nonce, machine_id: machineId, client_id: config.clientId })) url.searchParams.set(key, value);
  return { url: url.href, nonce, verifier, machineId, expiresAt: Date.now() + 300_000 };
}
const accessOf = data => data.token || data.device_token || data.access_token || data.accessToken;
function expiry(data, access) {
  if (data.expires_at && Number.isFinite(Date.parse(data.expires_at))) return Date.parse(data.expires_at);
  // Qoder expires_in is milliseconds, unlike standard OAuth seconds.
  if (Number.isFinite(data.expires_in)) return Date.now() + data.expires_in;
  if (Number.isFinite(data.expires)) return data.expires;
  try { const exp = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString()).exp; if (Number.isFinite(exp)) return exp * 1000; } catch {}
  return Date.now() + 3_600_000;
}
export async function pollLogin(http, config, pending, fetchImpl) {
  const url = new URL('/api/v1/deviceToken/poll', config.openapiUrl);
  url.searchParams.set('nonce', pending.nonce); url.searchParams.set('verifier', pending.verifier);
  const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`登录查询失败（${response.status}）`);
  const data = await response.json(), access = accessOf(data);
  if (!access) throw new Error('登录响应缺少令牌，请重新登录');
  const statusResponse = await http.openapi('GET', '/api/v3/user/status', { token: access });
  if (!statusResponse.ok) throw new Error(`账号查询失败（${statusResponse.status}）`);
  const status = await statusResponse.json();
  const uid = data.uid || data.user_id || data.userId || status.uid || status.user_id;
  if (!uid) throw new Error('登录响应缺少账号标识');
  const credential = {
    type: 'oauth', access, refresh: data.refresh_token || data.refreshToken || '', expires: expiry(data, access), uid: String(uid),
    machineId: pending.machineId, machineToken: data.machine_token || data.machineToken || '',
    organizationId: status.organization_id || status.organizationId || status.orgId,
    organizationName: status.orgName, plan: status.plan,
  };
  const account = { id: `acc_${uid}`, serviceID: 'qoder', profile: 'qoder', credential };
  await enrich(http, config, account);
  return account;
}
export async function enrich(http, config, account) {
  const c = account.credential;
  if (c.organizationId && !c.organizationTags) {
    try {
      const res = await http.openapi('GET', `/api/v1/organizations/${encodeURIComponent(c.organizationId)}/tags`, { token: c.access });
      if (res.ok) { const data = await res.json(); const tags = Array.isArray(data) ? data : data.tags; c.organizationTags = Array.isArray(tags) ? tags.join(',') : tags; }
    } catch {}
  }
  if (!c.dataPolicy) {
    try {
      const res = await http.signedGet(http.algoUrl('/algo/api/v2/config/getDataPolicy'), sessionFromAccount(config, account));
      if (res.ok) { const data = await res.json(); const policy = data.policy || data.dataPolicy || data.data; if (typeof policy === 'string') c.dataPolicy = policy; }
    } catch {}
  }
}
export async function refreshCredential(http, credential) {
  let response = await http.openapi('POST', '/api/v1/deviceToken/refresh', { token: credential.access, body: { refresh_token: credential.refresh } });
  if (!response.ok) response = await http.openapi('POST', '/api/v3/user/refresh_token?Encode=1', { token: credential.refresh, body: {} });
  if (!response.ok) throw new Error(`登录已过期，请重新登录（${response.status}）`);
  const data = await response.json(), access = accessOf(data);
  if (!access) throw new Error('刷新令牌失败，请重新登录');
  return { ...credential, access, refresh: data.refresh_token || data.refreshToken || credential.refresh, expires: expiry(data, access) };
}

export class AccountStore {
  constructor(file) { this.file = file; this.run = serial(); }
  async load() {
    const account = await readJson(this.file, null);
    if (account && (!account.credential?.access || !account.credential?.uid)) throw new Error('账号文件无效，请重新登录');
    this.current=account;return account;
  }
  async require() { const value = await this.load(); if (!value) throw new Error('请先登录 Qoder'); return value; }
  async save(account) { await writeJson(this.file, account);this.current=account; }
  logout() { return this.run(async () => {await unlink(this.file).catch(error => { if (error.code !== 'ENOENT') throw error; });this.current=null;}); }
}

// The provider owns login state; management owns the stop-before-account-change policy.
export class QoderAuth {
 constructor({accounts,http,config,fetchImpl,onChange=()=>{}}){Object.assign(this,{accounts,http,config,fetchImpl,onChange});}
 async login(){this.pending=startAuthorize(this.config);return{url:this.pending.url,expiresAt:this.pending.expiresAt};}
 async poll(){
  if(!this.pending||Date.now()>this.pending.expiresAt){this.pending=null;throw Object.assign(new Error('登录链接已过期，请重新登录'),{status:400});}
  if(!this.polling){const login=this.pending;
   this.polling=pollLogin(this.http,this.config,login,this.fetchImpl).then(account=>this.accounts.run(async()=>{
    if(this.pending!==login)return false;
    if(account){await this.accounts.save(account);this.pending=null;this.onChange();return true;}return false;
   })).finally(()=>{this.polling=null;});
  }
  return{authorized:await this.polling};
 }
 async cancel(){this.pending=null;return{ok:true};}
 async logout(){this.pending=null;await this.accounts.logout();this.onChange();return{ok:true};}
}
