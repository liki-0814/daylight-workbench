import os from 'node:os';
import path from 'node:path';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { readJson, writeJson, serial } from '../proxy/shared/store.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
const encode = value => JSON.stringify(value, null, 2) + '\n';
const positive = value => Number.isSafeInteger(value) && value > 0;
const filenames = ['models.json', 'settings.json'];
export const piAPIs = ['openai-responses', 'openai-completions', 'anthropic-messages'];
function unavailableReason(model, api) {
  return typeof model.pi?.[api] === 'string' ? model.pi[api] : '';
}

async function piInfo() {
  const candidates = [...(process.env.PATH || '').split(path.delimiter).filter(path.isAbsolute).map(p => path.join(p, 'pi')), path.join(os.homedir(), '.npm-global/bin/pi'), '/opt/homebrew/bin/pi', '/usr/local/bin/pi'];
  for (const file of [...new Set(candidates)]) {
    try {
      await access(file, constants.X_OK);
      const { stdout } = await promisify(execFile)(file, ['--version'], { timeout: 3000, maxBuffer: 4096, env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '') } });
      return { installed: true, version: stdout.trim(), binary: file };
    } catch {}
  }
  return { installed: false, version: '' };
}

async function atomicText(file, text) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if (text === null) { await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; }); return; }
  const temp = file + '.' + randomUUID() + '.tmp';
  try { await writeFile(temp, text, { mode: 0o600, flag: 'wx' }); await rename(temp, file); }
  finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export const thinkingLevels = ['off','minimal','low','medium','high','xhigh','max'];
function validateOverrides(value, models) {
  if (!object(value)) fail('Pi 个性化配置需为对象');
  const result = {};
  for (const [id, fields] of Object.entries(value)) {
    if (!models.some(m=>m.id===id) || !object(fields)) fail('Pi 个性化配置包含未知模型');
    const next = {};
    for (const [key, v] of Object.entries(fields)) {
      if (['contextWindow','maxTokens'].includes(key)) { if (!positive(v)) fail('Token 参数需为正整数'); next[key]=v; }
      else if (key==='reasoning') { if(typeof v!=='boolean') fail('思考能力需为布尔值'); next[key]=v; }
      else if (key==='input') { if(!Array.isArray(v)||!v.includes('text')||v.some(x=>!['text','image'].includes(x))||new Set(v).size!==v.length) fail('输入类型无效'); next[key]=v; }
      else if (key==='thinkingLevelMap') {
        if(!object(v)) fail('思考档位映射无效'); next[key]={};
        for(const [level, mapped] of Object.entries(v)) { if(!thinkingLevels.includes(level)||mapped!==null&&(typeof mapped!=='string'||!mapped.trim()||mapped.length>100)) fail('思考档位映射无效'); next[key][level]=mapped; }
      } else fail('未知 Pi 个性化配置字段');
    }
    result[id]=next;
  }
  return result;
}

export function modelConfig(model, previous = {}, api = 'openai-responses', override = {}) {
  const next = { ...previous, id: model.id, name: model.name, api };
  if (positive(model.contextWindow)) next.contextWindow = model.contextWindow;
  if (positive(model.maxOutputTokens)) next.maxTokens = model.maxOutputTokens;
  if (typeof model.isReasoning === 'boolean') next.reasoning = model.isReasoning;
  if (model.reasoningEfforts?.length) {
    next.thinkingLevelMap = Object.fromEntries(thinkingLevels.map(level=>[level, model.reasoningEfforts.includes(level) ? level : level==='off' && model.reasoningEfforts.includes('none') ? 'none' : level==='max' && model.reasoningEfforts.includes('ultra') ? 'ultra' : null]));
  }
  if (model.thinkingLevelMap) next.thinkingLevelMap = { ...next.thinkingLevelMap, ...model.thinkingLevelMap };
  const levelMap = next.thinkingLevelMap;
  Object.assign(next, override);
  if (override.thinkingLevelMap) next.thinkingLevelMap = {...levelMap, ...override.thinkingLevelMap};
  if (typeof model.isVL === 'boolean') next.input = model.isVL ? ['text', 'image'] : ['text'];
  if (override.input) next.input = override.input;
  next.compat = { ...previous.compat, supportsLongCacheRetention: false };
  if (api === 'openai-responses') {
    next.compat.supportsStrictMode = false;
    if (model.requestOutputBudget===false) next.compat.supportsMaxOutputTokens = false;
  }
  if (api === 'openai-completions') Object.assign(next.compat, { supportsStore: false, supportsUsageInStreaming: true, maxTokensField: 'max_tokens' });
  return next;
}

export function createPiConfig({ dataDir, getCatalog, getGateway, piDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent'), getInfo = piInfo, writeText = atomicText, syncIntervalMs = 60000 }) {
  piDir = path.resolve(piDir);
  const run = serial(), folder = path.join(dataDir, 'cli/pi-backups'), latestFile = path.join(dataDir, 'cli/pi-latest.json');
  const syncFile = path.join(dataDir, 'cli/pi-sync.json');
  let sync = { enabled: false, api: piAPIs[0] }, timer, closed = false, syncRunning = false;
  let info;
  const currentFiles = () => Promise.all(filenames.map(async name => {
    try { return await readFile(path.join(piDir, name), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }));
  function parse(text, index) {
    let value;
    try { value = text === null ? {} : JSON.parse(text); } catch { fail(`${filenames[index]} 不是有效 JSON，原文件已保留`); }
    if (!object(value)) fail(`${filenames[index]} 格式无效，原文件已保留`);
    if (index === 0) {
      if (value.providers !== undefined && !object(value.providers)) fail('Pi providers 格式无效，原文件已保留');
      const provider = value.providers?.daylight;
      if (provider !== undefined && (!object(provider) || provider.models !== undefined && (!Array.isArray(provider.models) || provider.models.some(m => !object(m) || typeof m.id !== 'string')))) fail('Pi Daylight 模型配置无效，原文件已保留');
    }
    return value;
  }
  async function snapshot(api = sync.api, force = false) {
    if (!piAPIs.includes(api)) fail('Pi 接口无效');
    const [files, result, gateway, latest] = await Promise.all([currentFiles(), getCatalog(force), getGateway(), readJson(latestFile, null)]);
    const catalog = Array.isArray(result) ? result : result.models;
    const models = parse(files[0], 0), settings = parse(files[1], 1), provider = models.providers?.daylight || {};
    const failed = (result.failedSources || []).filter(s => !s.unconfigured || sync.sources?.includes(s.id) || (!sync.lastModelHash || !catalog.length) && provider.models?.length);
    const catalogError = failed.length ? `来源 ${failed.map(s => s.name).join('、')} 的目录读取失败，已保留 Pi 配置` : '';
    const version = hash({ files, catalog, catalogError, api, modelOverrides: sync.modelOverrides, baseUrl: gateway.baseUrl, apiKey: gateway.apiKey });
    const rows = catalog.map(model => {
      const prior = provider.models?.find(m => m.id === model.id), desired = modelConfig(model, {}, api, sync.modelOverrides?.[model.id]);
      const same = prior && hash(prior) === hash(desired) && provider.baseUrl === gateway.baseUrl && provider.apiKey === gateway.apiKey;
      return { ...model, state: !prior ? 'new' : same ? 'connected' : 'update', unavailableReason: unavailableReason(model, api), configuration: desired, overrides: sync.modelOverrides?.[model.id] || {} };
    });
    let canRestore = false;
    if (latest && latest.phase !== 'restored') {
      const backup = await readJson(path.join(folder, latest.id + '.json'), null);
      canRestore = !!backup && files.every((text, i) => hash(text) === backup.afterHashes[i] || latest.phase === 'pending' && text === backup.before[i]);
    }
    info ||= getInfo();
    const obsolete = (provider.models || []).filter(m => !catalog.some(c => c.id === m.id)).map(m => ({ id: m.id, name: m.name || m.id, state: 'removed' }));
    return { files, models, settings, gateway, latest, public: { version, api, models: rows, obsolete, catalogError, automatic: { enabled: sync.enabled, api: sync.api, lastSyncedAt: sync.lastSyncedAt, error: sync.error || '' }, pi: { ...await info, directory: piDir, modelsPath: path.join(piDir, filenames[0]), importedCount: rows.filter(m => provider.models?.some(p => p.id === m.id)).length, configuredCount: provider.models?.length || 0, defaultProvider: settings.defaultProvider || '', defaultModel: settings.defaultModel || '', canRestore }, service: { state: gateway.state, baseUrl: gateway.baseUrl }, pending: latest?.phase === 'pending' } };
  }
  function build(s, input) {
    if (!object(input)) fail('Pi 配置操作需为对象');
    if (s.public.pending) fail('上次写入中断，请先恢复上次接入', 409);
    if (s.public.catalogError) fail(s.public.catalogError, 409);
    const selected = s.public.models;
    if (input.ids !== undefined && (!Array.isArray(input.ids) || input.ids.length !== selected.length || new Set(input.ids).size !== selected.length || selected.some(m => !input.ids.includes(m.id)))) fail('现在使用全量同步，请刷新后同步全部中转模型', 409);
    if (selected.some(m => m.unavailableReason)) fail(selected.find(m => m.unavailableReason).unavailableReason);
    if (input.defaultModel !== undefined && !selected.some(m => m.id === input.defaultModel)) fail('默认模型需属于当前中转目录');
    const modelOverrides = input.modelOverrides === undefined ? Object.fromEntries(Object.entries(sync.modelOverrides || {}).filter(([id])=>selected.some(m=>m.id===id))) : validateOverrides(input.modelOverrides, selected);
    const next = structuredClone(s.models), provider = { baseUrl: s.gateway.baseUrl, api: s.public.api, apiKey: s.gateway.apiKey, models: selected.map(m => modelConfig(m, {}, s.public.api, modelOverrides[m.id])) };
    next.providers = { ...next.providers, daylight: provider };
    const settings = { ...s.settings };
    let defaultChanged = false;
    if (input.defaultModel !== undefined) { settings.defaultProvider = 'daylight'; settings.defaultModel = input.defaultModel; defaultChanged = true; }
    else if (settings.defaultProvider === 'daylight' && !selected.some(m => m.id === settings.defaultModel)) { delete settings.defaultProvider; delete settings.defaultModel; defaultChanged = true; }
    const after = [hash(s.models.providers?.daylight) === hash(provider) ? s.files[0] : encode(next), hash(settings) === hash(s.settings) ? s.files[1] : encode(settings)];
    return { after, modelOverrides, public: { version: s.public.version, api: s.public.api, ids: selected.map(m => m.id), defaultChanged, changes: [...selected.map(m => ({ id: m.id, name: m.name, state: m.state })), ...s.public.obsolete], config: { providers: { daylight: { ...provider, apiKey: '<本地代理 Key>' } } }, ...(defaultChanged ? { settings: { defaultProvider: settings.defaultProvider || null, defaultModel: settings.defaultModel || null } } : {}) } };
  }
  async function restoreBackup(backup, latest) {
    const files = await currentFiles();
    if (!files.every((text, i) => hash(text) === backup.afterHashes[i] || latest.phase === 'pending' && text === backup.before[i])) fail('Pi 配置已被外部修改，不能覆盖恢复；备份已保留', 409);
    for (let i = 0; i < filenames.length; i++) if (files[i] !== backup.before[i]) await writeText(path.join(piDir, filenames[i]), backup.before[i]);
    await writeJson(latestFile, { ...latest, phase: 'restored' });
  }
  async function saveSync(next) { await writeJson(syncFile, next); sync = next; }
  async function remember(s, files, modelOverrides) {
    const next = { ...sync, modelOverrides, piDir, api: s.public.api, lastModelHash: hash(files[0]), sources: [...new Set(s.public.models.map(m => m.source))], error: '' };
    if (hash(next) !== hash(sync)) await saveSync({ ...next, lastSyncedAt: new Date().toISOString() });
  }
  async function applyInput(input, existing) {
      if (!object(input)) fail('Pi 配置操作需为对象');
      if (typeof input.requestId !== 'string' || !/^[\w-]{1,100}$/.test(input.requestId) || typeof input.expectedVersion !== 'string') fail('缺少合法的 requestId 或 expectedVersion');
      const fingerprint = hash(input), latest = await readJson(latestFile, null);
      if (latest?.requestId === input.requestId) {
        if (latest.fingerprint !== fingerprint) fail('requestId 已用于其他操作', 409);
        const backup = await readJson(path.join(folder, latest.id + '.json'), null), files = await currentFiles();
        if (latest.phase === 'applied' && backup && files.every((text, i) => hash(text) === backup.afterHashes[i])) return { ok: true, replayed: true, backupPath: path.join(folder, latest.id + '.json') };
        fail('该操作已恢复或中断，请刷新后重试', 409);
      }
      const s = existing || await snapshot(input.api);
      if (input.expectedVersion !== s.public.version) fail('Pi 配置或代理模型已变化，请刷新后重试', 409);
      const plan = build(s, input), count = plan.public.ids.length;
      if (hash(plan.after) === hash(s.files)) {
        await remember(s, s.files, plan.modelOverrides);
        return { ok: true, count, unchanged: true, message: `Pi 已与中转目录一致，共 ${count} 个模型。` };
      }
      const id = randomUUID(), backupPath = path.join(folder, id + '.json');
      const backup = { piDir, before: s.files, afterHashes: plan.after.map(hash), createdAt: new Date().toISOString() };
      const receipt = { id, requestId: input.requestId, fingerprint, phase: 'pending' };
      await writeJson(backupPath, backup); await writeJson(latestFile, receipt);
      try {
        if (hash(await currentFiles()) !== hash(s.files)) fail('Pi 配置已被外部修改，请刷新后重试', 409);
        for (let i = 0; i < filenames.length; i++) if (plan.after[i] !== s.files[i]) await writeText(path.join(piDir, filenames[i]), plan.after[i]);
        await writeJson(latestFile, { ...receipt, phase: 'applied' });
      } catch (error) {
        try { await restoreBackup(backup, receipt); } catch { fail('写入未完成，请恢复上次接入；原配置备份已保留', 409); }
        throw error;
      }
      await remember(s, plan.after, plan.modelOverrides);
      const removed = s.public.obsolete.length;
      return { ok: true, count, removed, backupPath, message: `已全量同步 ${count} 个模型，移除 ${removed} 个旧模型。${plan.public.defaultChanged ? input.defaultModel === undefined ? '失效的默认模型已清除。' : '已更新 Pi 默认模型。' : '默认模型未修改。'}` };
  }
  const service = {
    start: async () => {
      sync = await readJson(syncFile, sync);
      if (!object(sync) || typeof sync.enabled !== 'boolean' || !piAPIs.includes(sync.api) || sync.piDir && sync.piDir !== piDir) fail('Pi 自动同步配置无效，原文件已保留');
      timer = setInterval(() => { void service.autoSync().catch(() => {}); }, syncIntervalMs); timer.unref();
      if (sync.enabled) void service.autoSync().catch(() => {});
    },
    close: async () => { closed = true; clearInterval(timer); await run(async () => {}); },
    configuration: input => run(async () => {
      if (!object(input)) fail('Pi 个性化配置需为对象');
      const s=await snapshot(input.api);
      if (input.expectedVersion!==s.public.version) fail('Pi 配置或模型目录已变化，请刷新后重试',409);
      const modelOverrides=validateOverrides(input.modelOverrides,s.public.models);
      await saveSync({...sync,modelOverrides});
      return {ok:true,message:'个性化配置已保存，后续同步将使用这些设置。'};
    }),
    // Reads must not queue behind network discovery or configuration commits.
    state: async (api, force) => (await snapshot(api, force)).public,
    prepare: input => run(async () => {
      if (!object(input)) fail('Pi 配置操作需为对象');
      return build(await snapshot(input.api), input).public;
    }),
    apply: input => run(() => applyInput(input)),
    automatic: input => run(async () => {
      if (!object(input) || typeof input.enabled !== 'boolean') fail('自动同步开关无效');
      if (input.enabled) {
        await applyInput(input);
        await saveSync({ ...sync, enabled: true });
      } else await saveSync({ ...sync, enabled: false, error: '' });
      return { ok: true, message: input.enabled ? '自动同步已开启，跟随全部中转模型。' : '自动同步已关闭。' };
    }),
    autoSync: async () => {
      if (syncRunning || closed || !sync.enabled) return { skipped: true };
      syncRunning = true;
      try { return await run(async () => {
      if (closed || !sync.enabled) return { skipped: true };
      try {
        const s = await snapshot(sync.api);
        if (!sync.lastModelHash || hash(s.files[0]) !== sync.lastModelHash) fail('Pi 模型配置已被外部修改，自动同步暂停；请手动同步确认', 409);
        return await applyInput({ api: sync.api, expectedVersion: s.public.version, requestId: randomUUID() }, s);
      } catch (error) {
        if (sync.error !== error.message) await saveSync({ ...sync, error: error.message });
        return { ok: false, error: error.message };
      }
      }); } finally { syncRunning = false; }
    },
    restore: () => run(async () => {
      const latest = await readJson(latestFile, null);
      if (!latest || latest.phase === 'restored') fail('没有可恢复的接入记录');
      const backup = await readJson(path.join(folder, latest.id + '.json'), null);
      if (!backup || backup.piDir !== piDir) fail('接入备份不可用，未修改 Pi 配置');
      await saveSync({ ...sync, enabled: false, error: '' });
      await restoreBackup(backup, latest);
      return { ok: true, message: '已恢复上次接入前的 Pi 配置。' };
    }),
  };
  return service;
}
