import path from 'node:path';
import os from 'node:os';
import { access, realpath, stat as fileInfo } from 'node:fs/promises';
import { constants } from 'node:fs';
import { clientAdapters, adapterFor } from './client-adapters.mjs';
import { executableCandidates } from '../core/local-executables.mjs';
import { error, readText, readJSON, safePath, stat, within } from './files.mjs';

export const clientsFile = root => path.join(root, 'daylight', 'clients.json');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
export function normalizeClient(input, home = os.homedir()) {
  const fields = ['id', 'name', 'command', 'root', 'skillsDirectory', 'mcpFormat', 'adapter'];
  if (!plain(input) || Object.keys(input).some(key => !fields.includes(key)) || typeof input.id !== 'string' || !/^client_[a-zA-Z0-9_-]{1,64}$/.test(input.id) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw error('CLI 登记需要有效 ID 和软件名称');
  if (typeof input.command !== 'string' || !(path.isAbsolute(input.command) || /^[a-zA-Z0-9_.+-]{1,100}$/.test(input.command)) || /[\r\n\0]/.test(input.command) || input.command.length > 2000) throw error('CLI 命令请填写可执行文件路径或单个命令名，不含参数');
  if (typeof input.root !== 'string' || input.root.length > 2000 || /[\r\n\0]/.test(input.root) || !(path.isAbsolute(input.root) || input.root.startsWith('~/'))) throw error('软件主目录请填写绝对路径或 ~/ 开头的路径');
  const root = path.resolve(input.root.startsWith('~/') ? path.join(home, input.root.slice(2)) : input.root);
  if (root === path.parse(root).root || root === home) throw error('请填写软件自己的目录，不能使用整个主目录或文件系统根目录');
  const directory = input.skillsDirectory ?? 'skills';
  if (typeof directory !== 'string' || !directory || directory.length > 2000 || path.isAbsolute(directory) || /[\r\n\0\\]/.test(directory) || directory.split('/').some(part => !part || ['.', '..'].includes(part))) throw error('Skills 相对目录不能为空或跨出软件主目录');
  const mcpFormat = input.mcpFormat ?? 'none';
  if (!['none', 'toml', 'json'].includes(mcpFormat)) throw error('MCP 配置格式无效');
  if (input.adapter !== undefined && input.adapter !== 'auto' && input.adapter !== 'manual' && !clientAdapters.some(adapter => adapter.id === input.adapter)) throw error('CLI 适配器无效');
  return { id: input.id, name: input.name.trim(), command: input.command, root, skillsDirectory: directory, mcpFormat, ...(input.adapter ? { adapter: input.adapter } : {}) };
}
export function normalizeClientConfig(input, home = os.homedir()) {
  if (!plain(input) || input.schemaVersion !== 1 || !Array.isArray(input.clients) || input.clients.length > 50 || Object.keys(input).some(key => !['schemaVersion', 'clients', 'selectedClients'].includes(key))) throw error('CLI 登记文件需要 schemaVersion: 1 和 clients 数组，最多 50 项');
  const clients = input.clients.map(client => normalizeClient(client, home));
  if (new Set(clients.map(client => client.id)).size !== clients.length) throw error('CLI 登记 ID 重复');
  const selected = input.selectedClients;
  if (selected !== undefined && (!Array.isArray(selected) || selected.length > 55 || new Set(selected).size !== selected.length || selected.some(id => typeof id !== 'string' || !clientAdapters.some(adapter => adapter.id === id) && !clients.some(client => client.id === id)))) throw error('CLI 接入选择需要不重复的已知软件或登记 ID');
  const config = { schemaVersion: 1, clients, ...(selected ? { selectedClients: selected } : {}) };
  if (Buffer.byteLength(JSON.stringify(config, null, 2)) + 1 > 262144) throw error('CLI 登记文件超过 256 KB，请减少项目或路径长度');
  return config;
}
export async function validateClientRegistry(root, config, options = {}) {
  const clients = clientRegistry({ ...options, profiles: config.clients, selectedClients: config.selectedClients ?? [...config.clients.map(client => client.id), ...(options.legacySelectedClients || [])] });
  for (const client of clients) {
    const oldRoot = client.root;
    let ancestor = client.root; const missing = [];
    while (!(await stat(ancestor))) { missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
    client.root = path.join(await realpath(ancestor), ...missing);
    client.skillsRoot = path.join(client.root, client.skillsDirectory);
    if (client.mcpPath && within(oldRoot, client.mcpPath)) client.mcpPath = path.join(client.root, path.relative(oldRoot, client.mcpPath));
    if (client.custom && within(root, client.skillsRoot)) throw error('CLI 接入目录不能位于扩展主来源中');
    if (client.selected || client.custom) {
      await safePath(client.root, client.skillsRoot);
      for (const directory of [client.root, client.skillsRoot]) { const info = await stat(directory); if (info && !info.isDirectory()) throw error('软件主目录和 Skills 位置必须是目录'); }
    }
  }
  for (const registered of clients.filter(client => client.custom)) {
    const detected = clients.find(client => !client.custom && client.definition?.id === registered.definition?.id && client.skillsRoot === registered.skillsRoot);
    if (detected) { detected.registrationId = registered.id; detected.aliases = [registered.id]; detected.selected ||= registered.selected; clients.splice(clients.indexOf(registered), 1); }
  }
  if (new Set(clients.map(client => client.skillsRoot)).size !== clients.length || new Set(clients.map(client => client.name.toLowerCase())).size !== clients.length) throw error('软件名称或 Skills 接入目录与已登记软件重复');
  return (await Promise.all(clients.map(async client => {
    if (!client.discovered) return client;
    const detection = await client.detect();
    return client.selected || client.registrationId || detection.installed || await stat(client.root) || client.mcpPath && await stat(client.mcpPath) ? client : null;
  }))).filter(Boolean);
}
export async function readClientRegistry(root, options = {}) {
  let raw = null;
  try {
    raw = await readText(await safePath(root, clientsFile(root)), 262144);
    const config = normalizeClientConfig(raw === null ? { schemaVersion: 1, clients: [] } : JSON.parse(raw), options.home);
    // Existing managed records are evidence of a prior user choice, unlike
    // arbitrary CLI folders or pre-existing links. Explicit selections win.
    let legacySelectedClients = [];
    if (!Object.hasOwn(config, 'selectedClients')) {
      try { const file = await safePath(root, path.join(root, 'daylight', 'bindings.json')); const manifest = await readJSON(file, null); if (manifest?.schemaVersion === 1 && Array.isArray(manifest.bindings)) legacySelectedClients = manifest.bindings.map(binding => binding.clientId); } catch {}
    }
    const clients = await validateClientRegistry(root, config, { ...options, legacySelectedClients });
    return { clients, config, raw, valid: true };
  } catch (failure) {
    return { clients: clientRegistry(options), config: null, raw, valid: false, message: 'CLI 登记配置无效，原文件已保留：' + failure.message };
  }
}

// Registered clients and discovered clients use the same definitions and path policy.
export function clientRegistry({ clientRoots = {}, environment = process.env, home = os.homedir(), profiles = [], selectedClients = [] } = {}) {
  const configured = profiles.map(profile => ({ ...profile, custom: true, definition: profile.adapter === 'manual' ? null : adapterFor(profile.command, profile.adapter === 'auto' ? undefined : profile.adapter) }));
  const defaults = clientAdapters.filter(adapter => !Object.keys(clientRoots).length || ['codex', 'qoder', 'pi'].includes(adapter.id) || clientRoots[adapter.id]).map(definition => ({
    id: definition.id, name: definition.name, command: definition.commands[0], definition,
    root: clientRoots[definition.id] || (environment[definition.rootEnv]?.trim() ? path.resolve(environment[definition.rootEnv]) : path.join(home, definition.directory)),
    skillsDirectory: definition.id === 'pi' && !clientRoots.pi && environment.PI_CODING_AGENT_DIR?.trim() ? 'skills' : definition.skillsDirectory,
    discovered: !['codex', 'qoder', 'pi'].includes(definition.id),
  }));
  return [...defaults, ...configured].map(client => {
    const mcp = client.definition?.mcp;
    // Claude's user MCP file sits beside its default config directory.
    const mcpPath = mcp ? client.definition.id === 'claude' && client.root !== path.join(home, '.claude') ? path.join(client.root, '.claude.json') : path.resolve(client.root, mcp.file) : null;
    const format = mcp?.format || (client.mcpFormat === 'none' ? null : client.mcpFormat);
    return { skillMode: 'symlink', skillsDirectory: 'skills', custom: false, ...client,
      selected: selectedClients.includes(client.id), adapter: client.definition?.id || 'manual', mcp, mcpPath, format,
      mcpMode: mcp ? 'native' : format ? 'manual' : 'unsupported',
      note: '主目录 ' + (client.definition && client.root === path.join(home, client.definition.directory) ? '~/' + client.definition.directory : client.root) + '；Skills 按单项链接到 ' + client.skillsDirectory + '。' + (mcp ? '可管理用户级 MCP 配置。' : format ? '尚无已核实的 MCP 适配器，仅生成配置片段。' : '该 CLI 未接入 MCP。'),
      refresh: '在该 CLI 中刷新或新建会话后读取变更；项目、插件或兼容来源可能覆盖用户配置。',
      skillsRoot: path.join(client.root, client.skillsDirectory),
      async detect() {
        const commands = path.isAbsolute(client.command) ? [client.command] : [...new Set([client.command, ...(client.definition?.commands || [])])];
        for (const command of commands) for (const executable of executableCandidates(command, { environment, home, custom: path.isAbsolute(command) ? command : '' })) {
          try { await access(executable, constants.X_OK); if (!(await fileInfo(executable)).isFile()) continue; return { installed: true, executable, version: '未执行版本检测', runtimeVerified: false }; } catch {}
        }
        return { installed: false, executable: null, version: null, runtimeVerified: false };
      },
    };
  });
}
