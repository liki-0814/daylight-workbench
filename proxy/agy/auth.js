import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Secrets } from '../shared/secrets.js';
import { discoverModels } from './models.js';
import { writeJson } from '../shared/store.js';
import { loadOAuthClient } from './oauth-client.js';

const authError = (message,code='EAGY_REFRESH_FAILED') => Object.assign(new Error(message),{code});

export class AgyAuth {
  constructor({ tokenFile = path.join(os.homedir(), '.gemini/antigravity-cli/antigravity-oauth-token'), readFileImpl = readFile, writeJsonImpl = writeJson, fetchImpl = fetch, now = Date.now, getOAuthClientImpl = loadOAuthClient, credentials = new Secrets({helperName:'DaylightAgyCredentials',timeoutMs:15000}) } = {}) { Object.assign(this,{tokenFile,readFileImpl,writeJsonImpl,fetchImpl,now,getOAuthClientImpl,credentials}); }
  async profile() {
    try {
      // The current CLI falls back to this profile when its keyring read times out.
      // Existing CLI profiles remain authoritative, including expired sessions.
      let text;
      if(this.tokenFile)try{text=await this.readFileImpl(this.tokenFile,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
      const textFromFile=text!==undefined;
      text = (text ?? await this.credentials.get('antigravity') ?? '').trim();
      const value = JSON.parse(text.startsWith('go-keyring-base64:') ? Buffer.from(text.slice(18), 'base64').toString() : text);
      if (!value.token?.access_token) throw new Error();
      return {value,fromFile:textFromFile};
    } catch(error) { if(error.code?.startsWith('EKEYCHAIN_'))throw error;throw Object.assign(new Error('无法读取本机 AGY 登录凭证；这不代表上游账号已退出。'),{code:'EAGY_CREDENTIALS'}); }
  }
  async read() { return (await this.profile()).value; }
  async token() {
    if (!this.pending) this.pending = this.load().finally(() => { this.pending = null; });
    return this.pending;
  }
  async models(catalog) { return discoverModels(catalog); }
  async refresh(profile) {
    const {value,fromFile}=profile,token=value.token;
    const method=value.auth_method||'consumer';
    if(!['consumer','gcp'].includes(method))throw authError('AGY 当前登录方式不支持静默刷新；原登录已保留。');
    if(!token.refresh_token)throw authError('AGY 登录缺少刷新令牌，需要重新授权；原登录已保留，未打开授权窗口。','EAGY_REAUTH_REQUIRED');
    const client=await this.getOAuthClientImpl(method);
    const key=createHash('sha256').update(JSON.stringify([value.auth_method,token.refresh_token,token.access_token])).digest('hex');
    if(this.failure?.key===key&&this.now()-this.failure.at<30000)throw this.failure.error;
    try {
      const response=await this.fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...client,grant_type:'refresh_token',refresh_token:token.refresh_token}),signal:AbortSignal.timeout(20000)});
      let result;try{result=await response.json();}catch{throw authError('AGY 自动刷新返回无效响应；原登录已保留。');}
      if(!response.ok)throw result.error==='invalid_grant'?authError('AGY 刷新令牌已失效，需要重新授权；原登录已保留，未打开授权窗口。','EAGY_REAUTH_REQUIRED'):authError(`AGY 自动刷新暂时失败（HTTP ${response.status}）；原登录已保留，将自动重试。`);
      if(typeof result.access_token!=='string'||!result.access_token||!Number.isFinite(result.expires_in)||result.expires_in<=60)throw authError('AGY 自动刷新返回无效令牌；原登录已保留。');
      const refreshed={...value,token:{...token,access_token:result.access_token,token_type:result.token_type||token.token_type||'Bearer',refresh_token:result.refresh_token||token.refresh_token,expiry:new Date(this.now()+result.expires_in*1000).toISOString()},...(result.id_token?{id_token:result.id_token}:{})};
      // The CLI may refresh, change accounts or log out while the network request runs.
      // Read again before the atomic write and never replace a changed profile.
      let current;
      try{current=fromFile?JSON.parse(await this.readFileImpl(this.tokenFile,'utf8')):await this.read();}
      catch{throw authError('AGY 登录在刷新期间发生变化，请重试；未覆盖登录文件。','EAGY_PROFILE_CHANGED');}
      if(JSON.stringify(current)!==JSON.stringify(value)) {
        if(current.token?.access_token&&Date.parse(current.token.expiry)>this.now())return current;
        throw authError('AGY 登录在刷新期间发生变化，请重试；未覆盖登录文件。','EAGY_PROFILE_CHANGED');
      }
      if(!this.tokenFile)throw authError('AGY 登录文件不可写；原登录已保留。');
      try{await this.writeJsonImpl(this.tokenFile,refreshed);}catch{throw authError('AGY 新令牌保存失败，请稍后重试；未打开授权窗口。');}
      this.failure=null;return refreshed;
    } catch(error) {
      const safe=error.code?.startsWith('EAGY_')?error:authError('AGY 自动刷新暂时无法连接 Google；原登录已保留，将自动重试。');
      this.failure={key,at:this.now(),error:safe};throw safe;
    }
  }
  async load() {
    const profile = await this.profile();let {value}=profile;
    if (!(Date.parse(value.token.expiry) > this.now()+60000)) {
      try{value=await this.refresh(profile);}catch(error){if(!(Date.parse(value.token.expiry)>this.now())||error.code==='EAGY_PROFILE_CHANGED')throw error;}
    }
    this.identity = createHash('sha256').update(value.token.access_token).digest('hex');
    return value.token.access_token;
  }
}
