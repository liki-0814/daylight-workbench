import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extensionActions, extensionMethod, canonicalJSON, extensionsMirrorKeys } from '../core/extensions-contracts.js';
import { body, send } from '../ai/http.mjs';
import { error, fieldError, hash, stat, within, safePath, snapshot, fileSnapshot, readText } from './files.mjs';
import { metadata, skillId, skillFile } from './skill-files.mjs';
import { setSkillState } from './skill-state.mjs';
import { MCP_RESOLUTIONS, parseResolution, parseResolutions, serverView, differences } from './mcp-conflicts.mjs';
import { compareEntries, fingerprintEntry, setResolution, dropResolutions, findResolution } from './conflicts.mjs';
import { readSkillFolder } from './skill-import.mjs';
import { parseMcpJson } from './mcp-import.mjs';
import { configDocument } from './config-document.mjs';
import { normalizeServer, serverWarnings, privateEnvironmentNames } from './mcp-server.mjs';
import { renderMcpConfig } from './mcp-config.mjs';
import { changeClientMcp } from './client-mcp.mjs';
import { createProbes } from './mcp-probes.mjs';
import { readClientRegistry, clientsFile, normalizeClient, normalizeClientConfig, validateClientRegistry } from './clients.mjs';
import { createCatalog } from './catalog.mjs';
import { createTransactions } from './transactions.mjs';

const json = value => canonicalJSON(value, 2) + '\n';
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = {
  'skill.create': ['type', 'directory', 'content', 'clientId'], 'skill.update': ['type', 'id', 'file', 'content'], 'skill.archive': ['type', 'id'], 'skill.disable': ['type', 'id'], 'skill.enable': ['type', 'id', 'clientIds'], 'skill.resolveConflict': ['type', 'id', 'clientId', 'resolution'], 'skill.import': ['type', 'sourcePath', 'scope', 'clientId'], 'mcp.importJson': ['type', 'json', 'scope', 'clientId', 'resolutions'],
  'mcp.save': ['type', 'server', 'clientId', 'create', 'onConflict'], 'mcp.archive': ['type', 'id'], 'mcp.generate': ['type', 'clientId'], 'mcp.probe': ['type', 'id'], 'mcp.install': ['type', 'id', 'clientId'], 'mcp.toggle': ['type', 'id', 'enabled'],
  'binding.connect': ['type', 'id', 'clientId'], 'binding.adopt': ['type', 'id', 'clientId'], 'binding.disconnect': ['type', 'id', 'clientId', 'includeExisting'], 'operation.restore': ['type', 'operationId'],
  'client.save': ['type', 'client'], 'client.remove': ['type', 'clientId'], 'client.select': ['type', 'clientId', 'selected'],
};
export async function createExtensionsService({ agentsRoot = path.join(os.homedir(), '.agents'), clientRoots, home, environment = process.env, cacheMs, probeTimeoutMs, fault, onChanged = () => {} } = {}) {
  // Canonicalize existing ancestors (macOS /var -> /private/var) without creating roots.
  let ancestor = path.resolve(agentsRoot); const missing = [];
  while (!(await stat(ancestor))) { missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  const root = path.join(await fs.realpath(ancestor), ...missing);
  const registryOptions = { clientRoots, home, environment }, loadClients = () => readClientRegistry(root, registryOptions);
  const catalog = createCatalog({ root, loadClients, environment, cacheMs });
  const probes = createProbes({ environment, timeoutMs: probeTimeoutMs });
  const assertTarget = async target => {
    if (within(root, target)) { await safePath(root, path.dirname(target)); return; }
    const registration = await loadClients();
    if (!registration.valid) throw error(registration.message, 409);
    const mcpClient = registration.clients.find(item => item.selected && item.mcpPath === target);
    if (mcpClient) { await safePath(path.dirname(target), target); return; }
    const client = registration.clients.find(item => item.selected && within(item.skillsRoot, target) && target !== item.skillsRoot);
    if (!client || !/^[a-zA-Z0-9_.-]{1,100}$/.test(path.relative(client.skillsRoot, target).split(path.sep)[0])) throw error('外部路径不是受支持的 Skill 或 MCP 位置', 403, 'EXTENSIONS_PATH');
    await safePath(client.root, path.dirname(target));
  };
  const transactions = createTransactions({ root, assertTarget, fault });
  const probeReport = server => { const value = probes.latest(server.id); return value ? { ...value, stale: value.configRevision !== server.revision } : null; };
  // Reference table for the UI: names only. The value of a variable is never read into any response.
  const refStatus = server => [...Object.entries(server.envRefs || {}).map(([key, ref]) => ['env', key, ref]), ...Object.entries(server.headerRefs || {}).map(([key, ref]) => ['header', key, ref])].map(([kind, key, ref]) => ({ kind, key, ref, set: !!environment[ref], internal: privateEnvironmentNames.includes(ref) || privateEnvironmentNames.includes(key) }));
  // Web mirror of GET /api/v1/capabilities `extensions.*` (the web UI cannot read /api/v1): same nesting and key names, `true` instead of the descriptive strings. Keys come from `extensionsMirrorKeys` (core/extensions-contracts.js).
  // The web client shows a feature only on a literal `true`; a missing key means "not supported", so a backend without the capability omits the key.
  const capabilities = () => ({ extensions: Object.fromEntries(extensionsMirrorKeys.map(key => [key, true])) });
  const publicState = value => { const { manifest, registry, clientConfig, clientDocuments, ...state } = value; return { ...state, capabilities: capabilities(), servers: state.servers.map(server => ({ ...server, warnings: serverWarnings(server), refStatus: refStatus(server), lastProbe: probeReport(server) })) }; };
  // `kind` is the caller's hint ('skill' | 'mcp' | 'client'); without it Skill IDs are recognised by their `skill_` prefix.
  const missingMessage = kind => kind === 'mcp' ? 'MCP 服务已归档、被移除或配置已变化，请返回清单重新选择' : kind === 'client' ? '软件未登记或已移除，请返回清单重新选择' : kind === 'skill' ? 'Skill 已归档、移动或不存在，请返回清单重新选择' : '该对象已归档、移动或不存在，请返回清单重新选择';
  const absent = (id, kind) => Object.assign(error(missingMessage(kind || (/^skill_/.test(id) ? 'skill' : undefined)), 404, 'EXTENSIONS_OBJECT_MISSING'), { kind: kind || (/^skill_/.test(id) ? 'skill' : null) });
  const getSkill = (state, id, kind) => { const skill = state.skills.find(item => item.id === id); if (!skill) throw absent(id, kind || 'skill'); return skill; };
  const getServer = (state, id) => { const server = state.servers.find(item => item.id === id); if (!server) throw error('MCP 服务已归档或不存在', 404, 'EXTENSIONS_OBJECT_MISSING'); if (server.scope === 'client') throw error('软件本地 MCP 的检测请在对应 CLI 中执行；管理配置不会启动服务'); const { kind, revision, dependencies, scope, ...config } = server; return config; };
  const getClient = (state, id, requireSelected = true) => { if (!state.clientsValid) throw error(state.diagnostics.find(issue => issue.code === 'CLIENTS_FORMAT')?.message || 'CLI 登记文件无效', 409); const client = state.registry.find(item => item.id === id || item.registrationId === id); if (!client) throw error('软件未登记或已移除', 404, 'EXTENSIONS_OBJECT_MISSING'); if (requireSelected && !client.selected) throw error('请先在接入软件中选择此 CLI，再管理其 Skills 或 MCP', 409, 'EXTENSIONS_CLIENT_NOT_SELECTED'); return client; };
  // Shared scope/clientId validation for the import actions. Returns the selected client for scope 'client', else null.
  const importTarget = (state, action) => {
    if (!['shared', 'client'].includes(action.scope)) throw fieldError('scope 需要是 shared 或 client。', 'scope');
    if (action.scope === 'shared') { if (action.clientId !== undefined) throw fieldError('导入到共享来源时不需要 clientId。', 'clientId'); return null; }
    if (typeof action.clientId !== 'string' || !action.clientId) throw fieldError('导入到软件需要选择 clientId。', 'clientId');
    return getClient(state, action.clientId);
  };
  const generatedPath = client => path.join(root, 'mcp', 'generated', client.id, 'servers.' + (client.format === 'toml' ? 'toml' : 'json'));
  // E-11 compare: read-only. Never follows links, bounded and redacted (see conflicts.mjs); returns no file bytes beyond a text diff.
  async function compare(query) {
    const id = query.get('id'), clientId = query.get('clientId'), expected = query.get('expectedVersion');
    if (!id) throw fieldError('对比需要 Skill id。', 'id');
    if (!clientId) throw fieldError('对比需要先选择软件。', 'clientId');
    const state = await catalog.state(true);
    if (expected !== null && expected !== state.version) throw error('来源或接入文件已变化，请刷新后重新对比', 409, 'EXTENSIONS_VERSION_CONFLICT');
    const skill = getSkill(state, id, 'skill');
    if (skill.scope !== 'shared' || skill.readOnly) throw fieldError('只有共享来源中的 Skill 有接入冲突可对比。', 'id');
    const client = getClient(state, clientId), entry = skill.bindings.find(item => item.clientId === client.id);
    if (!entry || entry.state !== 'conflict') throw error('该位置没有冲突，不需要对比。', 409, 'EXTENSIONS_NOT_CONFLICT');
    await assertTarget(entry.target);
    const sharedSource = skill.realPath || skill.sourcePath;
    if (!skill.linked) await safePath(root, skill.sourcePath);
    const result = await compareEntries({ sharedSource, localTarget: entry.target });
    return { id: skill.id, clientId: client.id, clientName: client.name, version: state.version, shared: { path: skill.sourcePath }, local: { path: entry.target, kind: result.localKind }, resolution: entry.resolution || null, readOnly: true, ...result };
  }
  // PR-12 compare for same-ID MCP conflicts: read-only POST (it carries the incoming config). References and refStatus only, never values.
  async function mcpCompare(input) {
    if (!plain(input) || Object.keys(input).some(key => !['scope', 'clientId', 'json', 'server', 'expectedVersion'].includes(key))) throw error('对比只接受 scope、clientId、json 或 server、expectedVersion');
    if ((input.json === undefined) === (input.server === undefined)) throw fieldError('请提供 json（导入内容）或 server（单个服务）之一。', input.json === undefined ? 'server' : 'json');
    const state = await catalog.state(true);
    if (input.expectedVersion !== undefined && input.expectedVersion !== state.version) throw error('配置已变化，请刷新后重新对比', 409, 'EXTENSIONS_VERSION_CONFLICT');
    const client = importTarget(state, input);
    const incoming = input.json !== undefined ? parseMcpJson(input.json, { nativeKey: !!client }) : [normalizeServer(input.server, { nativeKey: !!client })];
    let existing;
    if (client) {
      if (!client.mcp) throw error('此 CLI 尚无已核实的 MCP 配置适配器');
      const document = state.clientDocuments.find(item => item.clientId === client.id);
      if (!document?.valid) throw error(document?.message || '用户级 MCP 配置无法读取，原文件已保留', 409);
      existing = new Map(document.servers.map(item => [item.serverKey, item]));
    } else {
      if (!state.mcpValid) throw error('请先修复 MCP 主文件；管理操作不会覆盖格式错误的配置', 409);
      existing = new Map(state.servers.filter(item => item.scope !== 'client').map(item => [item.id, item]));
    }
    const items = [], newIds = [];
    for (const server of incoming) {
      const current = existing.get(server.id);
      if (!current) { newIds.push(server.id); continue; }
      const before = serverView({ ...current, id: server.id }, refStatus(current)), after = serverView(server, refStatus(server));
      items.push({ id: server.id, existing: before, incoming: after, editable: client ? !!current.editable : true, ...differences(before, after) });
    }
    return { readOnly: true, version: state.version, scope: client ? 'client' : 'shared', ...(client ? { clientId: client.id, clientName: client.name } : {}), items, newIds, resolutions: MCP_RESOLUTIONS };
  }
  async function detail(id, file, kind) {
    const state = await catalog.state();
    if (state.registry.some(client => client.id === id)) {
      const client = state.registry.find(client => client.id === id);
      if (!client.selected) return { kind: 'client', ...state.clients.find(item => item.id === id), version: state.version, skills: [], servers: [], generated: null, integration: '尚未选择接入；不会扫描或管理此 CLI 的 Skills、MCP。' };
      const generated = client.mcpMode === 'unsupported' ? null : await readText(await safePath(root, generatedPath(client)), 2_000_000);
      let current = false; try { current = generated === renderMcpConfig(client, state.servers.filter(server => server.scope !== 'client').map(({ kind, revision, dependencies, scope, ...config }) => config)); } catch {}
      return { kind: 'client', ...state.clients.find(item => item.id === id), version: state.version, servers: state.servers.filter(server => server.clientId === id), skills: state.skills.map(skill => ({ id: skill.id, name: skill.name, binding: skill.bindings.find(binding => binding.clientId === id) })), generated: generated === null ? null : { path: generatedPath(client), content: generated, current }, integration: client.mcp ? '可直接管理该软件的用户级 MCP。生成片段仅供导出；项目、插件与兼容来源须在 CLI 中核对。' : '此 CLI 尚无已核实的 MCP 适配器；生成片段需自行接入。' };
    }
    const server = state.servers.find(item => item.id === id);
    if (server) return { ...server, version: state.version, runtimeVerified: false, refStatus: refStatus(server), lastProbe: probeReport(server) };
    const skill = state.skills.find(item => item.id === id);
    if (!skill) throw absent(id, kind);
    if (skill.readOnly) return { ...skill, version: state.version, files: [], content: null, file: null };
    const selected = await skillFile(root, skill, file);
    const directory = skill.sourcePath, files = [];
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
    const action = structuredClone(input), state = await catalog.state(true), steps = [], conflicts = [], impact = [], changedIds = [], warnings = [], resolved = [];
    if (action.type === 'binding.disconnect' && action.includeExisting !== undefined && typeof action.includeExisting !== 'boolean') throw error('includeExisting 需要明确的布尔值');
    const add = async (target, after) => {
      await assertTarget(target); const before = await snapshot(target);
      if (before.kind === 'file' && after.kind === 'file') after.mode = before.mode;
      if (hash(before) !== hash(after)) steps.push({ path: target, before, after, ...(state.registry.some(client => client.mcpPath === target) ? { private: true } : {}) });
    };
    let manifest = state.manifest ? structuredClone(state.manifest) : null, manifestChanged = false;
    const binding = async (skill, client, type, { includeExisting = action.includeExisting, restoring = false } = {}) => {
      if (!manifest) throw error('接入记录损坏，请修复 bindings.json 后操作', 409);
      const source = skill.sourcePath, target = path.join(client.skillsRoot, path.basename(skill.relativePath));
      const identity = skill.realPath || (skill.linked ? null : source);
      if (skill.linked) { if (!identity) throw error('链接失效，不能作为接入来源'); }
      else await safePath(skill.scope === 'client' ? getClient(state, skill.clientId).skillsRoot : root, source);
      await assertTarget(target);
      const actual = await snapshot(target), matches = actual.kind === 'link' && !!identity && await fs.realpath(target).catch(() => null) === identity;
      const owned = manifest.bindings.find(item => item.skillId === skill.id && [client.id, ...(client.aliases || [])].includes(item.clientId) && item.target === target && item.source === source);
      if (!restoring && type !== 'binding.disconnect' && manifest.skillStates?.[skill.id]?.disabled) throw error('该 Skill 已停用，不能接入软件。请先启用它，再选择要接入的软件。', 409, 'EXTENSIONS_SKILL_DISABLED');
      if (type === 'binding.connect') {
        if (!skill.valid) throw error('请先修复 Skill 元数据再接入');
        if (actual.kind !== 'missing') { if (matches) impact.push('已有正确链接，可直接预览移除；不需要先接管。'); else conflicts.push(client.name + ' 的同名位置存在其他内容：' + target); return; }
        await add(target, { kind: 'link', target: source });
        manifest.bindings.push({ skillId: skill.id, clientId: client.id, source, target, linkTarget: source }); manifestChanged = true;
      } else if (type === 'binding.adopt') {
        if (!matches) { conflicts.push('只能接管已经指向主来源的正确链接'); return; }
        if (!owned || owned.linkTarget !== actual.target) { manifest.bindings = manifest.bindings.filter(item => item !== owned); manifest.bindings.push({ skillId: skill.id, clientId: client.id, source, target, linkTarget: actual.target }); manifestChanged = true; }
      } else {
        if (!owned && !includeExisting) { conflicts.push('该链接不属于 Daylight；请先预览接管，或明确确认移除已有正确链接'); return; }
        if (!matches || owned && owned.linkTarget !== actual.target) { conflicts.push('链接目标已被外部修改或不指向主来源，已停止解除'); return; }
        await add(target, { kind: 'missing' });
        if (owned) { manifest.bindings = manifest.bindings.filter(item => item !== owned); manifestChanged = true; }
        impact.push('仅移除 ' + target + ' 的链接，主 Skill 和其他软件保持原样。' + (!owned ? '本次明确确认处理已有正确链接，修改前链接已记录供恢复。' : ''));
      }
      impact.push(client.name + '：' + client.refresh);
    };
    if (action.type === 'skill.create') {
      if (typeof action.directory !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(action.directory)) throw fieldError('新 Skill 目录需要小写字母、数字或短横线，长度 1–64，且不能以短横线开头', 'directory');
      try { metadata(action.content); } catch (failure) { throw fieldError(failure.message, 'content', failure.status, failure.code); }
      const client = action.clientId ? getClient(state, action.clientId) : null;
      const base = client ? client.skillsRoot : path.join(root, 'skills');
      const directory = path.join(base, action.directory); await safePath(client ? client.root : root, directory);
      if (await stat(directory)) conflicts.push('主目录已存在同名内容，不能覆盖');
      await add(path.join(directory, 'SKILL.md'), fileSnapshot(action.content)); changedIds.push(skillId(client ? [client.id, directory] : action.directory));
      impact.push(client ? '保存到 ' + client.name + ' 的本地 Skills 目录；刷新 CLI 后读取。' : '保存到共享来源；在软件勾选框确认后建立对应链接。');
    } else if (action.type === 'skill.import') {
      const client = importTarget(state, action);
      const found = await readSkillFolder(action.sourcePath); action.sourcePath = found.source;
      if (within(root, found.source) && within(path.join(root, 'daylight'), found.source)) throw fieldError('不能从 Daylight 内部记录目录导入。', 'sourcePath');
      if (within(found.source, root)) throw fieldError('不能导入包含 ~/.agents 管理目录的文件夹。请选择单个 Skill 的文件夹。', 'sourcePath');
      const base = client ? client.skillsRoot : path.join(root, 'skills'), directory = path.join(base, found.name);
      await safePath(client ? client.root : root, directory);
      if (within(found.source, directory)) throw fieldError('导入来源包含目标位置，请选择单个 Skill 的文件夹。', 'sourcePath');
      if (await stat(directory)) conflicts.push('已存在同名 Skill（' + found.name + '），导入不会覆盖：' + directory + '。请先归档现有 Skill，或改用其他文件夹名称。');
      await add(directory, found.tree); changedIds.push(skillId(client ? [client.id, directory] : found.name));
      impact.push('复制 ' + found.files.length + ' 个文件（' + Math.ceil(found.bytes / 1024) + ' KB）到 ' + directory + '；来源文件夹不会被修改。' + (path.basename(found.source) !== found.name ? '目录名使用 SKILL.md 中的 name：' + found.name + '。' : ''));
      impact.push('文件：' + found.files.slice(0, 20).join('、') + (found.files.length > 20 ? ' 等 ' + found.files.length + ' 个' : ''));
      if (found.ignored.length) impact.push('已忽略隐藏文件和 node_modules：' + found.ignored.slice(0, 10).join('、') + (found.ignored.length > 10 ? ' 等' : ''));
      impact.push(client ? '保存到 ' + client.name + ' 的本地 Skills 目录；刷新 CLI 后读取。' : '保存到共享来源；导入后在软件勾选框确认才会建立链接。');
    } else if (action.type === 'mcp.importJson') {
      const client = importTarget(state, action), parsed = parseMcpJson(action.json, { nativeKey: !!client }), choices = parseResolutions(action.resolutions, parsed.map(server => server.id)), replaced = [], kept = [];
      for (const server of parsed) for (const warning of serverWarnings(server)) warnings.push({ ...warning, message: '「' + server.id + '」' + warning.message });
      let added = [];
      if (!client) {
        if (!state.mcpValid) throw error('请先修复 MCP 主文件；管理操作不会覆盖格式错误的配置', 409);
        const servers = state.servers.filter(server => server.scope !== 'client').map(({ kind, revision, dependencies, scope, ...config }) => config);
        for (const server of parsed) {
          const index = servers.findIndex(item => item.id === server.id);
          if (index === -1) { servers.push(server); added.push(server); }
          else if (choices[server.id] === 'adoptNew') { servers[index] = server; replaced.push(server); }
          else if (choices[server.id] === 'keepExisting') kept.push(server.id);
          else conflicts.push('已存在 ID 为 ' + server.id + ' 的 MCP 服务，导入不会覆盖。请在下方选择处理方式，或改名后导入。');
        }
        if (servers.length > 500) throw error('MCP 主配置最多管理 500 个服务');
        if (added.length || replaced.length) { const next = json({ schemaVersion: 1, servers }); if (Buffer.byteLength(next) > 2_000_000) throw error('MCP 主配置超过 2 MB，请减少服务或参数'); await add(path.join(root, 'mcp', 'servers.json'), fileSnapshot(next)); }
        impact.push('将新增 ' + added.length + ' 个 MCP 服务到主配置，不启动服务' + (conflicts.length ? '；还没选择处理方式的已有 ID 不会被覆盖' : '') + '。');
        for (const server of replaced) { impact.push('用导入的配置替换现有 MCP「' + server.id + '」；原配置已记录，可在操作历史中点「撤销」恢复。'); for (const skill of state.skills.filter(item => item.dependencies?.includes(server.id))) impact.push('已声明依赖的 Skill：' + skill.name + '（不会修改）。'); }
        if (replaced.length) warnings.push('已生成或已接入软件的配置不会自动更新；需重新生成/接入后才会使用新配置，已有的检测结果会标为过期。');
      } else {
        const document = state.clientDocuments.find(item => item.clientId === client.id);
        let current = document;
        for (const server of parsed) {
          const view = current.servers.find(item => item.serverKey === server.id);
          if (view || current.data?.[client.mcp?.section]?.[server.id]) {
            if (choices[server.id] === 'keepExisting') { kept.push(server.id); continue; }
            if (choices[server.id] !== 'adoptNew') { conflicts.push(client.name + ' 已存在 ID 为 ' + server.id + ' 的 MCP 服务，导入不会覆盖。请在下方选择处理方式，或改名后导入。'); continue; }
            if (!view?.editable) { conflicts.push(client.name + ' 里的「' + server.id + '」包含无法安全编辑的字段，不能替换；请在 CLI 中修改，或请在下方选择处理方式。'); continue; }
            const content = changeClientMcp(client, current, { type: 'save', server, key: server.id });
            current = { ...current, raw: content, data: configDocument(content, client.mcp.format).data }; replaced.push(server); continue;
          }
          const content = changeClientMcp(client, current, { type: 'save', server, key: server.id });
          current = { ...current, raw: content, data: configDocument(content, client.mcp.format).data, servers: [...current.servers, { serverKey: server.id }] }; added.push(server);
        }
        if (added.length || replaced.length) { await add(client.mcpPath, fileSnapshot(current.raw)); }
        impact.push('将新增 ' + added.length + ' 个 MCP 服务到 ' + client.name + ' 的用户级配置，只改对应字段；不启动服务。' + client.refresh);
        for (const server of replaced) impact.push('用导入的配置替换 ' + client.name + ' 的「' + server.id + '」：只改对应字段，软件里无法读取的凭据保持原样；原配置已记录，可在操作历史中点「撤销」恢复。');
      }
      if (kept.length) impact.push('保留现有，不导入：' + kept.slice(0, 20).join('、') + (kept.length > 20 ? ' 等 ' + kept.length + ' 个' : '') + '。');
      resolved.push(...Object.entries(choices).map(([id, resolution]) => ({ id, resolution })));
      for (const server of [...added, ...replaced]) changedIds.push(client ? 'mcp_' + hash([client.id, server.id]).slice(0, 24) : server.id);
    } else if (action.type.startsWith('skill.')) {
      const skill = getSkill(state, action.id); changedIds.push(skill.id);
      if (!skill.readOnly) await safePath(skill.scope === 'client' ? getClient(state, skill.clientId).skillsRoot : root, skill.sourcePath);
      if (action.type === 'skill.update') {
        action.file ||= 'SKILL.md';
        if (typeof action.content !== 'string' || Buffer.byteLength(action.content) > 262144 || action.content.includes('\0')) throw error('文件需要小于 256 KB 的文本');
        if (action.file === 'SKILL.md') metadata(action.content);
        const selected = await skillFile(root, skill, action.file); await add(selected.target, fileSnapshot(action.content));
        impact.push('修改 ' + skill.sourcePath + '；现有正确链接继续指向它。受影响软件：' + skill.bindings.filter(binding => ['managed', 'existing', 'local'].includes(binding.state)).map(binding => getClient(state, binding.clientId).name).join('、') + '。已加载会话需刷新。');
      } else if (action.type === 'skill.disable') {
        if (!manifest) throw error('接入记录损坏，请修复 bindings.json 后操作', 409);
        if (skill.scope !== 'shared' || skill.readOnly) throw fieldError('只有共享来源中的 Skill 可以停用；软件自带的 Skill 请在对应软件中管理，或归档。', 'id');
        if (manifest.skillStates?.[skill.id]?.disabled) throw error('该 Skill 已经是停用状态。如需恢复接入，请选择“启用”。', 409, 'EXTENSIONS_ALREADY_DISABLED');
        const remembered = [], names = [];
        for (const item of skill.bindings.filter(entry => ['managed', 'existing'].includes(entry.state))) {
          const client = getClient(state, item.clientId), before = conflicts.length;
          const owned = manifest.bindings.find(entry => entry.skillId === skill.id && [client.id, ...(client.aliases || [])].includes(entry.clientId) && entry.target === item.target && entry.source === skill.sourcePath);
          const linkTarget = await fs.readlink(item.target).catch(() => null);
          await binding(skill, client, 'binding.disconnect', { includeExisting: true });
          if (conflicts.length === before && linkTarget !== null) { remembered.push({ clientId: client.id, source: skill.sourcePath, target: item.target, linkTarget: owned?.linkTarget ?? linkTarget }); names.push(client.name); }
        }
        setSkillState(manifest, skill.id, { disabled: true, rememberedBindings: remembered }); manifestChanged = true;
        impact.unshift(remembered.length ? '将取消 ' + remembered.length + ' 个软件的链接（' + names.join('、') + '）；Skill 源文件保留，可随时启用恢复。' : '该 Skill 当前没有接入任何软件；停用后不能再接入新软件，可随时启用。');
      } else if (action.type === 'skill.enable') {
        if (!manifest) throw error('接入记录损坏，请修复 bindings.json 后操作', 409);
        if (skill.scope !== 'shared' || skill.readOnly) throw fieldError('只有共享来源中的 Skill 支持启用与停用。', 'id');
        const saved = manifest.skillStates?.[skill.id] || { disabled: false, rememberedBindings: [] };
        if (!saved.disabled && !saved.rememberedBindings.length) throw error('该 Skill 已经是启用状态，没有需要恢复的接入。', 409, 'EXTENSIONS_ALREADY_ENABLED');
        let wanted = null;
        if (action.clientIds !== undefined) {
          const resolve = id => state.registry.find(client => client.id === id || client.registrationId === id)?.id || id;
          if (!Array.isArray(action.clientIds) || action.clientIds.length > 50 || action.clientIds.some(id => typeof id !== 'string' || !id)) throw fieldError('clientIds 需要软件 ID 数组', 'clientIds');
          wanted = new Set(action.clientIds.map(resolve));
          const known = new Set(saved.rememberedBindings.map(item => resolve(item.clientId)));
          const unknown = [...wanted].find(id => !known.has(id));
          if (unknown) throw fieldError('该软件不在这个 Skill 停用前的接入记录中：' + String(unknown).slice(0, 80) + '。请从已记住的软件中选择。', 'clientIds');
        }
        const remaining = [], restored = [], skipped = [];
        for (const item of saved.rememberedBindings) {
          let client = null; try { client = getClient(state, item.clientId, false); } catch {}
          if (wanted && !wanted.has(client?.id || item.clientId)) { remaining.push(item); continue; }
          if (!client || !client.selected) { remaining.push(item); skipped.push(client?.name || item.clientId); continue; }
          if (item.source !== skill.sourcePath || item.target !== path.join(client.skillsRoot, path.basename(skill.relativePath))) { impact.push(client.name + '：来源或接入位置已变化，旧记录已丢弃，请手动重新接入。'); continue; }
          const target = item.target, identity = skill.realPath || skill.sourcePath;
          const matches = (await snapshot(target)).kind === 'link' && await fs.realpath(target).catch(() => null) === identity;
          const before = conflicts.length;
          await binding(skill, client, matches ? 'binding.adopt' : 'binding.connect', { restoring: true });
          if (conflicts.length === before) restored.push(client.name);
        }
        if (skipped.length) impact.push('以下软件当前未接入 Daylight，暂未恢复（记录已保留）：' + skipped.join('、') + '。');
        setSkillState(manifest, skill.id, { disabled: false, rememberedBindings: remaining }); manifestChanged = true;
        impact.unshift(restored.length ? '将恢复 ' + restored.length + ' 个软件的链接（' + restored.join('、') + '）；已启用的 Skill 可随时再次停用。' : '将启用该 Skill；没有需要恢复的软件链接。');
      } else if (action.type === 'skill.resolveConflict') {
        if (!manifest) throw error('接入记录损坏，请先修复接入记录后再操作', 409);
        if (!['adoptShared', 'keepLocal', 'reopen'].includes(action.resolution)) throw fieldError('冲突处理方式只能是「采用共享版本」、「保留软件内版本」或「重新处理」。', 'resolution');
        if (typeof action.clientId !== 'string' || !action.clientId) throw fieldError('处理冲突需要先选择软件。', 'clientId');
        if (skill.scope !== 'shared' || skill.readOnly) throw fieldError('只有共享来源中的 Skill 有接入冲突可处理。', 'id');
        const client = getClient(state, action.clientId); action.clientId = client.id;
        const entry = skill.bindings.find(item => item.clientId === client.id), target = path.join(client.skillsRoot, path.basename(skill.relativePath));
        const record = findResolution(manifest, skill.id, client.id, target);
        if (action.resolution === 'reopen') {
          if (!record) throw error('该位置没有“保留软件内版本”的记录。', 409, 'EXTENSIONS_NOT_RESOLVED');
          setResolution(manifest, { skillId: skill.id, clientId: client.id, target }, null); manifestChanged = true;
          impact.push(client.name + ' 的同名位置将重新作为冲突提示；不改动任何文件。');
        } else {
          if (!entry || entry.state !== 'conflict') throw error(entry?.state === 'not_connected' ? '该位置没有冲突，可以直接接入。' : '该位置没有冲突：它已经指向共享版本或就是该软件自己的 Skill。', 409, 'EXTENSIONS_NOT_CONFLICT');
          if (action.resolution === 'keepLocal') {
            if (entry.resolution === 'keepLocal') throw error('已经保留软件内版本；内容变化前不会再提示。', 409, 'EXTENSIONS_ALREADY_RESOLVED');
            setResolution(manifest, { skillId: skill.id, clientId: client.id, target }, await fingerprintEntry(target)); manifestChanged = true;
            impact.push('保留 ' + client.name + ' 里的版本：不改动任何文件，也不建立链接；之后不再作为问题提示，该位置内容变化后会重新提示。');
          } else {
            if (manifest.skillStates?.[skill.id]?.disabled) throw error('该 Skill 已停用，不能接入软件。请先启用它，再采用共享版本。', 409, 'EXTENSIONS_SKILL_DISABLED');
            if (!skill.valid) throw error('请先修复 Skill 元数据再采用共享版本');
            const source = skill.sourcePath, identity = skill.realPath || (skill.linked ? null : source);
            if (skill.linked && !identity) throw error('链接失效，不能作为采用来源');
            if (!skill.linked) await safePath(root, source);
            await add(target, { kind: 'link', target: source });
            const replaced = steps.find(step => step.path === target);
            if (replaced?.before.kind === 'file') replaced.private = true;
            manifest.bindings = manifest.bindings.filter(item => !(item.skillId === skill.id && [client.id, ...(client.aliases || [])].includes(item.clientId) && item.target === target));
            manifest.bindings.push({ skillId: skill.id, clientId: client.id, source, target, linkTarget: source });
            setResolution(manifest, { skillId: skill.id, clientId: client.id, target }, null); manifestChanged = true;
            impact.push('用共享版本替换 ' + client.name + ' 里的同名' + ({ directory: '目录', file: '文件', link: '链接' }[replaced?.before.kind] || '内容') + '：' + target + '。原内容已记录，可在操作历史中点「撤销」恢复（不超过 2500 个文件 / 8 MB）。');
            impact.push(client.name + '：' + client.refresh);
            warnings.push('软件内版本里不在共享版本中的内容将不再被该软件读取。覆盖前请先用“对比差异”核对。');
          }
        }
      } else {
        const source = skill.sourcePath, archive = path.join(root, 'archive', 'skills', skill.id + '_' + state.version.slice(0, 12));
        if (await stat(archive)) conflicts.push('归档位置已有内容，请先核对恢复记录');
        const affected = state.skills.filter(item => within(source, item.sourcePath));
        for (const item of affected) {
          changedIds.push(item.id);
          for (const owned of manifest?.bindings.filter(binding => binding.skillId === item.id) || []) await binding(item, getClient(state, owned.clientId), 'binding.disconnect');
          if (manifest && setSkillState(manifest, item.id, null)) manifestChanged = true;
          if (manifest && dropResolutions(manifest, item.id)) manifestChanged = true;
          impact.push(item.linked ? '仅移除 ' + item.sourcePath + ' 的链接，保留其源文件。' : '归档 ' + item.name + '；移除由 Daylight 管理的链接，已有其他链接保留且可能失效。');
        }
        await add(archive, await snapshot(source)); await add(source, { kind: 'missing' });
      }
    } else if (action.type.startsWith('binding.')) {
      const skill = getSkill(state, action.id); changedIds.push(skill.id); await binding(skill, getClient(state, action.clientId), action.type);
    } else if (action.type.startsWith('client.')) {
      if (!state.clientsValid) throw error('请先修复 CLI 登记文件；原文件不会被覆盖', 409);
      const profiles = structuredClone(state.clientConfig.clients);
      if (action.type === 'client.select') {
        if (typeof action.selected !== 'boolean') throw error('接入选择需要明确布尔值');
        const client = getClient(state, action.clientId, false);
        const selectedClients = state.registry.filter(item => item.selected && item.id !== client.id).map(item => item.id);
        if (action.selected) selectedClients.push(client.id);
        const config = normalizeClientConfig({ ...state.clientConfig, selectedClients });
        await validateClientRegistry(root, config, registryOptions);
        await add(clientsFile(root), fileSnapshot(json(config))); changedIds.push(client.id);
        impact.push(action.selected ? '选择接入 ' + client.name + '；开始读取其 Skills 和用户级 MCP。选择本身不会建立链接、改写软件配置或执行 CLI。' : '取消接入 ' + client.name + '；停止读取和管理其 Skills、MCP，保留原有文件、链接和管理记录。');
      } else if (action.type === 'client.save') {
        action.client = normalizeClient(action.client, home);
        const index = profiles.findIndex(client => client.id === action.client.id), existing = index === -1 ? null : getClient(state, action.client.id, false);
        if (state.servers.some(server => server.id === action.client.id)) throw error('CLI ID 与现有 MCP 服务冲突');
        if (index === -1) profiles.push(action.client); else profiles[index] = action.client;
        const selectedClients = state.registry.filter(client => client.selected).map(client => client.id);
        if (index === -1) selectedClients.push(action.client.id);
        const config = normalizeClientConfig({ schemaVersion: 1, clients: profiles, selectedClients });
        const next = (await validateClientRegistry(root, config, registryOptions)).find(client => client.id === action.client.id || client.registrationId === action.client.id);
        if (existing && existing.skillsRoot !== next.skillsRoot) {
          if (!manifest) throw error('请先修复接入记录，再修改 CLI 目录', 409);
          if (manifest.bindings.some(binding => binding.clientId === existing.id)) conflicts.push('请先解除该软件已管理的 Skill 链接，再修改接入目录');
        }
        await add(clientsFile(root), fileSnapshot(json(config))); changedIds.push(next.id);
        impact.push((existing ? '更新 ' : '登记 ') + action.client.name + '；后续可在 Skills 中勾选接入。登记不会安装或执行 CLI。');
      } else {
        const client = getClient(state, action.clientId, false);
        const profile = profiles.find(profile => profile.id === action.clientId);
        if (!profile) throw error('内置或自动识别的软件无需移除登记');
        if (!manifest) throw error('请先修复接入记录，再移除 CLI 登记', 409);
        const bindings = manifest.bindings.filter(binding => binding.clientId === action.clientId);
        if (client.registrationId === action.clientId) {
          manifest.bindings = manifest.bindings.map(binding => binding.clientId === action.clientId ? { ...binding, clientId: client.id } : binding); manifestChanged = !!bindings.length;
        }
        for (const binding of bindings) if (!client.registrationId && await stat(binding.target)) conflicts.push('请先解除已管理的 Skill 链接：' + binding.target);
        if (!client.registrationId && !conflicts.length && bindings.length) { manifest.bindings = manifest.bindings.filter(binding => binding.clientId !== client.id); manifestChanged = true; }
        const selectedClients = state.registry.filter(item => item.selected && (item.id !== client.id || client.registrationId)).map(item => item.id);
        await add(clientsFile(root), fileSnapshot(json({ schemaVersion: 1, clients: profiles.filter(profile => profile.id !== action.clientId), selectedClients }))); changedIds.push(client.id);
        impact.push('仅移除 ' + client.name + ' 的登记；CLI 程序、主来源、软件目录和未接管的链接保留。');
      }
    } else if (action.type === 'mcp.install' || action.type === 'mcp.toggle' && state.servers.find(server => server.id === action.id)?.scope === 'client' || action.type === 'mcp.save' && action.clientId || action.type === 'mcp.archive' && state.servers.find(server => server.id === action.id)?.scope === 'client') {
      const item = action.id ? state.servers.find(server => server.id === action.id) : null;
      if (action.id && !item) throw error('MCP 服务不存在', 404);
      const client = getClient(state, action.clientId || item.clientId), document = state.clientDocuments.find(document => document.clientId === client.id);
      let server = action.server, keepExisting = false;
      if (action.type === 'mcp.install') {
        if (item.scope === 'client') throw error('请选择共享 MCP 配置接入软件');
        server = getServer(state, item.id);
        if (document.data?.[client.mcp?.section]?.[server.id]) conflicts.push('软件已存在同名 MCP；请编辑现有服务，不能覆盖接入');
      }
      if (action.type === 'mcp.save') {
        if (action.create !== undefined && typeof action.create !== 'boolean') throw fieldError('create 需要明确的布尔值', 'create');
        action.server = server = normalizeServer(action.server, { nativeKey: true });
        const existing = document.servers.find(item => item.serverKey === server.id);
        const choice = parseResolution(action.onConflict, 'onConflict');
        if (choice && action.create !== true) throw fieldError('处理方式只在新建服务时使用。', 'onConflict');
        const duplicate = !!(existing || document.data?.[client.mcp?.section]?.[server.id]);
        if (action.create && duplicate && !choice) throw fieldError('该软件已存在 ID 为 ' + server.id + ' 的 MCP 服务。请在下方选择处理方式，或改用其他 ID、编辑现有服务。', 'server.id', 409, 'EXTENSIONS_DUPLICATE_ID');
        if (action.create && duplicate && choice === 'keepExisting') { keepExisting = true; resolved.push({ id: server.id, resolution: choice }); impact.push('保留 ' + client.name + ' 里现有的「' + server.id + '」，不做任何修改。'); }
        else {
          warnings.push(...serverWarnings(server));
          if (existing && !existing.editable) throw error('此配置包含无法安全编辑的字段；请在 CLI 中修改，或移除配置');
          if (action.create && duplicate) { resolved.push({ id: server.id, resolution: choice }); impact.push('用新配置替换 ' + client.name + ' 里现有的「' + server.id + '」；软件里无法读取的凭据保持原样，原配置已记录，可在操作历史中点「撤销」恢复。'); }
        }
      }
      if (action.type === 'mcp.toggle' && typeof action.enabled !== 'boolean') throw error('启停需要明确布尔值');
      const key = server?.id || item.serverKey;
      if (!keepExisting) {
        const content = changeClientMcp(client, document, { type: action.type === 'mcp.archive' ? 'remove' : action.type === 'mcp.toggle' ? 'toggle' : 'save', server, key, enabled: action.enabled });
        await add(client.mcpPath, fileSnapshot(content));
        changedIds.push('mcp_' + hash([client.id, key]).slice(0, 24));
        impact.push('修改 ' + client.name + ' 的用户级 MCP：' + key + '。只改变对应字段，保留其他配置和未编辑的凭据；保存不会启动服务。' + client.refresh);
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
      const servers = state.servers.filter(server => server.scope !== 'client').map(({ kind, revision, dependencies, scope, ...config }) => config);
      if (action.type === 'mcp.save') {
        if (action.create !== undefined && typeof action.create !== 'boolean') throw fieldError('create 需要明确的布尔值', 'create');
        action.server = normalizeServer(action.server); const index = servers.findIndex(server => server.id === action.server.id);
        const choice = parseResolution(action.onConflict, 'onConflict');
        if (choice && action.create !== true) throw fieldError('处理方式只在新建服务时使用。', 'onConflict');
        if (index !== -1 && action.create && !choice) throw fieldError('已存在 ID 为 ' + action.server.id + ' 的 MCP 服务。请在下方选择处理方式，或改用其他 ID、编辑现有服务。', 'server.id', 409, 'EXTENSIONS_DUPLICATE_ID');
        if (index !== -1 && action.create && choice === 'keepExisting') {
          resolved.push({ id: action.server.id, resolution: choice }); impact.push('保留现有 MCP「' + action.server.id + '」，不做任何修改。');
        } else {
          warnings.push(...serverWarnings(action.server));
          if (index === -1) servers.push(action.server); else servers[index] = action.server;
          if (servers.length > 500) throw error('MCP 主配置最多管理 500 个服务');
          changedIds.push(action.server.id); await add(path.join(root, 'mcp', 'servers.json'), fileSnapshot(json({ schemaVersion: 1, servers })));
          if (Buffer.byteLength(json({ schemaVersion: 1, servers })) > 2_000_000) throw error('MCP 主配置超过 2 MB，请减少服务或参数');
          impact.push('仅保存 MCP 主配置，不启动服务。已生成的客户端配置需重新生成并在客户端接入。');
          if (index !== -1 && action.create) { resolved.push({ id: action.server.id, resolution: choice }); impact.push('用新配置替换现有 MCP「' + action.server.id + '」；原配置已记录，可在操作历史中点「撤销」恢复。'); warnings.push('已生成或已接入软件的配置不会自动更新；需重新生成/接入后才会使用新配置。'); }
        }
      } else if (action.type === 'mcp.archive') {
        const server = getServer(state, action.id), archive = path.join(root, 'archive', 'mcp', server.id + '_' + state.version.slice(0, 12) + '.json');
        if (await stat(archive)) conflicts.push('归档位置已存在内容');
        await add(archive, fileSnapshot(json(server))); await add(path.join(root, 'mcp', 'servers.json'), fileSnapshot(json({ schemaVersion: 1, servers: servers.filter(item => item.id !== action.id) })));
        changedIds.push(server.id); impact.push('归档 MCP 主配置，已经运行的外部客户端不会立即断连。');
        for (const skill of state.skills.filter(item => item.dependencies?.includes(server.id))) impact.push('已声明依赖的 Skill：' + skill.name + '（不会删除）。');
      } else if (action.type === 'mcp.toggle') {
        if (typeof action.enabled !== 'boolean') throw fieldError('启停需要明确布尔值', 'enabled');
        const index = servers.findIndex(server => server.id === action.id); if (index === -1) throw error('MCP 服务不存在', 404, 'EXTENSIONS_OBJECT_MISSING');
        if (servers[index].enabled === action.enabled) throw error(action.enabled ? '该服务已经是启用状态，请刷新后查看' : '该服务已经是停用状态，请刷新后查看', 409, action.enabled ? 'EXTENSIONS_ALREADY_ENABLED' : 'EXTENSIONS_ALREADY_DISABLED');
        servers[index] = { ...servers[index], enabled: action.enabled };
        await add(path.join(root, 'mcp', 'servers.json'), fileSnapshot(json({ schemaVersion: 1, servers }))); changedIds.push(action.id);
        impact.push((action.enabled ? '启用 ' : '停用 ') + servers[index].name + '：仅修改 MCP 主配置，不启动服务；已生成或已接入软件的配置需重新生成/接入后才会变化。' + (action.enabled ? '' : '正在进行的检测会取消，停用期间不能检测。'));
        for (const skill of state.skills.filter(item => item.dependencies?.includes(action.id))) impact.push('已声明依赖的 Skill：' + skill.name + '（不会修改）。');
      } else if (action.type === 'mcp.generate') {
        const client = getClient(state, action.clientId); await add(generatedPath(client), fileSnapshot(renderMcpConfig(client, servers)));
        impact.push('为 ' + client.name + ' 生成独立适配文件；需在客户端接入，不修改全局配置。');
      } else {
        const server = getServer(state, action.id); if (!server.enabled) throw error('服务已在主配置中禁用，请先编辑配置');
        impact.push('显式启动一次 ' + server.name + ' 检测：' + (server.command ? [server.command, ...server.args].join(' ') : server.url) + '；仅握手并列工具，完成后关闭检测连接。');
      }
    }
    if (manifestChanged) await add(path.join(root, 'daylight', 'bindings.json'), fileSnapshot(json(manifest)));
    const plan = { normalizedAction: action, expectedVersion: state.version, steps, conflicts, impact, warnings, changedIds: [...new Set(changedIds)], ...(resolved.length ? { resolved } : {}) };
    plan.planId = hash({ action, version: state.version, steps: steps.map(step => [step.path, hash(step.before), hash(step.after)]), conflicts });
    return plan;
  }
  function publicPlan(plan) {
    return { normalizedAction: plan.normalizedAction, expectedVersion: plan.expectedVersion, planId: plan.planId, conflicts: plan.conflicts, impact: plan.impact, warnings: plan.warnings, changedIds: plan.changedIds, ...(plan.resolved ? { resolved: plan.resolved } : {}),
      files: plan.steps.map(step => ({ path: step.path, beforeKind: step.before.kind, afterKind: step.after.kind, beforeHash: hash(step.before), afterHash: hash(step.after), ...(!step.private && step.before.kind === 'file' && Buffer.from(step.before.data, 'base64').length <= 262144 ? { before: Buffer.from(step.before.data, 'base64').toString('utf8') } : {}), ...(!step.private && step.after.kind === 'file' && Buffer.from(step.after.data, 'base64').length <= 262144 ? { after: Buffer.from(step.after.data, 'base64').toString('utf8') } : {}), ...(step.after.kind === 'link' ? { linkTarget: step.after.target } : {}) })) };
  }
  async function apply(input) {
    if (!input || Object.keys(input).some(key => !['requestId', 'expectedVersion', 'planId', 'action'].includes(key)) || typeof input.expectedVersion !== 'string' || typeof input.planId !== 'string') throw error('提交需要 requestId、expectedVersion、planId 和 action');
    let newlyApplied = false;
    const result = await transactions.execute(input, prepare, async (plan, record) => {
      newlyApplied = true;
      catalog.invalidate(); const state = await catalog.state(true);
      return { ok: true, status: 'applied', kind: 'extensions', version: state.version, operationId: record.requestId, action: plan.normalizedAction, changedIds: plan.changedIds, impact: plan.impact, ...(plan.normalizedAction.type === 'mcp.probe' ? { probeId: record.requestId, message: '检测已确认。握手状态请读取检测记录；这不是其他客户端的发现结果。' } : {}) };
    });
    const state = await catalog.state(); await probes.reconcile(state.servers.filter(server => server.scope !== 'client'));
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
      else if (route === '/compare') value = await compare(url.searchParams);
      else if (route === '/mcp-compare') value = await mcpCompare(input);
      else if (route === '/actions') value = await apply(input);
      else if (route.startsWith('/objects/')) value = await detail(route.slice('/objects/'.length), url.searchParams.get('file') || undefined, ['skill', 'mcp', 'client'].includes(url.searchParams.get('kind')) ? url.searchParams.get('kind') : undefined);
      else if (route.startsWith('/operations/')) value = await transactions.receipt(route.slice('/operations/'.length));
      else if (route === '/probes') {
        if (Object.keys(input).some(key => !['id', 'ids', 'expectedVersion'].includes(key))) throw error('检测只接受 id（或 ids）和 expectedVersion');
        const state = await catalog.state(true); if (state.version !== input.expectedVersion) throw error('配置已变化，请刷新后重新确认检测', 409);
        if (input.ids !== undefined) {
          // "Test all": one explicit confirmation for a visible list. At most two connections run at once, the rest wait in a queue.
          if (input.id !== undefined || !Array.isArray(input.ids) || !input.ids.length || input.ids.length > 50 || new Set(input.ids).size !== input.ids.length || input.ids.some(id => typeof id !== 'string')) throw fieldError('ids 需为 1–50 个不重复的服务 ID', 'ids');
          const targets = input.ids.map(id => getServer(state, id)), skipped = targets.filter(server => !server.enabled).map(server => ({ id: server.id, reason: 'disabled' }));
          value = { probes: targets.filter(server => server.enabled).map(server => probes.start(server, undefined, { queue: true })), skipped };
        } else { const server = getServer(state, input.id); if (!server.enabled) throw error('服务已禁用'); value = probes.start(server); }
      } else value = req.method === 'DELETE' ? await probes.cancel(route.slice('/probes/'.length)) : probes.get(route.slice('/probes/'.length));
      send(res, 200, value);
    } catch (failure) { send(res, failure.status || 500, { error: failure.status ? failure.message : '扩展操作失败，请核对回执后用原请求重试', code: failure.code || 'EXTENSIONS_IO', ...(failure.status && failure.field ? { field: failure.field } : {}), ...(failure.status && Number.isInteger(failure.line) ? { line: failure.line, column: failure.column } : {}), ...(failure.status && failure.kind ? { kind: failure.kind } : {}) }); }
  }
  return { handle, state: async force => publicState(await catalog.state(force)), detail, prepare: async action => publicPlan(await prepare(action)), apply, operation: transactions.receipt, probes, close: probes.close };
}
