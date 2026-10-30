import * as fs from 'node:fs/promises';
import path from 'node:path';
import { error, hash, within, stat, safePath, readText, readJSON } from './files.mjs';
import { metadata, skillId } from './skill-files.mjs';
import { clientAdapters } from './client-adapters.mjs';
import { readClientMcp } from './client-mcp.mjs';
import { parse as parseJSONC } from 'jsonc-parser';
import { normalizeServers } from './mcp-server.mjs';
import { normalizeManifest } from './skill-state.mjs';
import { findResolution, fingerprintEntry } from './conflicts.mjs';

export function createCatalog({ root, clients, loadClients, environment = process.env, cacheMs = 1000 }) {
  let cache, scannedAt = 0, scanning, generation = 0;
  async function scan() {
    const skills = [], diagnostics = [], signatures = [];
    const registration = loadClients ? await loadClients() : { clients, config: { schemaVersion: 1, clients: [] }, raw: null, valid: true };
    const registry = registration.clients;
    const connected = registry.filter(client => client.selected);
    if (!registration.valid) diagnostics.push({ code: 'CLIENTS_FORMAT', message: registration.message });
    // A skill is one real directory. Links that resolve to it are bindings, not more skills.
    async function listEntries(base, client = null) {
      try {
        await safePath(client ? client.root : root, base);
        const entries = await fs.readdir(base, { withFileTypes: true }).catch(failure => { if (failure.code === 'ENOENT') return []; throw failure; });
        if (entries.length > 5000) diagnostics.push({ code: 'SCAN_LIMIT', reason: 'directories', limit: 5000, skippedBranches: entries.length - 5000, path: client ? base : 'skills/' + entries[5000]?.name, message: 'Skills 目录超过 5000 项，剩余目录未读取。' });
        const found = [];
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 5000)) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || !entry.isDirectory() && !entry.isSymbolicLink()) continue;
          const sourcePath = path.join(base, entry.name);
          found.push({ client, base, name: entry.name, sourcePath, link: entry.isSymbolicLink(), real: await fs.realpath(sourcePath).catch(() => null) });
        }
        return found;
      } catch (failure) { diagnostics.push({ clientId: client?.id, code: failure.code || 'SOURCE_UNREADABLE', message: failure.message, path: base }); return []; }
    }
    const discovered = await listEntries(path.join(root, 'skills'));
    for (const client of connected) discovered.push(...await listEntries(client.skillsRoot, client));
    const claimed = new Set();
    const entryId = entry => entry.client ? skillId([entry.client.id, entry.sourcePath]) : skillId(entry.name);
    function noteUnresolved(entry) {
      diagnostics.push({ id: entryId(entry), clientId: entry.client?.id, code: 'EXTERNAL_SOURCE', message: '外部或失效 Skill 链接未读取：' + entry.sourcePath, path: entry.sourcePath });
    }
    async function hasSkillDocument(real) {
      try { return (await fs.stat(path.join(real, 'SKILL.md'))).isFile(); } catch { return false; }
    }
    for (const entry of discovered) {
      if (entry.link) continue;
      if (!entry.real || !within(entry.base, entry.real)) { signatures.push([entry.sourcePath, entry.real, (await stat(entry.sourcePath))?.mtimeMs]); noteUnresolved(entry); continue; }
      if (claimed.has(entry.real) || !(await stat(path.join(entry.sourcePath, 'SKILL.md')))) continue;
      claimed.add(entry.real);
      const id = entryId(entry);
      const common = { id, kind: 'skill', scope: entry.client ? 'client' : 'shared', ...(entry.client ? { clientId: entry.client.id } : {}), relativePath: entry.name, sourcePath: entry.sourcePath, realPath: entry.real };
      try {
        await safePath(entry.base, path.join(entry.sourcePath, 'SKILL.md'));
        const content = await readText(path.join(entry.sourcePath, 'SKILL.md')), meta = metadata(content);
        signatures.push([entry.sourcePath, hash(content)]);
        skills.push({ ...common, ...meta, valid: true, revision: hash(content) });
      } catch (failure) {
        signatures.push([entry.sourcePath, (await stat(path.join(entry.sourcePath, 'SKILL.md')))?.mtimeMs]);
        skills.push({ ...common, name: entry.name, description: '', dependencies: null, valid: false, problem: failure.message });
        diagnostics.push({ id, code: failure.code || 'SKILL_FORMAT', message: failure.message });
      }
    }
    for (const entry of discovered) {
      if (!entry.link || entry.real && claimed.has(entry.real)) continue;
      const recognized = !!entry.real && await hasSkillDocument(entry.real);
      signatures.push([entry.sourcePath, entry.real, (await stat(entry.sourcePath))?.mtimeMs]);
      if (!entry.client && !recognized) { noteUnresolved(entry); continue; }
      const key = entry.real || entry.sourcePath;
      if (claimed.has(key)) continue;
      claimed.add(key);
      if (!recognized) noteUnresolved(entry);
      skills.push({
        id: entryId(entry), kind: 'skill', scope: entry.client ? 'client' : 'shared', ...(entry.client ? { clientId: entry.client.id } : {}),
        relativePath: entry.name, sourcePath: entry.sourcePath, realPath: entry.real, linked: true, readOnly: true, name: entry.name,
        description: recognized ? '管理目录之外的 Skill 链接，不改写源文件。' : '外部或失效链接；可移除链接，保留其源文件',
        dependencies: null, valid: recognized,
      });
    }
    let servers = [], mcpValid = true, mcpRaw = null, manifest = { schemaVersion: 1, bindings: [] };
    try {
      const file = path.join(root, 'mcp', 'servers.json'); await safePath(root, file);
      mcpRaw = await readText(file, 2_000_000);
      servers = normalizeServers(mcpRaw === null ? { schemaVersion: 1, servers: [] } : JSON.parse(mcpRaw));
    } catch (failure) {
      mcpValid = false;
      // Only line/column are taken from a JSON syntax error: its text can echo file content. Schema errors are our own safe messages.
      let position = null;
      if (failure instanceof SyntaxError && typeof mcpRaw === 'string') {
        const errors = []; parseJSONC(mcpRaw, errors, { disallowComments: true, allowTrailingComma: false });
        if (errors.length) { const before = mcpRaw.slice(0, errors[0].offset); position = [null, before.split('\n').length, before.length - before.lastIndexOf('\n')]; }
      }
      diagnostics.push({ code: 'MCP_FORMAT', message: 'MCP 主配置无效；请修复 servers.json，原文件不会被覆盖', path: path.join(root, 'mcp', 'servers.json'), ...(position ? { line: Number(position[1]), column: Number(position[2]) } : {}), ...(failure instanceof SyntaxError ? { reason: 'JSON 语法错误' } : failure.status ? { reason: failure.message } : {}) });
    }
    try { await safePath(root, path.join(root, 'daylight', 'bindings.json')); manifest = await readJSON(path.join(root, 'daylight', 'bindings.json'), manifest); if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.bindings)) throw error('接入记录格式错误'); manifest = normalizeManifest(manifest); }
    catch { diagnostics.push({ code: 'BINDINGS_FORMAT', message: '接入记录格式错误，接入写入已暂停' }); manifest = null; }
    const clientDocuments = await Promise.all(connected.map(readClientMcp));
    for (const document of clientDocuments) { signatures.push(['mcp', document.clientId, document.raw, document.valid]); if (!document.valid) diagnostics.push({ clientId: document.clientId, code: 'CLIENT_MCP_FORMAT', message: document.message }); }
    const clientStates = await Promise.all(registry.map(async client => ({ id: client.id, name: client.name, command: client.command, root: client.root, skillsDirectory: client.skillsDirectory, custom: client.custom, registrationId: client.registrationId, discovered: !!client.discovered, selected: client.selected, adapter: client.adapter, mcpPath: client.mcpPath, mcpToggle: !!client.mcp?.toggle, mcpValid: clientDocuments.find(document => document.clientId === client.id)?.valid ?? null, mcpFormat: client.format || 'none', skillMode: client.skillMode, mcpMode: client.mcpMode, note: client.note, refresh: client.refresh, skillsRoot: client.skillsRoot, ...await client.detect() })));
    for (const skill of skills) {
      skill.bindings = [];
      for (const client of connected) {
        const target = path.join(client.skillsRoot, path.basename(skill.relativePath)), info = await stat(target);
        let link = null, matches = false;
        if (info?.isSymbolicLink()) { link = await fs.readlink(target); const identity = skill.realPath || (skill.linked ? null : skill.sourcePath); matches = !!identity && await fs.realpath(target).catch(() => null) === identity; }
        const owned = manifest?.bindings.some(binding => binding.skillId === skill.id && [client.id, ...(client.aliases || [])].includes(binding.clientId) && binding.target === target && binding.source === skill.sourcePath && binding.linkTarget === link);
        const state = skill.scope === 'client' && skill.clientId === client.id ? 'local' : info ? matches ? owned ? 'managed' : 'existing' : 'conflict' : 'not_connected';
        // E-11: a conflict the owner chose to keep stays a conflict (nothing is linked) but stops being reported as a problem
        // until the local content changes. `resolutionStale` marks a remembered choice whose local content changed since.
        let resolution = null, resolutionStale = false;
        if (state === 'conflict') { const saved = findResolution(manifest, skill.id, client.id, target); if (saved) { if (await fingerprintEntry(target).catch(() => null) === saved.fingerprint) resolution = 'keepLocal'; else resolutionStale = true; } }
        skill.bindings.push({ clientId: client.id, state, owned: !!owned, target, runtimeVerified: false, ...(state === 'conflict' ? { resolution, ...(resolutionStale ? { resolutionStale } : {}) } : {}) });
        signatures.push([client.id, target, info ? [info.isSymbolicLink() ? 'link' : 'entity', link, info.ino, info.mtimeMs] : null]);
        if (state === 'conflict' && !resolution) diagnostics.push({ id: skill.id, clientId: client.id, code: 'BINDING_CONFLICT', message: '同名接入位置已存在其他内容，不能覆盖' });
      }
    }
    // Skill enable state lives in the manifest (`skillStates`); an absent entry means enabled with nothing remembered.
    for (const skill of skills) {
      const saved = skill.scope === 'shared' && !skill.readOnly ? manifest?.skillStates?.[skill.id] : null;
      skill.enabled = !saved?.disabled;
      skill.rememberedClientIds = (saved?.rememberedBindings || []).map(item => item.clientId);
    }
    for (const skill of skills) for (const id of skill.dependencies || []) if (!servers.some(server => server.id === id && server.enabled)) diagnostics.push({ id: skill.id, code: 'DEPENDENCY_UNAVAILABLE', message: '明确依赖的 MCP 不存在或主配置禁用：' + id });
    for (const server of servers) for (const ref of Object.values(server.envRefs || server.headerRefs || {})) if (!environment[ref]) diagnostics.push({ id: server.id, code: 'ENV_MISSING', message: '检测环境缺少变量：' + ref + '（客户端环境须另外核对）' });
    // Every diagnostic names the page it belongs to so a tab shows only its own problems.
    const diagnosticTabs = { MCP_FORMAT: 'mcp', CLIENT_MCP_FORMAT: 'mcp', ENV_MISSING: 'mcp', CLIENTS_FORMAT: 'clients' };
    for (const diagnostic of diagnostics) diagnostic.tab = diagnosticTabs[diagnostic.code] || 'skills';
    const version = hash([signatures.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), mcpRaw, manifest, registration.raw, clientStates.map(({ id, root, skillsDirectory, mcpFormat, selected }) => ({ id, root, skillsDirectory, mcpFormat, selected }))]);
    return { version, root, adapters: clientAdapters.map(({ id, name }) => ({ id, name })), skills, clientDocuments, servers: [...servers.map(server => ({ ...server, kind: 'mcp', scope: 'shared', revision: hash(server), dependencies: skills.filter(skill => skill.dependencies?.includes(server.id)).map(skill => ({ id: skill.id, name: skill.name })) })), ...clientDocuments.flatMap(document => document.servers)], clients: clientStates, diagnostics, mcpValid, bindingsValid: !!manifest, clientsValid: registration.valid, manifest, registry, clientConfig: registration.config };
  }
  async function state(force = false) {
    if (!force && cache && Date.now() - scannedAt < cacheMs) return cache;
    if (!scanning) {
      const entry = { generation, promise: null };
      entry.promise = scan().then(value => {
        if (entry.generation === generation) { cache = value; scannedAt = Date.now(); }
        return value;
      }).finally(() => { if (scanning === entry) scanning = null; });
      scanning = entry;
    }
    const entry = scanning, value = await entry.promise;
    // A write may complete while a previous read is scanning. Its result must
    // never publish that obsolete scan or report its version as the new state.
    return entry.generation === generation ? value : state(force);
  }
  return { state, invalidate() { generation++; cache = null; scannedAt = 0; } };
}
