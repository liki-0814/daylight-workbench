import * as fs from 'node:fs/promises';
import path from 'node:path';
import { error, hash, within, stat, safePath, readText, readJSON } from './files.mjs';
import { metadata, skillId } from './skill-files.mjs';
import { clientAdapters } from './client-adapters.mjs';
import { readClientMcp } from './client-mcp.mjs';
import { normalizeServers } from './mcp-server.mjs';

export function createCatalog({ root, clients, loadClients, environment = process.env, cacheMs = 1000 }) {
  let cache, scannedAt = 0, scanning, generation = 0;
  async function scan() {
    const skills = [], diagnostics = [], signatures = [], pendingLinks = [];
    const registration = loadClients ? await loadClients() : { clients, config: { schemaVersion: 1, clients: [] }, raw: null, valid: true };
    const registry = registration.clients;
    const connected = registry.filter(client => client.selected);
    if (!registration.valid) diagnostics.push({ code: 'CLIENTS_FORMAT', message: registration.message });
    async function scanSkills(base, client = null) {
      try {
        await safePath(client ? client.root : root, base);
        const entries = await fs.readdir(base, { withFileTypes: true }).catch(failure => { if (failure.code === 'ENOENT') return []; throw failure; });
        if (entries.length > 5000) diagnostics.push({ code: 'SCAN_LIMIT', reason: 'directories', limit: 5000, skippedBranches: entries.length - 5000, path: client ? base : 'skills/' + entries[5000]?.name, message: 'Skills 目录超过 5000 项，剩余目录未读取。' });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 5000)) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || !entry.isDirectory() && !entry.isSymbolicLink()) continue;
          const sourcePath = path.join(base, entry.name), real = await fs.realpath(sourcePath).catch(() => null);
          if (client && entry.isSymbolicLink()) { pendingLinks.push({ client, sourcePath, real, name: entry.name }); continue; }
          const id = client ? skillId([client.id, sourcePath]) : skillId(entry.name);
          const readable = real && within(base, real) && !entry.isSymbolicLink();
          if (!readable) {
            signatures.push([sourcePath, real, (await stat(sourcePath))?.mtimeMs]);
            diagnostics.push({ id, clientId: client?.id, code: 'EXTERNAL_SOURCE', message: '外部或失效 Skill 链接未读取：' + sourcePath, path: sourcePath });
            continue;
          }
          if (!(await stat(path.join(sourcePath, 'SKILL.md')))) continue;
          const common = { id, kind: 'skill', scope: client ? 'client' : 'shared', ...(client ? { clientId: client.id } : {}), relativePath: entry.name, sourcePath };
          try {
            await safePath(base, path.join(sourcePath, 'SKILL.md'));
            const content = await readText(path.join(sourcePath, 'SKILL.md')), meta = metadata(content);
            signatures.push([sourcePath, hash(content)]);
            skills.push({ ...common, ...meta, valid: true, revision: hash(content) });
          } catch (failure) {
            signatures.push([sourcePath, (await stat(path.join(sourcePath, 'SKILL.md')))?.mtimeMs]);
            skills.push({ ...common, name: entry.name, description: '', dependencies: null, valid: false, problem: failure.message });
            diagnostics.push({ id, code: failure.code || 'SKILL_FORMAT', message: failure.message });
          }
        }
      } catch (failure) { diagnostics.push({ clientId: client?.id, code: failure.code || 'SOURCE_UNREADABLE', message: failure.message, path: base }); }
    }
    await scanSkills(path.join(root, 'skills'));
    for (const client of connected) await scanSkills(client.skillsRoot, client);
    for (const { client, sourcePath, real, name } of pendingLinks) {
      if (real && skills.some(skill => skill.sourcePath === real)) continue;
      const id = skillId([client.id, sourcePath]);
      signatures.push([sourcePath, real, (await stat(sourcePath))?.mtimeMs]);
      diagnostics.push({ id, clientId: client.id, code: 'EXTERNAL_SOURCE', message: '外部或失效 Skill 链接未读取：' + sourcePath, path: sourcePath });
      skills.push({ id, kind: 'skill', scope: 'client', clientId: client.id, relativePath: name, sourcePath, linked: true, readOnly: true, name, description: '外部或失效链接；可移除链接，保留其源文件', dependencies: null, valid: false });
    }
    let servers = [], mcpValid = true, mcpRaw = null, manifest = { schemaVersion: 1, bindings: [] };
    try {
      const file = path.join(root, 'mcp', 'servers.json'); await safePath(root, file);
      mcpRaw = await readText(file, 2_000_000);
      servers = normalizeServers(mcpRaw === null ? { schemaVersion: 1, servers: [] } : JSON.parse(mcpRaw));
    } catch { mcpValid = false; diagnostics.push({ code: 'MCP_FORMAT', message: 'MCP 主配置无效；请修复 servers.json，原文件不会被覆盖' }); }
    try { await safePath(root, path.join(root, 'daylight', 'bindings.json')); manifest = await readJSON(path.join(root, 'daylight', 'bindings.json'), manifest); if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.bindings)) throw error('接入记录格式错误'); }
    catch { diagnostics.push({ code: 'BINDINGS_FORMAT', message: '接入记录格式错误，接入写入已暂停' }); manifest = null; }
    const clientDocuments = await Promise.all(connected.map(readClientMcp));
    for (const document of clientDocuments) { signatures.push(['mcp', document.clientId, document.raw, document.valid]); if (!document.valid) diagnostics.push({ clientId: document.clientId, code: 'CLIENT_MCP_FORMAT', message: document.message }); }
    const clientStates = await Promise.all(registry.map(async client => ({ id: client.id, name: client.name, command: client.command, root: client.root, skillsDirectory: client.skillsDirectory, custom: client.custom, registrationId: client.registrationId, discovered: !!client.discovered, selected: client.selected, adapter: client.adapter, mcpPath: client.mcpPath, mcpToggle: !!client.mcp?.toggle, mcpValid: clientDocuments.find(document => document.clientId === client.id)?.valid ?? null, mcpFormat: client.format || 'none', skillMode: client.skillMode, mcpMode: client.mcpMode, note: client.note, refresh: client.refresh, skillsRoot: client.skillsRoot, ...await client.detect() })));
    for (const skill of skills) {
      skill.bindings = [];
      for (const client of connected) {
        const target = path.join(client.skillsRoot, path.basename(skill.relativePath)), info = await stat(target);
        let link = null, matches = false;
        if (info?.isSymbolicLink()) { link = await fs.readlink(target); matches = await fs.realpath(target).catch(() => null) === skill.sourcePath; }
        const owned = manifest?.bindings.some(binding => binding.skillId === skill.id && [client.id, ...(client.aliases || [])].includes(binding.clientId) && binding.target === target && binding.source === skill.sourcePath && binding.linkTarget === link);
        const state = skill.scope === 'client' && skill.clientId === client.id ? 'local' : info ? matches ? owned ? 'managed' : 'existing' : 'conflict' : 'not_connected';
        skill.bindings.push({ clientId: client.id, state, owned: !!owned, target, runtimeVerified: false });
        signatures.push([client.id, target, info ? [info.isSymbolicLink() ? 'link' : 'entity', link, info.ino, info.mtimeMs] : null]);
        if (state === 'conflict') diagnostics.push({ id: skill.id, clientId: client.id, code: 'BINDING_CONFLICT', message: '同名接入位置已存在其他内容，不能覆盖' });
      }
    }
    for (const skill of skills) for (const id of skill.dependencies || []) if (!servers.some(server => server.id === id && server.enabled)) diagnostics.push({ id: skill.id, code: 'DEPENDENCY_UNAVAILABLE', message: '明确依赖的 MCP 不存在或主配置禁用：' + id });
    for (const server of servers) for (const ref of Object.values(server.envRefs || server.headerRefs || {})) if (!environment[ref]) diagnostics.push({ id: server.id, code: 'ENV_MISSING', message: '检测环境缺少变量：' + ref + '（客户端环境须另外核对）' });
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
