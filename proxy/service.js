import {KimiProvider} from './kimi/provider.js';
import {createPiConfig} from '../cli/pi-config.js';
import {CodexProvider} from './codex/provider.js';
import {createProxyTools} from './shared/tools.js';
import {Readable} from 'node:stream';
import {CustomSources} from './custom/provider.js';
import {relay} from './shared/relay.js';
import { observeResponse } from './shared/protocol.js';
import { GrokProvider } from './grok/provider.js';
import { renderNativeStream, renderNativeResponse } from './grok/responses.js';
import { AgyProvider } from './agy/provider.js';
import { ModelRouter, retryableRouteError } from './shared/router.js';
import { RequestRecords, RequestTrace } from './shared/request-records.js';
import { SourceState } from './shared/source-state.js';
import { protocolFor } from './shared/contracts.js';
import http from 'node:http';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { normalizeEffort } from './shared/llm/index.js';
import { loadConfig } from './qoder/config.js';
import { readJson, writeJson, serial } from './shared/store.js';
import { AccountStore } from './qoder/account-store.js';
import { QoderHttp } from './qoder/http.js';
import { QoderProvider } from './qoder/provider.js';
import { startAuthorize, pollLogin } from './qoder/oauth.js';
import { loadSettings, saveSettings, applyModelsCommand } from './qoder/settings.js';
import { decodeChatRequest, renderChatStream, renderChatResponse } from './shared/protocols/openai-chat.js';
import { decodeResponsesRequest, renderResponsesStream, renderResponsesResponse } from './shared/protocols/openai-responses.js';
import { decodeMessagesRequest, renderMessagesStream, renderMessagesResponse } from './shared/protocols/anthropic-messages.js';
import { renderModelList } from './shared/protocols/models-list.js';

export const equalSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function send(res, code, value) {
  if (res.destroyed) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
export async function readBody(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 4_000_000) throw Object.assign(new Error('请求超过 4 MB'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
  catch { throw Object.assign(new Error('请求必须是有效 JSON'), { status: 400 }); }
}
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const adapters = {
  '/chat/completions': [decodeChatRequest, renderChatStream, renderChatResponse],
  '/responses': [decodeResponsesRequest, renderResponsesStream, renderResponsesResponse],
  '/messages': [decodeMessagesRequest, renderMessagesStream, renderMessagesResponse],
};
const errorStatus = code => code === '429' ? 429 : ['10605', '503'].includes(code) ? 503 : ['model_not_found', 'invalid_request'].includes(code) ? 400 : 502;

export async function createProxyService({ dataDir, fetchImpl = fetch, config: overrides = {}, provider: injectedProvider, agyProvider, grokProvider, includeGrok = false, includeAgy = false, includeGateway = false, codexProvider, kimiProvider, customSources, piOptions = {} } = {}) {
  const config = { ...loadConfig(dataDir), ...overrides };
  const directory = path.dirname(config.accountFile), serviceFile = path.join(directory, 'service.json');
  const usageFile = path.join(directory, 'usage.json');
  const accounts = new AccountStore(config.accountFile);
  // Transport deadline also covers model discovery and login, not just inference.
  const transport = (url, options = {}) => fetchImpl(url, { ...options, redirect: 'error', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(30_000) });
  const upstream = new QoderHttp(config, transport), provider = injectedProvider || new QoderProvider(config, upstream, accounts);
  const agy = agyProvider || (includeAgy ? new AgyProvider({ dataDir, fetchImpl }) : null);
  const grok = grokProvider || (includeGrok ? new GrokProvider({ dataDir, fetchImpl }) : null);
  const codex = codexProvider || (includeGateway ? new CodexProvider({dataDir,fetchImpl}) : null);
  const kimi = kimiProvider || (includeGateway ? new KimiProvider({dataDir,fetchImpl}) : null);
  const custom = customSources || (includeGateway ? new CustomSources({dataDir,fetchImpl,getPort:()=>settings.port}) : null);
  const providers = {...(kimi ? {kimi} : {}), ...(codex ? {codex} : {}),  qoder: provider, ...(agy ? { agy } : {}), ...(grok ? { grok } : {}) };
  const sourceState = new SourceState();
  const router = new ModelRouter(providers, {
    routesFile: path.join(directory, 'model-routes.json'), cacheRoutesMs: 300000,
    onCatalog: (id, models, error, provider) => sourceState.checked(id, provider, models, error),
    getSourceHealth: () => sources(),
    retrySource: (id, model) => id.startsWith('custom:') ? testCustom(id.slice(7), model) : undefined,
  });
  const listModels = (id, force = false) => router.refreshSource(id, force);
  async function catalogStatus(id, force) {
    const result = await providers[id].status(force);
    if (result.connected) { router.failedAt.delete(id); await listModels(id); }
    else router.setCatalog(id, undefined, new Error('Source unavailable'));
    return result;
  }
  let settings = await readJson(serviceFile, { port: 4319, autoStart: false, apiKey: randomBytes(32).toString('hex') });
  if (!Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535 || typeof settings.autoStart !== 'boolean' || !/^[a-f0-9]{64}$/.test(settings.apiKey)) throw new Error('代理配置无效，原文件已保留');
  await writeJson(serviceFile, settings);
  if (custom) Object.assign(providers, await custom.providers());
  async function updateModel(id, input) {
    const models = await providers[id].setModel(input);
    router.setCatalog(id, models);
    return models;
  }
  async function discoverCustom(input,{withKeys=false}={}) {
    const source = typeof input === 'object' ? input : (await custom.list()).find(s => s.id === input);
    try { const result = await custom.discoverAll(input); if (typeof input === 'string') sourceState.discovered(source, result.models); return withKeys?result:result.models; }
    catch (error) { if (typeof input === 'string' && source) sourceState.discovered(source, null, error); throw error; }
  }
  async function testCustom(id, modelId) {
    const p = (await custom.providers())['custom:' + id];
    if (!p) fail('来源不存在或已停用');
    const m = (await p.listModels()).find(m => m.enabled && (!modelId || m.id === modelId));
    if (!m) fail('请先保存至少一个模型');
    const protocol = p.source.protocol, endpoint = { chat: '/chat/completions', responses: '/responses', messages: '/messages' }[protocol];
    const raw = { model: m.id, stream: false, ...(protocol === 'responses' ? { input: 'Reply OK', max_output_tokens: 32 } : { messages: [{ role: 'user', content: 'Reply OK' }], max_tokens: 32 }) };
    const trace = new RequestTrace(endpoint);
    trace.observe({ origin: 'test', provider: 'custom:' + id, model: m.id, streaming: false, sourceRevision: sourceState.revision('custom:' + id, p), upstreamModel: m.upstreamId, upstreamProtocol: protocol, execution: 'native' });
    let status = 200;
    try {
      const { response } = await p.forward(raw, protocol, { signal: AbortSignal.timeout(60000), observe: info => trace.observe(info) });
      trace.observe({ stage: 'response', upstreamStatus: response.status });
      if (!response.ok) { trace.fail({ status: response.status }); await response.body?.cancel(); fail(`推理测试失败（${response.status}）`); }
      const data = await response.json();
      observeResponse(data, protocol, info => trace.observe(info));
      if (data.error || (!data.choices && !data.content && !data.output)) fail('上游未返回有效的模型响应');
      trace.observe({ finish: data.status === 'incomplete' || data.choices?.[0]?.finish_reason === 'length' || data.stop_reason === 'max_tokens' ? 'length' : 'stop' });
      return { message: '推理请求成功；流式与工具能力需按实际使用验证。' };
    } catch (error) { status = error.status || 502; trace.fail(error); throw error; }
    finally { await records.append(trace.finish(status, status)); }
  }
  async function syncSources() {
    if (!custom) return;
    const next = await custom.providers();
    for (const id of Object.keys(providers)) if (id.startsWith('custom:') && !next[id]) {
      delete providers[id]; router.invalidateSource(id);
    }
    for (const [id, provider] of Object.entries(next)) {
      providers[id] = provider; router.setCatalog(id, await provider.listModels());
    }
  }
  const records = await RequestRecords.load(usageFile);
  const sources = async () => {
    const account = await accounts.load();
    if (!injectedProvider && provider.cache?.id !== account?.id) {
      sourceState.invalidate('qoder');
      if (router.catalogs.has('qoder')) router.invalidateSource('qoder');
    }
    return sourceState.snapshot(providers, custom ? await custom.list() : [], records.rows, router.conflicts, !!account || !!injectedProvider);
  };
  let listener, state = 'stopped', startedAt = null, lastError = '', pending, polling;
  const mutate = serial(), active = new Set(), finishing = new Set();
  const status = async () => {
    const account = await accounts.load();
    return { state, startedAt, activeRequests: active.size, port: settings.port, autoStart: settings.autoStart,
      baseUrl: `http://127.0.0.1:${settings.port}/v1`, lastError,
      node: { path: process.execPath, version: process.version },
      account: account ? { uid: account.credential.uid, organization: account.credential.organizationName, plan: account.credential.plan } : null,
      sources: Object.fromEntries(Object.entries(providers).map(([id, p]) => [id, { connected: id === 'qoder' ? !!account : !!p.cache && !p.lastError && !router.errors[id], error: p.lastError || router.errors[id] }])),
      conflicts: router.conflicts || [],
      login: pending ? { url: pending.url, expiresAt: pending.expiresAt } : null };
  };
  async function gateway(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const expected = `127.0.0.1:${settings.port}`;
    if (req.headers.host !== expected || req.headers.origin) return send(res, 403, { error: { message: '仅允许本机客户端访问' } });
    const key = req.headers.authorization?.replace(/^Bearer /, '') || req.headers['x-api-key'];
    if (!equalSecret(key, settings.apiKey)) return send(res, 401, { error: { message: 'API Key 无效', type: 'authentication_error' } });
    const route = new URL(req.url, `http://${expected}`).pathname.replace(/^\/api\/qoder(?=\/v1\/)/, '').replace(/^\/v1/, '');
    const controller = new AbortController();
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(() => deadline.abort(), 300_000);
    let model = '', sourceId, routedProvider, code = 200;
    const trace = req.method === 'POST' && protocolFor(route) ? new RequestTrace(route) : null;
    const observe = info => {
      if (info.stage === 'upstream' && sourceId) info = { ...info, sourceRevision: sourceState.revision(sourceId, routedProvider) };
      trace.observe(info);
    };
    const completion = Promise.withResolvers();
    active.add(controller); finishing.add(completion.promise);
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnected);
    try {
      if (route === '/models' && req.method === 'GET') return send(res, 200, renderModelList(await router.listModels()));
      const adapter = adapters[route];
      if (!adapter || req.method !== 'POST') return send(res, 404, { error: { message: '接口不存在' } });
      const body = await readBody(req);
      if (!body || typeof body.model !== 'string' || !body.model.trim() || body.model.length > 200) fail('需要有效的 model');
      model = body.model;
      observe({ model, streaming: body.stream === true });
      if (body.stream !== undefined && typeof body.stream !== 'boolean') fail('stream 必须为布尔值');
      if (route !== '/responses' && !Array.isArray(body.messages)) fail('messages 必须为数组');
      if (route === '/responses' && typeof body.input !== 'string' && !Array.isArray(body.input)) fail('input 必须为文本或数组');
      const effort = body.reasoning_effort ?? body.reasoning?.effort ?? body.output_config?.effort;
      if (effort !== undefined && (typeof effort !== 'string' || !normalizeEffort(effort))) fail('推理强度无效');
      observe({ stage: 'routing' });
      const conversationId=req.headers['x-daylight-conversation-id'];
      if(conversationId!==undefined&&(typeof conversationId!=='string'||!conversationId.trim()||conversationId.length>200))fail('对话标识需为 1–200 个字符');
      const stateful=!!(body.previous_response_id || body.conversation);
      const candidates=await router.candidates({model},{conversationId,stateful});
      let iterator, firstStep;
      for(const [index,routed] of candidates.entries()) {
        sourceId=routed.provider;routedProvider=providers[sourceId];
        observe({provider:sourceId,sourceRevision:sourceState.revision(sourceId,routedProvider),upstreamModel:routed.upstreamId || routed.id});
        let accepted=false;
        try {
          if(routedProvider.forward) {
            clearTimeout(deadlineTimer);
            await relay(routedProvider,body,protocolFor(route),res,controller.signal,observe,{conversationId:sourceId.startsWith('custom:')?conversationId:undefined,onAccepted:()=>{accepted=true;}});
            router.success(routed,conversationId);return;
          }
          observe({stage:'conversion',execution:'adapted'});
          let request;
          try {request={...adapter[0](body),raw:body};}catch{fail('请求格式不正确，请检查消息与工具字段');}
          if(sourceId==='grok')clearTimeout(deadlineTimer);
          iterator=routedProvider.stream(request,{signal:AbortSignal.any([controller.signal,deadline.signal]),observe})[Symbol.asyncIterator]();
          firstStep=await iterator.next();
          if(firstStep.value?.type==='error' && index<candidates.length-1 && !stateful && retryableRouteError(firstStep.value)) {
            observe({provider:sourceId,routeFailure:firstStep.value});router.failed(routed);await iterator.return?.();continue;
          }
          if(firstStep.value?.type!=='error')router.success(routed,conversationId);
          break;
        } catch(error) {
          await iterator?.return?.();iterator=undefined;
          if(accepted || res.headersSent || stateful || controller.signal.aborted || index===candidates.length-1 || !retryableRouteError(error))throw error;
          observe({provider:sourceId,routeFailure:error});router.failed(routed);
        }
      }
      async function* observed() {
        try {
          for (;;) {
            const step = firstStep || await iterator.next(); firstStep=undefined; if (step.done) return;
            const event = step.value;
            trace.event(event);
            if (event.type === 'error') code = errorStatus(event.code);
            yield event;
          }
        } finally { await iterator.return?.(); }
      }
      const events = observed(), first = await events.next();
      const renderStream = sourceId === 'grok' && route === '/responses' ? renderNativeStream : adapter[1];
      const renderResponse = sourceId === 'grok' && route === '/responses' ? renderNativeResponse : adapter[2];
      if (first.value?.type === 'error') { await events.return(); return send(res, code, { error: { message: first.value.message, code: first.value.code, param: first.value.param, type: first.value.code === 'invalid_request' ? 'invalid_request_error' : 'upstream_error' } }); }
      async function* replay() { try { if (!first.done) yield first.value; yield* events; } finally { await events.return(); } }
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        for await (const chunk of renderStream(replay(), model)) {
          controller.signal.throwIfAborted();
          if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
        }
        res.end();
      } else send(res, 200, await renderResponse(replay(), model));
    } catch (error) {
      if (trace) trace.fail(error, controller.signal.aborted ? 'cancelled' : deadline.signal.aborted || error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : 'failed');
      code = controller.signal.aborted ? 499 : error.status || (error.code ? errorStatus(error.code) : 502);
      const message = error.status ? error.message : controller.signal.aborted ? '请求已取消' : '代理请求失败，请检查账号与网络后重试';
      if (!res.headersSent) send(res, code, { error: { message, type: 'proxy_error' } });
      else { res.write(`event: error\ndata: ${JSON.stringify({ error: { message, type: 'proxy_error' } })}\n\n`); res.end(); }
    } finally {
      clearTimeout(deadlineTimer);
      active.delete(controller); res.off('close', disconnected);
      try {
        if (trace) {
          if (controller.signal.aborted) trace.entry.outcome = 'cancelled';
          await records.append(trace.finish(code, res.headersSent ? res.statusCode : undefined));
        }
      } finally { finishing.delete(completion.promise); completion.resolve(); }
    }
  }
  async function start() {
    if (state === 'running') return;
    state = 'starting'; lastError = '';
    try {
      if (!agy && !grok && !injectedProvider) await accounts.require();
      // Check credential/model readiness before reporting the switch as running.
      // One ready source is sufficient; a slower source must not delay auto-start.
      await Promise.any(Object.keys(providers).map(id => listModels(id)));
      const server = http.createServer(gateway);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(settings.port, '127.0.0.1', resolve); });
      listener = server; state = 'running'; startedAt = new Date().toISOString();
    } catch (error) {
      state = 'stopped'; startedAt = null;
      lastError = error.code === 'EADDRINUSE' ? `端口 ${settings.port} 已被占用，请在设置中更换端口` : error.message === '请先登录 Qoder' ? error.message : '启动失败，请检查模型来源的登录状态与网络';
      fail(lastError, 409);
    }
  }
  async function stop(force = false) {
    if (!listener) return;
    if (active.size && !force) fail(`仍有 ${active.size} 个请求正在进行`, 409);
    state = 'stopping';
    for (const controller of active) controller.abort();
    const server = listener; listener = null;
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
    await Promise.all(finishing);
    state = 'stopped'; startedAt = null;
  }
  const close = () => mutate(async () => {await pi.close();await stop(true);kimi?.close?.();});
  const tools=createProxyTools({dataDir,custom,discoverCustom:id=>discoverCustom(id,{withKeys:true}),getSources:sources,getRoutes:()=>router.routes(),call:(url,input)=>new Promise((resolve,reject)=>{
    const req=Readable.from(input===undefined?[]:[Buffer.from(JSON.stringify(input))]);req.url=url;req.method=input===undefined?'GET':'POST';
    let code;handle(req,{destroyed:false,writeHead(status){code=status;},end(text){const value=JSON.parse(text);code<400?resolve(value):reject(Object.assign(new Error(value.error),{status:code}));}}).catch(reject);
  })});
  const pi = createPiConfig({ ...piOptions, dataDir,
    getGateway: async () => ({ state, baseUrl: `http://127.0.0.1:${settings.port}/v1`, apiKey: settings.apiKey }),
    getCatalog: async force => {
      const definitions = await sources();
      const catalog = await (force ? router.listModels(true) : router.cachedModels());
      const failedSources = definitions.filter(s => s.enabled && s.configured && router.errors[s.id]).map(s => ({ id:s.id, name:s.name, unconfigured:!router.catalogs.has(s.id) }));
      return { failedSources, models: catalog.filter(m => m.enabled).map(m => ({
      id: m.id, name: m.displayName || m.id, source: m.provider,
      sourceName: providers[m.provider]?.source?.name || ({qoder:'Qoder',agy:'AGY',grok:'Grok',codex:'Codex',kimi:'Kimi'}[m.provider] || m.provider),
      ...(providers[m.provider]?.source?.protocol ? {nativeProtocol:providers[m.provider].source.protocol} : {}),
      ...((m.contextWindow || m.contextWindows?.find(w=>w.isDefault)?.length) ? {contextWindow:m.contextWindow || m.contextWindows.find(w=>w.isDefault).length} : {}), ...(m.maxOutputTokens ? {maxOutputTokens:m.maxOutputTokens} : {}),
      ...(m.reasoningEfforts?.length ? {reasoningEfforts:m.reasoningEfforts} : {}), ...(m.thinkingLevelMap ? {thinkingLevelMap:m.thinkingLevelMap} : {}),
      ...(typeof m.isReasoning === 'boolean' ? {isReasoning:m.isReasoning} : {}), ...(typeof m.isVL === 'boolean' ? {isVL:m.isVL} : {}),
      })) };
    },
  });
  await pi.start();
  async function handle(req, res) {
    const route = new URL(req.url, 'http://localhost').pathname;
    try {
      if (route.startsWith('/api/cli/pi/')) {
        const operation = route.slice('/api/cli/pi/'.length);
        if (!['state','prepare','apply','restore','automatic','configuration'].includes(operation) || req.method !== (operation === 'state' ? 'GET' : 'POST')) fail('接口不存在',404);
        const query = new URL(req.url,'http://localhost').searchParams;
        return send(res,200,operation === 'state' ? await pi.state(query.get('api') || undefined, query.has('refresh')) : await pi[operation](await readBody(req)));
      }
      if (route.startsWith('/api/proxy/')) {
        if (route === '/api/proxy/routes' && req.method === 'GET') {
          const query = new URL(req.url,'http://localhost').searchParams;
          return send(res,200,{routes:await router.routes({refresh:query.get('refresh')==='1',retry:query.get('retry') || undefined})});
        }
        if (route === '/api/proxy/routes' && req.method === 'POST') { await router.routes();return send(res,200,await router.saveRoute(await readBody(req))); }
        if (req.method !== 'GET') fail('接口不存在', 404);
        if (route === '/api/proxy/status') return send(res, 200, { ...await status(), recordsError: records.error });
        if (route === '/api/proxy/sources') return send(res, 200, { sources: await sources() });
        if (route === '/api/proxy/requests') {
          const query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
          const limit = query.limit === undefined ? 100 : Number(query.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail('记录数量需为 1–1000 的整数');
          return send(res, 200, records.query({ ...query, limit }));
        }
        fail('接口不存在', 404);
      }
      if(route.startsWith('/api/proxy-tools/')){
        const operation=route.slice('/api/proxy-tools/'.length);
        if(!['state','prepare','discover','test','apply','loginState','requests','read'].includes(operation)||req.method!==(operation==='state'?'GET':'POST'))fail('接口不存在',404);
        return send(res,200,await tools[operation](operation==='state'?undefined:await readBody(req)));
      }
      if(route.startsWith('/api/kimi-proxy/')){
        if(!kimi)fail('Kimi 未启用',404);
        if(route==='/api/kimi-proxy/status'&&req.method==='GET')return send(res,200,await catalogStatus('kimi',new URL(req.url,'http://localhost').searchParams.has('refresh')));
        if(route==='/api/kimi-proxy/auth/login'&&req.method==='POST')return send(res,200,await kimi.auth.login());
        if(route==='/api/kimi-proxy/auth/poll'&&req.method==='GET')return send(res,200,await kimi.auth.poll());
        if(route==='/api/kimi-proxy/auth/cancel'&&req.method==='POST')return send(res,200,await kimi.auth.cancel());
        if(route==='/api/kimi-proxy/quota'&&req.method==='GET')return send(res,200,await kimi.quota());
        if(route==='/api/kimi-proxy/models'&&req.method==='GET')return send(res,200,{models:await listModels('kimi',new URL(req.url,'http://localhost').searchParams.has('refresh'))});
        if(route==='/api/kimi-proxy/models/setting'&&req.method==='POST'){const models=await updateModel('kimi',await readBody(req));return send(res,200,{models});}
        if(route==='/api/kimi-proxy/test'&&req.method==='POST'){
          const model=(await listModels('kimi')).find(m=>m.enabled);if(!model)fail('请先启用一个 Kimi 模型');
          const trace=new RequestTrace('/chat/completions');trace.observe({origin:'test',provider:'kimi',model:model.id,streaming:false,sourceRevision:sourceState.revision('kimi',kimi)});let status=200;
          try{const {response}=await kimi.forward({model:model.id,messages:[{role:'user',content:'Reply OK'}],max_tokens:32,stream:false},'chat',{signal:AbortSignal.timeout(60000),observe:info=>trace.observe(info)});trace.observe({upstreamStatus:response.status});if(!response.ok){await response.body?.cancel();throw Object.assign(new Error(`Kimi 推理测试失败（${response.status}）`),{status:response.status});}const data=await response.json();if(!data.choices||data.error)fail('Kimi 未返回有效的模型响应');observeResponse(data,'chat',info=>trace.observe(info));trace.observe({finish:data.choices[0]?.finish_reason==='length'?'length':'stop'});return send(res,200,{message:'Kimi 推理请求成功；流式与工具调用需分别验证。'});}catch(error){status=error.status||502;trace.fail(error);throw error;}finally{await records.append(trace.finish(status,status));}
        }
        fail('接口不存在',404);
      }
      if(route.startsWith('/api/codex-proxy/')){
        if(!codex)fail('Codex 未启用',404);
        if(route.endsWith('/status')&&req.method==='GET')return send(res,200,await catalogStatus('codex',new URL(req.url,'http://localhost').searchParams.has('refresh')));
        if(route==='/api/codex-proxy/quota'&&req.method==='GET')return send(res,200,await codex.quota());
        if(route.endsWith('/models')&&req.method==='GET')return send(res,200,{models:await listModels('codex', new URL(req.url,'http://localhost').searchParams.has('refresh'))});
        if(route.endsWith('/models/setting')&&req.method==='POST')return send(res,200,{models:await updateModel('codex',await readBody(req))});
        fail('接口不存在',404);
      }
      if(route.startsWith('/api/custom-proxy/')){
        if(!custom)fail('自定义上游未启用',404);
        if(route.endsWith('/sources')&&req.method==='GET'){await router.listModels().catch(()=>{});return send(res,200,{sources:await custom.list(),conflicts:router.conflicts});}
        if(req.method!=='POST')fail('接口不存在',404);const b=await readBody(req);
        if(route.endsWith('/key'))return send(res,200,{apiKey:await custom.readKey(b.id,b.keyId)});
        if(route.endsWith('/save')){const source=await custom.save(b);sourceState.invalidate('custom:'+source.id);await syncSources();return send(res,200,{source});}
        if(route.endsWith('/delete')){await custom.remove(b.id);await router.forgetSource('custom:'+b.id);sourceState.invalidate('custom:'+b.id);await syncSources();return send(res,200,{ok:true});}
        if(route.endsWith('/test'))return send(res,200,await testCustom(b.id));
        if(route.endsWith('/discover'))return send(res,200,await discoverCustom(b.config||b.id,{withKeys:true}));
        fail('接口不存在',404);
      }
      if (route.startsWith('/api/grok/')) {
        if (!grok) fail('Grok 未启用', 404);
        if (route === '/api/grok/status' && req.method === 'GET') return send(res, 200, await catalogStatus('grok',new URL(req.url,'http://localhost').searchParams.has('refresh')));
        if (route === '/api/grok/models' && req.method === 'GET') return send(res, 200, { models: await listModels('grok', new URL(req.url, 'http://localhost').searchParams.has('refresh')), discoveredAt: new Date(grok.cache.at).toISOString() });
        if (route === '/api/grok/models/setting' && req.method === 'POST') return send(res, 200, { models: await updateModel('grok', await readBody(req)) });
        if (route === '/api/grok/quota' && req.method === 'GET') return send(res, 200, await grok.quota());
        fail('接口不存在', 404);
      }
      if (route.startsWith('/api/agy/')) {
        if (!agy) fail('AGY 未启用', 404);
        if (route === '/api/agy/quota' && req.method === 'GET') return send(res, 200, await agy.quota());
        if (route === '/api/agy/models' && req.method === 'GET') return send(res, 200, { models: await listModels('agy', new URL(req.url, 'http://localhost').searchParams.has('refresh')), discoveredAt: new Date(agy.cache.at).toISOString() });
        if (route === '/api/agy/models/setting' && req.method === 'POST') return send(res, 200, { models: await updateModel('agy', await readBody(req)) });
        if (route === '/api/agy/status' && req.method === 'GET') {
          try { await listModels('agy', true); delete router.errors.agy; router.failedAt.delete('agy'); return send(res, 200, { connected: true }); }
          catch { router.errors.agy = '无法连接 AGY，请在终端运行 agy 登录后刷新'; return send(res, 200, { connected: false, error: router.errors.agy }); }
        }
        fail('接口不存在', 404);
      }
      if (route === '/api/qoder/status' && req.method === 'GET') return send(res, 200, await status());
      if (route === '/api/qoder/key' && req.method === 'GET') return send(res, 200, { apiKey: settings.apiKey });
      if (route === '/api/qoder/models' && req.method === 'GET') return send(res, 200, { models: await listModels('qoder', new URL(req.url, 'http://localhost').searchParams.has('refresh')) });
      if (route === '/api/qoder/credits' && req.method === 'GET') return send(res, 200, await provider.credits());
      if (route === '/api/qoder/usage' && req.method === 'GET') return send(res, 200, records.legacy());
      if (req.method !== 'POST') return send(res, 404, { error: '接口不存在' });
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail('请求格式不正确');
      if (route === '/api/qoder/auth/poll') {
        if (!pending || Date.now() > pending.expiresAt) { pending = null; fail('登录链接已过期，请重新登录'); }
        if (!polling) {
          const login = pending;
          polling = pollLogin(upstream, config, login, transport).then(account => accounts.run(async () => {
            if (pending !== login) return false;
            if (account) { await accounts.save(account); pending = null; provider.clear(); sourceState.invalidate('qoder'); router.invalidateSource('qoder'); return true; }
            return false;
          })).finally(() => { polling = null; });
        }
        return send(res, 200, { authorized: await polling });
      }
      const result = await mutate(async () => {
        switch (route) {
          case '/api/qoder/service':
            if (typeof body.enabled !== 'boolean') fail('enabled 必须为布尔值');
            if (body.enabled) await start(); else await stop(body.force === true);
            return status();
          case '/api/qoder/settings': {
            if (state !== 'stopped') fail('请先停止代理再修改设置', 409);
            const port = body.port;
            if (!Number.isInteger(port) || port < 1024 || port > 65535 || typeof body.autoStart !== 'boolean') fail('端口需为 1024–65535 的整数');
            const next = { ...settings, port, autoStart: body.autoStart }; await writeJson(serviceFile, next); settings = next; lastError = '';
            return status();
          }
          case '/api/qoder/auth/device':
            if (state !== 'stopped') fail('请先停止代理再更换账号', 409);
            pending = startAuthorize(config); return { url: pending.url, expiresAt: pending.expiresAt };
          case '/api/qoder/auth/cancel': pending = null; return { ok: true };
          case '/api/qoder/auth/logout':
            if (state !== 'stopped') fail('请先停止代理再退出账号', 409);
            pending = null; await accounts.logout(); provider.clear(); sourceState.invalidate('qoder'); router.invalidateSource('qoder'); return status();
          case '/api/qoder/key/rotate':
            if (state !== 'stopped') fail('请先停止代理再更换密钥', 409);
            settings = { ...settings, apiKey: randomBytes(32).toString('hex') }; await writeJson(serviceFile, settings); return { apiKey: settings.apiKey };
          case '/api/qoder/models/setting': {
            if (!['enabled', 'context', 'effort', 'fast'].includes(body.field) || typeof body.id !== 'string') fail('模型设置字段无效');
            if (['enabled', 'fast'].includes(body.field) && typeof body.value !== 'boolean') fail('开关值无效');
            const models = await listModels('qoder');
            if (body.field === 'fast' && body.value && !models.find(m => m.id === body.id)?.supportsFast) fail('该模型不支持 Fast');
            const settings = await loadSettings(config.accountFile);
            const command = body.field === 'enabled' ? (body.value ? 'enable' : 'disable') : body.field;
            const value = body.field === 'fast' ? (body.value ? 'on' : 'off') : String(body.value);
            let next;
            try { next = applyModelsCommand(command, [body.id, value], settings, models).settings; } catch (error) { fail(error.message); }
            await saveSettings(config.accountFile, next); return { models: await listModels('qoder') };
          }
          case '/api/qoder/test':
            if (state !== 'running') fail('请先开启代理');
            // Exercise the authenticated local gateway as a client would, without spending inference tokens.
            { const response = await fetch(`http://127.0.0.1:${settings.port}/v1/models`, { headers: { Authorization: `Bearer ${settings.apiKey}` }, signal: AbortSignal.timeout(30_000) });
              if (!response.ok) fail('连接测试失败，请检查账号与网络', 502);
              const result = await response.json(); return { message: `连接正常，${result.data.length} 个模型可用（未发送推理请求）` }; }
          default: fail('接口不存在', 404);
        }
      });
      send(res, 200, result);
    } catch (error) { send(res, error.status || 502, { error: error.status ? error.message : '操作失败，请检查对应来源的登录状态、网络或本地配置' }); }
  }
  // Startup errors belong to this module, never prevent task management from opening.
  const initialize = () => settings.autoStart ? mutate(start).catch(() => {}) : Promise.resolve();
  return { handle, close, initialize, status, accounts };
}
