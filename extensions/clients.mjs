import path from 'node:path';
import os from 'node:os';
import { access, realpath, stat as fileInfo } from 'node:fs/promises';
import { constants } from 'node:fs';
import { executableCandidates } from '../core/local-executables.mjs';
import { error, readText, safePath, stat, within } from './files.mjs';

export const clientsFile = root => path.join(root, 'daylight', 'clients.json');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
export function normalizeClient(input, home = os.homedir()) {
  const fields = ['id', 'name', 'command', 'root', 'skillsDirectory', 'mcpFormat'];
  if (!plain(input) || Object.keys(input).some(key => !fields.includes(key)) || typeof input.id !== 'string' || !/^client_[a-zA-Z0-9_-]{1,64}$/.test(input.id) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw error('CLI 登记需要有效 ID 和软件名称');
  if (typeof input.command !== 'string' || !(path.isAbsolute(input.command) || /^[a-zA-Z0-9_.+-]{1,100}$/.test(input.command)) || /[\r\n\0]/.test(input.command) || input.command.length > 2000) throw error('CLI 命令请填写可执行文件路径或单个命令名，不含参数');
  if (typeof input.root !== 'string' || input.root.length > 2000 || /[\r\n\0]/.test(input.root) || !(path.isAbsolute(input.root) || input.root.startsWith('~/'))) throw error('软件主目录请填写绝对路径或 ~/ 开头的路径');
  const root = path.resolve(input.root.startsWith('~/') ? path.join(home, input.root.slice(2)) : input.root);
  if (root === path.parse(root).root || root === home) throw error('请填写软件自己的目录，不能使用整个主目录或文件系统根目录');
  const directory = input.skillsDirectory ?? 'skills';
  if (typeof directory !== 'string' || !directory || directory.length > 2000 || path.isAbsolute(directory) || /[\r\n\0\\]/.test(directory) || directory.split('/').some(part => !part || ['.', '..'].includes(part))) throw error('Skills 相对目录不能为空或跨出软件主目录');
  const mcpFormat = input.mcpFormat ?? 'none';
  if (!['none', 'toml', 'json'].includes(mcpFormat)) throw error('MCP 配置格式无效');
  return { id: input.id, name: input.name.trim(), command: input.command, root, skillsDirectory: directory, mcpFormat };
}
export function normalizeClientConfig(input, home = os.homedir()) {
  if (!plain(input) || input.schemaVersion !== 1 || !Array.isArray(input.clients) || input.clients.length > 50 || Object.keys(input).some(key => !['schemaVersion', 'clients'].includes(key))) throw error('CLI 登记文件需要 schemaVersion: 1 和 clients 数组，最多 50 项');
  const clients = input.clients.map(client => normalizeClient(client, home));
  if (new Set(clients.map(client => client.id)).size !== clients.length) throw error('CLI 登记 ID 重复');
  const config = { schemaVersion: 1, clients };
  if (Buffer.byteLength(JSON.stringify(config, null, 2)) + 1 > 262144) throw error('CLI 登记文件超过 256 KB，请减少项目或路径长度');
  return config;
}
export async function validateClientRegistry(root, config, options = {}) {
  const clients = clientRegistry({ ...options, profiles: config.clients });
  for (const client of clients) {
    let ancestor = client.root; const missing = [];
    while (!(await stat(ancestor))) { missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
    client.root = path.join(await realpath(ancestor), ...missing);
    client.skillsRoot = path.join(client.root, client.skillsDirectory);
    if (client.custom && within(root, client.skillsRoot)) throw error('CLI 接入目录不能位于扩展主来源中');
    await safePath(client.root, client.skillsRoot);
    for (const directory of [client.root, client.skillsRoot]) { const info = await stat(directory); if (info && !info.isDirectory()) throw error('软件主目录和 Skills 位置必须是目录'); }
  }
  if (new Set(clients.map(client => client.skillsRoot)).size !== clients.length || new Set(clients.map(client => client.name.toLowerCase())).size !== clients.length) throw error('软件名称或 Skills 接入目录与已登记软件重复');
  return clients;
}
export async function readClientRegistry(root, options = {}) {
  let raw = null;
  try {
    raw = await readText(await safePath(root, clientsFile(root)), 262144);
    const config = normalizeClientConfig(raw === null ? { schemaVersion: 1, clients: [] } : JSON.parse(raw), options.home);
    const clients = await validateClientRegistry(root, config, options);
    return { clients, config, raw, valid: true };
  } catch (failure) {
    return { clients: clientRegistry(options), config: null, raw, valid: false, message: 'CLI 登记配置无效，原文件已保留：' + failure.message };
  }
}

// This registry is the only place defining external integration paths/capabilities.
export function clientRegistry({ clientRoots = {}, environment = process.env, home = os.homedir(), profiles = [] } = {}) {
  const codexRoot = clientRoots.codex || (environment.CODEX_HOME?.trim() ? path.resolve(environment.CODEX_HOME) : path.join(home, '.codex'));
  const piRoot = clientRoots.pi || (environment.PI_CODING_AGENT_DIR?.trim() ? path.resolve(environment.PI_CODING_AGENT_DIR) : path.join(home, '.pi'));
  const piSkillsDirectory = !clientRoots.pi && environment.PI_CODING_AGENT_DIR?.trim() ? 'skills' : 'agent/skills';
  return [
    { id: 'codex', name: 'Codex', command: 'codex', root: codexRoot, skillsDirectory: 'skills', mcpMode: 'manual', format: 'toml', note: `主目录 ${codexRoot === path.join(home, '.codex') ? '~/.codex' : codexRoot}；Skills 按单项链接到软件目录。MCP 在主目录 config.toml 中配置。`, refresh: '新建或刷新客户端会话后读取变更。' },
    { id: 'qoder', name: 'Qoder', command: 'qodercli', root: clientRoots.qoder || path.join(home, '.qoder'), skillMode: 'symlink', mcpMode: 'manual', format: 'json', note: '按 Skill 建立链接；MCP 需在客户端 settings.json 中接入生成配置。', refresh: '刷新 Skills 或新建会话后核对发现结果。' },
    { id: 'pi', name: 'Pi', command: 'pi', root: piRoot, skillsDirectory: piSkillsDirectory, mcpMode: 'unsupported', note: `主目录 ${piRoot === path.join(home, '.pi') ? '~/.pi' : piRoot}；Skills 按单项链接到 ${piSkillsDirectory}。`, refresh: '通过 /reload 或新会话读取变更。' },
    ...profiles.map(profile => ({ ...profile, custom: true, format: profile.mcpFormat === 'none' ? null : profile.mcpFormat, mcpMode: profile.mcpFormat === 'none' ? 'unsupported' : 'manual', note: '主目录 ' + profile.root + '；Skills 按单项链接到 ' + profile.skillsDirectory + '。', refresh: '在该 CLI 中刷新或新建会话后读取变更。' })),
  ].map(client => ({ skillMode: 'symlink', skillsDirectory: 'skills', custom: false, ...client, skillsRoot: path.join(client.root, client.skillsDirectory || 'skills'), async detect() {
    for (const executable of executableCandidates(client.command, { environment, home, custom: path.isAbsolute(client.command) ? client.command : '' })) {
      try { await access(executable, constants.X_OK); if (!(await fileInfo(executable)).isFile()) continue; return { installed: true, executable, version: '未执行版本检测', runtimeVerified: false }; } catch {}
    }
    return { installed: false, executable: null, version: null, runtimeVerified: false };
  } }));
}
