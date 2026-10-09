import * as fs from 'node:fs/promises';
import path from 'node:path';
import { error, hash, within, stat, safePath, readText, readJSON } from './files.mjs';
import { metadata, skillId } from './skill-files.mjs';
import { normalizeServers } from './mcp-config.mjs';

export function createCatalog({ root, clients, environment = process.env, cacheMs = 1000 }) {
  let cache, scannedAt = 0, scanning, generation = 0;
  async function scan() {
    const skills = [], diagnostics = [], signatures = [], seen = new Set();
    const limits = new Map(), maxDepth = 32, maxDirectories = 5000;
    let count = 0, exhausted = false;
    function scanLimit(reason, directory, limit) {
      let issue = limits.get(reason);
      if (!issue) {
        issue = { code: 'SCAN_LIMIT', reason, limit, path: path.relative(root, directory), skippedBranches: 0, message: reason === 'depth' ? `部分目录嵌套超过 ${limit} 层，已跳过；其他来源继续扫描。` : `已扫描 ${limit} 个目录，剩余目录未读取。` };
        limits.set(reason, issue); diagnostics.push(issue);
      }
      issue.skippedBranches++;
    }
    async function visit(directory, depth) {
      if (depth > maxDepth) { scanLimit('depth', directory, maxDepth); return; }
      if (count >= maxDirectories) { scanLimit('directories', directory, maxDirectories); exhausted = true; return; }
      const info = await stat(directory); if (!info) return;
      const real = await fs.realpath(directory);
      if (!within(root, real)) { diagnostics.push({ code: 'EXTERNAL_SOURCE', message: '主目录内有指向范围外的链接，未读取', path: path.relative(root, directory) }); return; }
      if (seen.has(real)) return; seen.add(real); count++;
      let entries;
      try { entries = await fs.readdir(real, { withFileTypes: true }); } catch { diagnostics.push({ code: 'SOURCE_UNREADABLE', message: '目录不可读取', path: path.relative(root, directory) }); return; }
      const skillPath = path.join(real, 'SKILL.md'), relativePath = path.relative(path.join(root, 'skills'), real);
      if (!within(path.join(root, 'skills'), real)) return;
      if (await stat(skillPath)) {
        const id = skillId(relativePath);
        try {
          await safePath(root, skillPath);
          const content = await readText(skillPath);
          const meta = metadata(content);
          signatures.push([relativePath, hash(content)]);
          skills.push({ id, kind: 'skill', relativePath, ...meta, valid: true, revision: hash(content), fileCount: entries.filter(e => e.isFile()).length });
        } catch (failure) {
          signatures.push([relativePath, (await stat(skillPath))?.mtimeMs]);
          skills.push({ id, kind: 'skill', relativePath, name: path.basename(real), description: '', dependencies: null, valid: false, problem: failure.message });
          diagnostics.push({ id, code: failure.code || 'SKILL_FORMAT', message: failure.message });
        }
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (exhausted) break;
        if (entry.name.startsWith('.') || ['node_modules', 'archive', 'backups', 'scripts', 'assets', 'references', 'resources'].includes(entry.name)) continue;
        if (entry.isDirectory() || entry.isSymbolicLink() && (await fs.stat(path.join(real, entry.name)).catch(() => null))?.isDirectory()) await visit(path.join(real, entry.name), depth + 1);
      }
    }
    try { await safePath(root, path.join(root, 'skills')); await visit(path.join(root, 'skills'), 0); } catch (failure) { diagnostics.push({ code: failure.code || 'SOURCE_UNREADABLE', message: failure.message }); }
    let servers = [], mcpValid = true, mcpRaw = null, manifest = { schemaVersion: 1, bindings: [] };
    try {
      const file = path.join(root, 'mcp', 'servers.json'); await safePath(root, file);
      mcpRaw = await readText(file, 2_000_000);
      servers = normalizeServers(mcpRaw === null ? { schemaVersion: 1, servers: [] } : JSON.parse(mcpRaw));
    } catch { mcpValid = false; diagnostics.push({ code: 'MCP_FORMAT', message: 'MCP 主配置无效；请修复 servers.json，原文件不会被覆盖' }); }
    try { await safePath(root, path.join(root, 'daylight', 'bindings.json')); manifest = await readJSON(path.join(root, 'daylight', 'bindings.json'), manifest); if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.bindings)) throw error('接入记录格式错误'); }
    catch { diagnostics.push({ code: 'BINDINGS_FORMAT', message: '接入记录格式错误，接入写入已暂停' }); manifest = null; }
    const clientStates = await Promise.all(clients.map(async client => ({ id: client.id, name: client.name, root: client.root, skillMode: client.skillMode, mcpMode: client.mcpMode, note: client.note, refresh: client.refresh, skillsRoot: client.skillsRoot, ...await client.detect() })));
    for (const skill of skills) {
      skill.bindings = [];
      for (const client of clients) {
        const target = path.join(client.skillsRoot, path.basename(skill.relativePath)), info = await stat(target);
        let link = null, matches = false;
        if (info?.isSymbolicLink()) { link = await fs.readlink(target); matches = await fs.realpath(target).catch(() => null) === path.join(root, 'skills', skill.relativePath); }
        const owned = manifest?.bindings.some(binding => binding.skillId === skill.id && binding.clientId === client.id && binding.target === target && binding.source === path.join(root, 'skills', skill.relativePath) && binding.linkTarget === link);
        const state = info ? matches ? owned ? 'managed' : 'existing' : 'conflict' : client.skillMode === 'nativeRoot' ? 'native' : 'not_connected';
        skill.bindings.push({ clientId: client.id, state, owned: !!owned, target, runtimeVerified: false });
        signatures.push([client.id, target, info ? [info.isSymbolicLink() ? 'link' : 'entity', link, info.ino, info.mtimeMs] : null]);
        if (state === 'conflict') diagnostics.push({ id: skill.id, clientId: client.id, code: 'BINDING_CONFLICT', message: '同名接入位置已存在其他内容，不能覆盖' });
      }
    }
    for (const skill of skills) for (const id of skill.dependencies || []) if (!servers.some(server => server.id === id && server.enabled)) diagnostics.push({ id: skill.id, code: 'DEPENDENCY_UNAVAILABLE', message: '明确依赖的 MCP 不存在或主配置禁用：' + id });
    for (const server of servers) for (const ref of Object.values(server.envRefs || server.headerRefs || {})) if (!environment[ref]) diagnostics.push({ id: server.id, code: 'ENV_MISSING', message: '检测环境缺少变量：' + ref + '（客户端环境须另外核对）' });
    const version = hash([signatures.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), mcpRaw, manifest]);
    return { version, root, skills, servers: servers.map(server => ({ ...server, kind: 'mcp', revision: hash(server), dependencies: skills.filter(skill => skill.dependencies?.includes(server.id)).map(skill => ({ id: skill.id, name: skill.name })) })), clients: clientStates, diagnostics, mcpValid, bindingsValid: !!manifest, manifest };
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
