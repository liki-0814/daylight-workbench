import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extensionActions, extensionMethod, canonicalJSON } from '../core/extensions-contracts.js';
import { body, send } from '../ai/http.mjs';
import { error, hash, stat, within, safePath, snapshot, fileSnapshot, readText } from './files.mjs';
import { metadata, skillId, skillFile } from './skill-files.mjs';
import { normalizeServer, renderMcpConfig } from './mcp-config.mjs';
import { createProbes } from './mcp-probes.mjs';
import { readClientRegistry, clientsFile, normalizeClient, normalizeClientConfig, validateClientRegistry } from './clients.mjs';
import { createCatalog } from './catalog.mjs';
import { createTransactions } from './transactions.mjs';

const json = value => canonicalJSON(value, 2) + '\n';
const fields = {
  'skill.create': ['type', 'directory', 'content'], 'skill.update': ['type', 'id', 'file', 'content'], 'skill.archive': ['type', 'id'],
  'mcp.save': ['type', 'server'], 'mcp.archive': ['type', 'id'], 'mcp.generate': ['type', 'clientId'], 'mcp.probe': ['type', 'id'],
  'binding.connect': ['type', 'id', 'clientId'], 'binding.adopt': ['type', 'id', 'clientId'], 'binding.disconnect': ['type', 'id', 'clientId', 'includeExisting'], 'operation.restore': ['type', 'operationId'],
  'client.save': ['type', 'client'], 'client.remove': ['type', 'clientId'],
};
export async function createExtensionsService({ agentsRoot = path.join(os.homedir(), '.agents'), clientRoots, environment = process.env, cacheMs, probeTimeoutMs, fault, onChanged = () => {} } = {}) {
  // Canonicalize existing ancestors (macOS /var -> /private/var) without creating roots.
  let ancestor = path.resolve(agentsRoot); const missing = [];
  while (!(await stat(ancestor))) { missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  const root = path.join(await fs.realpath(ancestor), ...missing);
  const registryOptions = { clientRoots, environment }, loadClients = () => readClientRegistry(root, registryOptions);
  const catalog = createCatalog({ root, loadClients, environment, cacheMs });
  const probes = createProbes({ environment, timeoutMs: probeTimeoutMs });
  const assertTarget = async target => {
    if (within(root, target)) { await safePath(root, path.dirname(target)); return; }
    const registration = await loadClients();
    if (!registration.valid) throw error(registration.message, 409);
    const client = registration.clients.find(item => path.dirname(target) === item.skillsRoot);
    if (!client || !/^[a-zA-Z0-9_.-]{1,100}$/.test(path.basename(target))) throw error('外部路径不是受支持的 Skill 链接位置', 403, 'EXTENSIONS_PATH');
    await safePath(client.root, client.skillsRoot);
  };
  const transactions = createTransactions({ root, assertTarget, fault });
  const probeReport = server => { const value = probes.latest(server.id); return value ? { ...value, stale: value.configRevision !== server.revision } : null; };
  const publicState = value => { const { manifest, registry, clientConfig, ...state } = value; return { ...state, servers: state.servers.map(server => ({ ...server, lastProbe: probeReport(server) })) }; };
  const getSkill = (state, id) => { const skill = state.skills.find(item => item.id === id); if (!skill) throw error('Skill 已归档、移动或不存在，请返回清单重新选择', 404, 'EXTENSIONS_OBJECT_MISSING'); return skill; };
  const getServer = (state, id) => { const server = state.servers.find(item => item.id === id); if (!server) throw error('MCP 服务已归档或不存在', 404, 'EXTENSIONS_OBJECT_MISSING'); const { kind, revision, dependencies, ...config } = server; return config; };
  const getClient = (state, id) => { if (!state.clientsValid) throw error(state.diagnostics.find(issue => issue.code === 'CLIENTS_FORMAT')?.message || 'CLI 登记文件无效', 409); const client = state.registry.find(item => item.id === id); if (!client) throw error('软件未登记或已移除', 404, 'EXTENSIONS_OBJECT_MISSING'); return client; };
  const generatedPath = client => path.join(root, 'mcp', 'generated', client.id, 'servers.' + (client.format === 'toml' ? 'toml' : 'json'));
  async function detail(id, file) {
    const state = await catalog.state();
    if (state.registry.some(client => client.id === id)) {
      const client = state.registry.find(client => client.id === id), generated = client.mcpMode === 'unsupported' ? null : await readText(await safePath(root, generatedPath(client)), 2_000_000);
      let current = false; try { current = generated === renderMcpConfig(client, state.servers.map(({ kind, revision, dependencies, ...config }) => config)); } catch {}
      return { kind: 'client', ...state.clients.find(item => item.id === id), version: state.version, skills: state.skills.map(skill => ({ id: skill.id, name: skill.name, binding: skill.bindings.find(binding => binding.clientId === id) })), generated: generated === null ? null : { path: generatedPath(client), content: generated, current }, integration: '生成文件不等于已接入。请在客户端核对同名服务后，仅接入对应 MCP 配置；Daylight 不修改全局配置。' };
    }
    const server = state.servers.find(item => item.id === id);
    if (server) return { ...server, version: state.version, runtimeVerified: false, lastProbe: probeReport(server) };
    const skill = getSkill(state, id);
    const selected = await skillFile(root, skill, file);
    const directory = path.join(root, 'skills', skill.relativePath), files = [];
    async function list(dir, depth = 0) {
      if (depth > 5 || files.length >= 200) return;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const target = path.join(dir, entry.name), relative = path.relative(directory, target);
        if (entry.isDirectory()) await list(target, depth + 1);
        else files.push({ path: relative, linked: entry.isSymbolicLink() });
        if (files.length >= 200) break;
      }
    }
    await list(directory);
    return { ...skill, version: state.version, file: selected.relative, content: selected.content, files };
  }
  async function prepare(input) {
    if (!input || !extensionActions.includes(input.type) || Object.keys(input).some(key => !fields[input.type].includes(key))) throw error('扩展动作或字段无效');
    const action = structuredClone(input), state = await catalog.state(true), steps = [], conflicts = [], impact = [], changedIds = [];
    if (action.type === 'binding.disconnect' && action.includeExisting !== undefined && typeof action.includeExisting !== 'boolean') throw error('includeExisting 需要明确的布尔值');
    const add = async (target, after) => {
      await assertTarget(target); const before = await snapshot(target);
      if (before.kind === 'file' && after.kind === 'file') after.mode = before.mode;
      if (hash(before) !== hash(after)) steps.push({ path: target, before, after });
    };
    let manifest = state.manifest ? structuredClone(state.manifest) : null, manifestChanged = false;
    const binding = async (skill, client, type) => {
      if (!manifest) throw error('接入记录损坏，请修复 bindings.json 后操作', 409);
      const source = path.join(root, 'skills', skill.relativePath), target = path.join(client.skillsRoot, path.basename(skill.relativePath));
      await safePath(root, source); await assertTarget(target);
      const actual = await snapshot(target), matches = actual.kind === 'link' && await fs.realpath(target).catch(() => null) === source;
      const owned = manifest.bindings.find(item => item.skillId === skill.id && item.clientId === client.id && item.target === target && item.source === source);
      if (type === 'binding.connect') {
        if (!skill.valid) throw error('请先修复 Skill 元数据再接入');
        if (actual.kind !== 'missing') { if (matches) impact.push('已有正确链接；如需管理解除操作，请明确接管。'); else conflicts.push(client.name + ' 的同名位置存在其他内容：' + target); return; }
        await add(target, { kind: 'link', target: source });
        manifest.bindings.push({ skillId: skill.id, clientId: client.id, source, target, linkTarget: source }); manifestChanged = true;
      } else if (type === 'binding.adopt') {
        if (!matches) { conflicts.push('只能接管已经指向主来源的正确链接'); return; }
        if (!owned || owned.linkTarget !== actual.target) { manifest.bindings = manifest.bindings.filter(item => item !== owned); manifest.bindings.push({ skillId: skill.id, clientId: client.id, source, target, linkTarget: actual.target }); manifestChanged = true; }
      } else {
        if (!owned && !action.includeExisting) { conflicts.push('该链接不属于 Daylight；请先预览接管，或明确确认移除已有正确链接'); return; }
        if (!matches || owned && owned.linkTarget !== actual.target) { conflicts.push('链接目标已被外部修改或不指向主来源，已停止解除'); return; }
        await add(target, { kind: 'missing' });
        if (owned) { manifest.bindings = manifest.bindings.filter(item => item !== owned); manifestChanged = true; }
        impact.push('仅移除 ' + target + ' 的链接，主 Skill 和其他软件保持原样。' + (!owned ? '本次明确确认处理已有正确链接，修改前链接已记录供恢复。' : ''));
      }
      impact.push(client.name + '：' + client.refresh);
    };
    if (action.type === 'skill.create') {
      if (typeof action.directory !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(action.directory)) throw error('新 Skill 目录需要小写字母、数字或短横线');
      metadata(action.content);
      const directory = path.join(root, 'skills', action.directory); await safePath(root, directory);
      if (await stat(directory)) conflicts.push('主目录已存在同名内容，不能覆盖');
      await add(path.join(directory, 'SKILL.md'), fileSnapshot(action.content)); changedIds.push(skillId(action.directory));
      impact.push('保存到主来源；在软件的勾选框确认后建立对应 Skill 链接。');
    } else if (action.type.startsWith('skill.')) {
      const skill = getSkill(state, action.id); changedIds.push(skill.id);
      await safePath(root, path.join(root, 'skills', skill.relativePath));
      if (action.type === 'skill.update') {
        action.file ||= 'SKILL.md';
        if (typeof action.content !== 'string' || Buffer.byteLength(action.content) > 262144 || action.content.includes('\0')) throw error('文件需要小于 256 KB 的文本');
        if (action.file === 'SKILL.md') metadata(action.content);
        const selected = await skillFile(root, skill, action.file); await add(selected.target, fileSnapshot(action.content));
        impact.push('修改唯一主来源；现有正确链接继续指向它。已加载的客户端会话需刷新。');
      } else {
        const source = path.join(root, 'skills', skill.relativePath), archive = path.join(root, 'archive', 'skills', skill.id + '_' + state.version.slice(0, 12));
        if (await stat(archive)) conflicts.push('归档位置已有内容，请先核对恢复记录');
        const affected = state.skills.filter(item => within(source, path.join(root, 'skills', item.relativePath)));
        for (const item of affected) {
          changedIds.push(item.id);
          for (const owned of manifest?.bindings.filter(binding => binding.skillId === item.id) || []) await binding(item, getClient(state, owned.clientId), 'binding.disconnect');
          impact.push('归档 ' + item.name + '；移除由 Daylight 管理的链接，未接管的已有链接保留且可能失效。');
        }
        await add(archive, await snapshot(source)); await add(source, { kind: 'missing' });
      }
    } else if (action.type.startsWith('binding.')) {
      const skill = getSkill(state, action.id); changedIds.push(skill.id); await binding(skill, getClient(state, action.clientId), action.type);
    } else if (action.type.startsWith('client.')) {
      if (!state.clientsValid) throw error('请先修复 CLI 登记文件；原文件不会被覆盖', 409);
      const profiles = structuredClone(state.clientConfig.clients);
      if (action.type === 'client.save') {
        action.client = normalizeClient(action.client);
        const index = profiles.findIndex(client => client.id === action.client.id), existing = index === -1 ? null : getClient(state, action.client.id);
        if (state.servers.some(server => server.id === action.client.id)) throw error('CLI ID 与现有 MCP 服务冲突');
        if (index === -1) profiles.push(action.client); else profiles[index] = action.client;
        const config = normalizeClientConfig({ schemaVersion: 1, clients: profiles });
        const next = (await validateClientRegistry(root, config, registryOptions)).find(client => client.id === action.client.id);
        if (existing && existing.skillsRoot !== next.skillsRoot) {
          if (!manifest) throw error('请先修复接入记录，再修改 CLI 目录', 409);
          if (manifest.bindings.some(binding => binding.clientId === existing.id)) conflicts.push('请先解除该软件已管理的 Skill 链接，再修改接入目录');
        }
        await add(clientsFile(root), fileSnapshot(json(config))); changedIds.push(action.client.id);
        impact.push((existing ? '更新 ' : '登记 ') + action.client.name + '；后续可在 Skills 中勾选接入。登记不会安装或执行 CLI。');
      } else {
        const client = getClient(state, action.clientId);
        if (!client.custom) throw error('内置软件不能移除登记');
        if (!manifest) throw error('请先修复接入记录，再移除 CLI 登记', 409);
        const bindings = manifest.bindings.filter(binding => binding.clientId === client.id);
        for (const binding of bindings) if (await stat(binding.target)) conflicts.push('请先解除已管理的 Skill 链接：' + binding.target);
        if (!conflicts.length && bindings.length) { manifest.bindings = manifest.bindings.filter(binding => binding.clientId !== client.id); manifestChanged = true; }
        await add(clientsFile(root), fileSnapshot(json({ schemaVersion: 1, clients: profiles.filter(profile => profile.id !== client.id) }))); changedIds.push(client.id);
        impact.push('仅移除 ' + client.name + ' 的登记；CLI 程序、主来源、软件目录和未接管的链接保留。');
      }
    } else if (action.type === 'operation.restore') {
      const record = await transactions.read(action.operationId);
      if (!record || record.status !== 'applied' || !record.steps.length) throw error('只能恢复已成功写入的操作');
      const registrationStep = record.steps.find(step => step.path === clientsFile(root));
      if (registrationStep) {
        if (!state.clientsValid || !manifest) throw error('请先修复 CLI 登记和接入记录，再恢复登记', 409);
        const restored = normalizeClientConfig(registrationStep.before.kind === 'missing' ? { schemaVersion: 1, clients: [] } : JSON.parse(Buffer.from(registrationStep.before.data, 'base64').toString('utf8')));
        const nextClients = await validateClientRegistry(root, restored, registryOptions);
        for (const client of state.registry.filter(client => client.custom)) {
          if (nextClients.find(next => next.id === client.id)?.skillsRoot === client.skillsRoot) continue;
          for (const binding of manifest.bindings.filter(binding => binding.clientId === client.id)) if (await stat(binding.target)) conflicts.push('请先解除该软件已管理的 Skill 链接，再恢复登记：' + binding.target);
        }
      }
      for (const original of [...record.steps].reverse()) {
        await assertTarget(original.path);
        if (hash(await snapshot(original.path)) !== hash(original.after)) conflicts.push('文件在操作后已被修改，不能覆盖恢复：' + original.path);
        await add(original.path, original.before);
      }
      impact.push('恢复该操作的修改前内容，包括归档来源和属于 Daylight 的接入关系。后续变更造成的差异不会被覆盖。');
    } else {
      if (!state.mcpValid) throw error('请先修复 MCP 主文件；管理操作不会覆盖格式错误的配置', 409);
      const servers = state.servers.map(({ kind, revision, dependencies, ...config }) => config);
      if (action.type === 'mcp.save') {
        action.server = normalizeServer(action.server); const index = servers.findIndex(server => server.id === action.server.id);
        if (index === -1) servers.push(action.server); else servers[index] = action.server;
        if (servers.length > 500) throw error('MCP 主配置最多管理 500 个服务');
        changedIds.push(action.server.id); await add(path.join(root, 'mcp', 'servers.json'), fileSnapshot(json({ schemaVersion: 1, servers })));
        if (Buffer.byteLength(json({ schemaVersion: 1, servers })) > 2_000_000) throw error('MCP 主配置超过 2 MB，请减少服务或参数');
        impact.push('仅保存 MCP 主配置，不启动服务。已生成的客户端配置需重新生成并在客户端接入。');
      } else if (action.type === 'mcp.archive') {
        const server = getServer(state, action.id), archive = path.join(root, 'archive', 'mcp', server.id + '_' + state.version.slice(0, 12) + '.json');
        if (await stat(archive)) conflicts.push('归档位置已存在内容');
        await add(archive, fileSnapshot(json(server))); await add(path.join(root, 'mcp', 'servers.json'), fileSnapshot(json({ schemaVersion: 1, servers: servers.filter(item => item.id !== action.id) })));
        changedIds.push(server.id); impact.push('归档 MCP 主配置，已经运行的外部客户端不会立即断连。');
        for (const skill of state.skills.filter(item => item.dependencies?.includes(server.id))) impact.push('已声明依赖的 Skill：' + skill.name + '（不会删除）。');
      } else if (action.type === 'mcp.generate') {
        const client = getClient(state, action.clientId); await add(generatedPath(client), fileSnapshot(renderMcpConfig(client, servers)));
        impact.push('为 ' + client.name + ' 生成独立适配文件；需在客户端接入，不修改全局配置。');
      } else {
        const server = getServer(state, action.id); if (!server.enabled) throw error('服务已在主配置中禁用，请先编辑配置');
        impact.push('显式启动一次 ' + server.name + ' 检测：' + (server.command ? [server.command, ...server.args].join(' ') : server.url) + '；仅握手并列工具，完成后关闭检测连接。');
      }
    }
    if (manifestChanged) await add(path.join(root, 'daylight', 'bindings.json'), fileSnapshot(json(manifest)));
    const plan = { normalizedAction: action, expectedVersion: state.version, steps, conflicts, impact, changedIds: [...new Set(changedIds)] };
    plan.planId = hash({ action, version: state.version, steps: steps.map(step => [step.path, hash(step.before), hash(step.after)]), conflicts });
    return plan;
  }
  function publicPlan(plan) {
    return { normalizedAction: plan.normalizedAction, expectedVersion: plan.expectedVersion, planId: plan.planId, conflicts: plan.conflicts, impact: plan.impact, changedIds: plan.changedIds,
      files: plan.steps.map(step => ({ path: step.path, beforeKind: step.before.kind, afterKind: step.after.kind, beforeHash: hash(step.before), afterHash: hash(step.after), ...(step.before.kind === 'file' && Buffer.from(step.before.data, 'base64').length <= 262144 ? { before: Buffer.from(step.before.data, 'base64').toString('utf8') } : {}), ...(step.after.kind === 'file' && Buffer.from(step.after.data, 'base64').length <= 262144 ? { after: Buffer.from(step.after.data, 'base64').toString('utf8') } : {}), ...(step.after.kind === 'link' ? { linkTarget: step.after.target } : {}) })) };
  }
  async function apply(input) {
    if (!input || Object.keys(input).some(key => !['requestId', 'expectedVersion', 'planId', 'action'].includes(key)) || typeof input.expectedVersion !== 'string' || typeof input.planId !== 'string') throw error('提交需要 requestId、expectedVersion、planId 和 action');
    let newlyApplied = false;
    const result = await transactions.execute(input, prepare, async (plan, record) => {
      newlyApplied = true;
      catalog.invalidate(); const state = await catalog.state(true);
      return { ok: true, status: 'applied', kind: 'extensions', version: state.version, operationId: record.requestId, action: plan.normalizedAction, changedIds: plan.changedIds, impact: plan.impact, ...(plan.normalizedAction.type === 'mcp.probe' ? { probeId: record.requestId, message: '检测已确认。握手状态请读取检测记录；这不是其他客户端的发现结果。' } : {}) };
    });
    const state = await catalog.state(); await probes.reconcile(state.servers);
    if (result.probeId && newlyApplied) probes.start(getServer(state, result.action.id), result.probeId, { confirmed: true });
    onChanged({ kind: 'extensions', revision: result.version, changedIds: result.changedIds, operationId: result.operationId });
    return result;
  }
  async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost'), route = url.pathname.replace(/^\/api\/extensions/, '');
      if (!extensionMethod(route, req.method)) throw error('扩展接口或方法不存在', 404);
      const input = req.method === 'POST' ? await body(req) : {};
      let value;
      if (route === '/state' || route === '/refresh') value = publicState(await catalog.state(route === '/refresh'));
      else if (route === '/diagnostics') { const state = await catalog.state(true); value = { version: state.version, diagnostics: state.diagnostics, message: '静态检查不会启动 MCP 或修改文件。' }; }
      else if (route === '/prepare') { if (Object.keys(input).some(key => key !== 'action')) throw error('prepare 只接受 action'); value = publicPlan(await prepare(input.action)); }
      else if (route === '/actions') value = await apply(input);
      else if (route.startsWith('/objects/')) value = await detail(route.slice('/objects/'.length), url.searchParams.get('file') || undefined);
      else if (route.startsWith('/operations/')) value = await transactions.receipt(route.slice('/operations/'.length));
      else if (route === '/probes') {
        if (Object.keys(input).some(key => !['id', 'expectedVersion'].includes(key))) throw error('检测只接受 id 和 expectedVersion');
        const state = await catalog.state(true); if (state.version !== input.expectedVersion) throw error('配置已变化，请刷新后重新确认检测', 409);
        const server = getServer(state, input.id); if (!server.enabled) throw error('服务已禁用'); value = probes.start(server);
      } else value = req.method === 'DELETE' ? await probes.cancel(route.slice('/probes/'.length)) : probes.get(route.slice('/probes/'.length));
      send(res, 200, value);
    } catch (failure) { send(res, failure.status || 500, { error: failure.status ? failure.message : '扩展操作失败，请核对回执后用原请求重试', code: failure.code || 'EXTENSIONS_IO' }); }
  }
  return { handle, state: async force => publicState(await catalog.state(force)), detail, prepare: async action => publicPlan(await prepare(action)), apply, operation: transactions.receipt, probes, close: probes.close };
}
