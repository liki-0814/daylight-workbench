import path from 'node:path';
import {CatalogCache} from '../shared/catalog-cache.js';
import {sourceSnapshot, modelCapabilities} from '../shared/contracts.js';
import {bindAccountCatalog, checkAccountCatalog} from '../shared/account-catalog.js';
import {modelSettings, applyModelSettings} from '../shared/model-settings.js';
import {operationError} from '../shared/operation-error.js';
import {invalid, prepareUpstreamRequest} from '../shared/protocol.js';
import {headerDeadline} from '../shared/header-deadline.js';
import {AccountStore, QwenWorkAuth, CLIENT_ID, authError, allowedAuthHost, httpsOrigin, qwenWorkHeaders, officeRequest, assertEnvironment} from './auth.js';
import {adaptChatModes} from './models.js';
import {MaasCredentials, conversationScope, inferenceUrl, normalizeMaasBase} from './credentials.js';

const platforms = {darwin: 'darwin', win32: 'win32', linux: 'linux', openharmony: 'openharmony'};

export function loadConfig(dataDir, env = process.env) {
  return {
    authBase: httpsOrigin(env.QWENWORK_AUTH_BASE || 'https://gateway.qwenwork.cn', allowedAuthHost, '登录地址'),
    openApiBase: httpsOrigin(env.QWENWORK_OPENAPI_BASE || 'https://gateway.qwenwork.cn', host => host === 'gateway.qwenwork.cn' || host.endsWith('.qwenwork.cn'), '办公网关'),
    maasBase: normalizeMaasBase(env.QWENWORK_MAAS_BASE || 'https://maas.xiaoluozi.cn/v1'),
    clientId: env.QWENWORK_CLIENT_ID || CLIENT_ID,
    clientVersion: env.QWENWORK_CLIENT_VERSION || '1.3.0',
    releaseVersion: env.QWENWORK_RELEASE_VERSION || '1.3.0',
    build: env.QWENWORK_BUILD || '26101007',
    channel: 'stable',
    platform: platforms[process.platform] || 'linux',
    arch: process.arch,
    redirectUri: 'qwenwork-cn://',
    scene: 'qwork',
    accountFile: path.join(dataDir, 'qwenwork', 'account.json'),
    settingsFile: path.join(dataDir, 'qwenwork', 'settings.json'),
  };
}

export const sourceDescription = {
  id: 'qwenwork', name: '千问办公',
  authentication: {mode: 'browser', operations: ['login', 'poll', 'cancel', 'logout', 'refresh'], instruction: '千问办公网页登录 · 无需本机 CLI', loginLabel: '网页登录'},
  capabilities: {quota: false, editableSource: false},
  nativeProtocols: ['chat', 'responses', 'messages'],
};

export class QwenWorkProvider {
  constructor({dataDir, fetchImpl = fetch, now = Date.now, config = loadConfig(dataDir), auth, credentials} = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.config = config;
    this.catalogCache = new CatalogCache();
    this.settings = modelSettings(config.settingsFile);
    this.credentials = credentials || new MaasCredentials({now, fallbackBase: config.maasBase});
    this.auth = auth || new QwenWorkAuth({accounts: new AccountStore(config.accountFile), config, fetchImpl, now, onChange: () => this.credentials.clear()});
    bindAccountCatalog(this, {reset: () => this.credentials.clear()});
  }
  get cache() { return this.catalogCache.value; }
  signal(signal, ms) { return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms); }
  snapshot() {
    const credential = this.auth.account?.credential;
    return {
      ...sourceSnapshot({
        ...sourceDescription,
        configured: !!credential,
        identityKey: this.auth.account?.id,
        connected: !!this.cache && this.cache.identity === this.auth.account?.id && !this.lastError,
        error: this.lastError,
        checkedAt: this.cache?.at,
      }),
      account: credential ? {login: credential.login, organization: credential.organization} : undefined,
    };
  }
  async officeToken(signal) {
    const account = await this.auth.accounts.require();
    if (account.environment !== this.config.openApiBase) throw authError('登录环境已变化，请重新登录');
    if (account.credential.expires < this.now() + 60_000) await this.auth.refresh();
    const current = await this.auth.accounts.require();
    assertEnvironment(current.credential.access, this.config.openApiBase);
    if (signal?.aborted) throw signal.reason;
    return current;
  }
  async listModels(force = false) {
    const account = await this.officeToken();
    const epoch = this.auth.epoch;
    const cache = await this.catalogCache.get({
      identity: account.id,
      refresh: typeof force === 'object' ? force.refresh === true : force,
      load: async () => {
        const response = await officeRequest(this.fetchImpl, this.config, '/api/desktop/chat-modes', {token: account.credential.access, signal: this.signal(undefined, 15_000)});
        if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw authError('千问办公登录已失效，请重新登录', response.status); }
        if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`千问办公模型目录获取失败（${response.status}）`), {status: response.status}); }
        const models = adaptChatModes(await response.json(), this.config.scene);
        if (epoch !== this.auth.epoch || (await this.auth.accounts.load())?.id !== account.id) throw authError('千问办公账号已切换，请重新请求');
        return {models};
      },
    });
    this.lastError = null;
    return modelCapabilities(applyModelSettings(cache.models, await this.settings.read()), ['enabled', 'effort']);
  }
  async status(force = false) { return checkAccountCatalog(this, force, {error: error => operationError(error, '千问办公检测失败，请检查登录状态与网络')}); }
  async setModel(input) {
    const model = (await this.listModels()).find(item => item.id === input.id);
    if (!model) throw invalid('模型不存在');
    await this.settings.save(model, input, {fields: ['enabled', 'effort', 'contextWindow', 'maxOutputTokens'], invalid, error: '不支持的千问办公模型设置'});
    return this.listModels();
  }
  async execute(input, context = {}) {
    const conversationId = context.conversationId ?? input?.conversationId;
    return {kind: 'response', ...await this.forward(input.raw, input.protocol, {...context, conversationId})};
  }
  async credentialFor(account, {signal, force = false, conversationId} = {}) {
    const credential = await this.credentials.resolve({
      identity: `${account.environment}\0${account.id}`,
      sessionId: conversationScope(conversationId),
      officeToken: account.credential.access,
      openApiBase: this.config.openApiBase,
      headers: qwenWorkHeaders(this.config),
      fetchImpl: (url, options) => this.fetchImpl(url, {...options, signal: this.signal(signal, 30_000)}),
      signal: this.signal(signal, 30_000),
      force,
    });
    return {...credential, identity: account.id};
  }
  async forward(raw, protocol, {signal, observe = () => {}, conversationId} = {}) {
    const epoch = this.auth.epoch;
    observe({stage: 'discovery'});
    const model = (await this.listModels()).find(item => item.id === raw.model && item.enabled);
    const identity = this.cache?.identity;
    if (!model) throw invalid('千问办公模型已停用或不存在');
    const target = model.nativeProtocols.includes(protocol) ? protocol : model.nativeProtocols[0];
    observe({stage: 'conversion', upstreamModel: model.upstreamId});
    const body = prepareUpstreamRequest(raw, protocol, target);
    body.model = model.upstreamId;
    const effort = (target === 'responses' ? body.reasoning?.effort : target === 'messages' ? body.output_config?.effort : body.reasoning_effort) ?? model.effort;
    if (effort !== undefined) {
      if (!model.reasoningEfforts?.includes(effort)) throw invalid('该千问办公模型未提供此思考强度');
      if (target === 'responses') body.reasoning = {...body.reasoning, effort};
      else if (target === 'messages') { body.thinking = {type: 'adaptive'}; body.output_config = {...body.output_config, effort}; }
      else body.reasoning_effort = effort;
    }
    observe({stage: 'authentication'});
    const account = await this.officeToken(signal);
    if (account.id !== identity || epoch !== this.auth.epoch) throw authError('千问办公账号已切换，请重新请求');
    let credential = await this.credentialFor(account, {signal, conversationId});
    observe({stage: 'upstream'});
    let response = await this.send(target, body, credential, signal);
    if (response.status === 401) {
      await response.body?.cancel();
      const freshAccount = await this.officeToken(signal);
      if (freshAccount.id !== account.id || epoch !== this.auth.epoch) throw authError('千问办公账号已切换，请重新请求');
      credential = await this.credentialFor(freshAccount, {signal, force: true, conversationId});
      if (credential.identity !== account.id) throw authError('千问办公账号已切换，请重新请求');
      response = await this.send(target, body, credential, signal);
    }
    return {response, protocol: target, streaming: body.stream === true, model: model.id, upstreamModel: model.upstreamId};
  }
  send(protocol, body, credential, signal) {
    const deadline = headerDeadline(signal, 300_000);
    return this.fetchImpl(inferenceUrl(credential.baseUrl, protocol), {
      method: 'POST', redirect: 'error',
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        'Content-Type': 'application/json',
        Accept: body.stream ? 'text/event-stream' : 'application/json',
        ...(credential.sessionId ? {'x-session-id': credential.sessionId} : {}),
        ...(protocol === 'messages' ? {'anthropic-version': '2023-06-01'} : {}),
      },
      body: JSON.stringify(body),
      signal: deadline.signal,
    }).finally(() => deadline.settle());
  }
  close() { this.catalogCache.invalidate(); this.credentials.clear(); }
}
