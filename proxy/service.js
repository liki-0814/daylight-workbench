import http from 'node:http';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createPiConfig} from '../cli/pi-config.js';
import {createProxyTools} from './shared/tools.js';
import {ModelRouter} from './shared/router.js';
import {RequestRecords} from './shared/request-records.js';
import {SourceState} from './shared/source-state.js';
import {readJson,writeJson,serial} from './shared/store.js';
import {createProviders} from './providers.js';
import {createGateway,fail} from './gateway.js';
import {createManagement,createLegacyReader} from './management.js';
export {send,readBody,equalSecret} from './gateway.js';

export async function createProxyService({ dataDir, fetchImpl = fetch, config: overrides = {}, provider: injectedProvider, agyProvider, grokProvider, includeGrok = false, includeAgy = false, includeGateway = false, codexProvider, kimiProvider, customSources, piOptions = {} } = {}) {
  const registry=createProviders({dataDir,fetchImpl,config:overrides,provider:injectedProvider,agyProvider,grokProvider,includeGrok,includeAgy,includeGateway,codexProvider,kimiProvider,customSources,getPort:()=>settings.port});
  const {config,accounts,custom,providers,qoder:provider}=registry;
  const directory=path.dirname(config.accountFile),serviceFile=path.join(directory,'service.json'),usageFile=path.join(directory,'usage.json');
  const sourceState = new SourceState();
  const router = new ModelRouter(providers, {
    routesFile: path.join(directory, 'model-routes.json'), cacheRoutesMs: 300000,
    onCatalog: (id, models, error, provider) => sourceState.checked(id, provider, models, error),
    getSourceHealth: () => sources(),
    retrySource: (id, model) => id.startsWith('custom:') ? management.testCustom(id.slice(7), model) : undefined,
  });
  const listModels=(id,refresh=false)=>router.refreshSource(id,refresh);
  let settings = await readJson(serviceFile, { port: 4319, autoStart: false, apiKey: randomBytes(32).toString('hex') });
  if (!Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535 || typeof settings.autoStart !== 'boolean' || !/^[a-f0-9]{64}$/.test(settings.apiKey)) throw new Error('代理配置无效，原文件已保留');
  await writeJson(serviceFile, settings);
  await registry.sync();
  const records = await RequestRecords.load(usageFile);
  const sources = async () => {
    const account = await accounts.load();
    if (!injectedProvider && registry.snapshot('qoder').catalogIdentityKey !== account?.id) {
      sourceState.invalidate('qoder');
      if (router.catalogs.has('qoder')) router.invalidateSource('qoder');
    }
    return sourceState.snapshot(providers, custom ? await custom.list() : [], records.rows, router.conflicts, !!account || !!injectedProvider,registry.snapshot);
  };
  let listener, state = 'stopped', startedAt = null, lastError = '';
  const mutate = serial(), active = new Set(), finishing = new Set();
  const gateway=createGateway({getSettings:()=>settings,router,registry,sourceState,records,active,finishing});
  const status = async () => {
    const account = await accounts.load();
    return { state, startedAt, activeRequests: active.size, port: settings.port, autoStart: settings.autoStart,
      baseUrl: `http://127.0.0.1:${settings.port}/v1`, lastError,
      node: { path: process.execPath, version: process.version },
      account: account ? { uid: account.credential.uid, organization: account.credential.organizationName, plan: account.credential.plan } : null,
      sources: Object.fromEntries(Object.keys(providers).map(id=>{const snapshot=registry.snapshot(id);return[id,{connected:id==='qoder'?!!account:snapshot.connected&&!router.errors[id],error:snapshot.error||router.errors[id],identityKey:snapshot.identityKey}];})),
      conflicts: router.conflicts || [],
      login: provider.auth?.pending ? {url:provider.auth.pending.url,expiresAt:provider.auth.pending.expiresAt} : null };
  };
  async function start() {
    if (state === 'running') return;
    state = 'starting'; lastError = '';
    try {
      if (Object.keys(providers).length===1 && !injectedProvider) await accounts.require();
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
  const close = () => mutate(async () => {await pi.close();await stop(true);await registry.close();});
  const pi = createPiConfig({ ...piOptions, dataDir,
    getGateway: async () => ({ state, baseUrl: `http://127.0.0.1:${settings.port}/v1`, apiKey: settings.apiKey }),
    getCatalog: async force => {
      const definitions = await sources();
      const catalog = await (force ? router.listModels(true) : router.cachedModels());
      const failedSources = definitions.filter(s => s.enabled && s.configured && router.errors[s.id]).map(s => ({ id:s.id, name:s.name, unconfigured:!router.catalogs.has(s.id) }));
      return { failedSources, models: catalog.filter(m => m.enabled).map(m => ({
      id: m.id, name: m.displayName || m.id, source: m.provider,
      sourceName: registry.snapshot(m.provider)?.name || m.provider,
      pi:registry.snapshot(m.provider)?.capabilities?.pi,
      ...(providers[m.provider]?.source?.protocol ? {nativeProtocol:providers[m.provider].source.protocol} : {}),
      ...((m.contextWindow || m.contextWindows?.find(w=>w.isDefault)?.length) ? {contextWindow:m.contextWindow || m.contextWindows.find(w=>w.isDefault).length} : {}), ...(m.maxOutputTokens ? {maxOutputTokens:m.maxOutputTokens} : {}),
      ...(m.reasoningEfforts?.length ? {reasoningEfforts:m.reasoningEfforts} : {}), ...(m.thinkingLevelMap ? {thinkingLevelMap:m.thinkingLevelMap} : {}),
      ...(typeof m.isReasoning === 'boolean' ? {isReasoning:m.isReasoning} : {}), ...(typeof m.isVL === 'boolean' ? {isVL:m.isVL} : {}),
      })) };
    },
  });
  await pi.start();
  const service={
    accountChange:(operation,apply)=>mutate(async()=>{if(state!=='stopped')fail(operation==='logout'?'请先停止代理再退出账号':'请先停止代理再更换账号',409);return apply();}),
    service:body=>mutate(async()=>{if(typeof body.enabled!=='boolean')fail('enabled 必须为布尔值');if(body.enabled)await start();else await stop(body.force===true);return status();}),
    settings:body=>mutate(async()=>{
      if(state!=='stopped')fail('请先停止代理再修改设置',409);
      if(!Number.isInteger(body.port)||body.port<1024||body.port>65535||typeof body.autoStart!=='boolean')fail('端口需为 1024–65535 的整数');
      const next={...settings,port:body.port,autoStart:body.autoStart};await writeJson(serviceFile,next);settings=next;lastError='';return status();
    }),
    key:()=>({apiKey:settings.apiKey}),
    'key/rotate':()=>mutate(async()=>{if(state!=='stopped')fail('请先停止代理再更换密钥',409);settings={...settings,apiKey:randomBytes(32).toString('hex')};await writeJson(serviceFile,settings);return{apiKey:settings.apiKey};}),
    check:async()=>{
      if(state!=='running')fail('请先开启代理');
      const response=await fetch(`http://127.0.0.1:${settings.port}/v1/models`,{headers:{Authorization:`Bearer ${settings.apiKey}`},signal:AbortSignal.timeout(30000)});
      if(!response.ok)fail('连接测试失败，请检查账号与网络',502);
      const result=await response.json();return{message:`连接正常，${result.data.length} 个模型可用（未发送推理请求）`};
    },
  };
  const management=createManagement({registry,router,sourceState,records,status,sources,service,pi,getTools:()=>tools});
  const tools=createProxyTools({dataDir,custom,discoverCustom:id=>management.discoverCustom(id,{withKeys:true}),getSources:sources,getRoutes:()=>router.routes(),call:management.call,readConfiguration:createLegacyReader(management.call)});
  const handle=management.handle;
  // Startup errors belong to this module, never prevent task management from opening.
  const initialize = () => settings.autoStart ? mutate(start).catch(() => {}) : Promise.resolve();
  return { handle, close, initialize, status, accounts };
}
