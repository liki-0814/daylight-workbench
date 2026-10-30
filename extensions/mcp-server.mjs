import path from 'node:path';
import { error, fieldError } from './files.mjs';

const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const idPattern = /^[a-zA-Z0-9_-]{1,80}$/;
export const privateEnvironmentNames = ['DAYLIGHT_AI_TOKEN', 'DAYLIGHT_QODER_TOKEN', 'DAYLIGHT_TOOL_TOKEN'];
function refs(value = {}, field) {
  if (!plain(value) || Object.keys(value).length > 40 || Object.entries(value).some(([key, ref]) => !/^[a-zA-Z_][a-zA-Z0-9_-]{0,100}$/.test(key) || typeof ref !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,100}$/.test(ref))) throw fieldError('凭据只能填写环境变量引用名称', field);
  if (Object.entries(value).some(([key, ref]) => privateEnvironmentNames.includes(key) || privateEnvironmentNames.includes(ref))) throw fieldError('公共 MCP 不能引用 Daylight 内部凭据', field);
  return value;
}
const loopback = hostname => ['localhost', '127.0.0.1', '[::1]'].includes(hostname) || hostname.endsWith('.localhost');
// Non-blocking advisories for a normalized server. Plain http:// to a non-loopback host sends any header
// (including referenced credentials) unencrypted; it stays allowed but must be surfaced.
export function serverWarnings(server) {
  const warnings = [];
  if (server?.transport === 'http' && typeof server.url === 'string') {
    let url = null; try { url = new URL(server.url); } catch {}
    if (url?.protocol === 'http:' && !loopback(url.hostname)) warnings.push({ code: 'INSECURE_HTTP', field: 'server.url', message: Object.keys(server.headerRefs || {}).length ? '该地址使用明文 http://，所引用的请求头（可能含凭据）会未加密传输；建议改用 https://。' : '该地址使用明文 http://，通信内容未加密；建议改用 https://。' });
  }
  return warnings;
}
export function normalizeServer(input, { nativeKey = false } = {}) {
  const fields = ['id', 'name', 'transport', 'enabled', 'command', 'args', 'cwd', 'url', 'envRefs', 'headerRefs'];
  if (!plain(input)) throw fieldError('MCP 服务字段无效', 'server');
  if (Object.keys(input).some(key => !fields.includes(key))) throw fieldError('MCP 服务字段无效：包含不支持的字段（' + Object.keys(input).filter(key => !fields.includes(key)).slice(0, 5).join('、').slice(0, 100) + '）', 'server');
  if (typeof input.id !== 'string' || (nativeKey ? !input.id || input.id.length > 200 || /[\r\n\0]/.test(input.id) : !idPattern.test(input.id))) throw fieldError(nativeKey ? 'ID 需为 1–200 个字符且不含换行' : 'ID 只能包含字母、数字、下划线和短横线，长度 1–80', 'server.id');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200) throw fieldError('名称不能为空，且不超过 200 个字符', 'server.name');
  if (!['stdio', 'http'].includes(input.transport)) throw fieldError('连接方式需为 stdio 或 http', 'server.transport');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw fieldError('启用状态需为布尔值', 'server.enabled');
  const server = { id: input.id, name: input.name.trim(), transport: input.transport, enabled: input.enabled !== false };
  if (!nativeKey && (input.id.startsWith('skill_') || input.id.startsWith('client_') || ['codex', 'qoder', 'pi'].includes(input.id))) throw fieldError('MCP ID 与保留对象名称冲突', 'server.id');
  if (input.transport === 'stdio') {
    if (typeof input.command !== 'string' || !input.command || input.command.length > 2000 || /[\r\n\0]/.test(input.command)) throw fieldError('stdio 需要有效的可执行命令，不接受 shell 脚本', 'server.command');
    const args = input.args ?? [];
    if (!Array.isArray(args) || args.length > 100 || args.some(arg => typeof arg !== 'string' || arg.length > 2000 || /[\r\n\0]/.test(arg) || /(?:token|password|secret|api[-_]?key)\s*[=:]|^--?(?:token|password|secret|api[-_]?key)$/i.test(arg))) throw fieldError('参数无效；凭据请使用环境变量引用', 'server.args');
    if (input.cwd !== undefined && (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd) || /[\r\n\0]/.test(input.cwd))) throw fieldError('工作目录需要绝对路径', 'server.cwd');
    if (input.url || input.headerRefs && Object.keys(input.headerRefs).length) throw fieldError('stdio 不使用 URL 或 HTTP 请求头', input.url ? 'server.url' : 'server.headerRefs');
    Object.assign(server, { command: input.command, args, ...(input.cwd ? { cwd: input.cwd } : {}), envRefs: refs(input.envRefs, 'server.envRefs') });
  } else {
    let url; try { url = new URL(input.url); } catch { throw fieldError('HTTP 服务需要合法 URL', 'server.url'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => /token|key|secret|password|auth/i.test(key))) throw fieldError('URL 不能包含凭据；请通过请求头环境变量引用', 'server.url');
    if (input.command || input.args?.length || input.cwd || input.envRefs && Object.keys(input.envRefs).length) throw fieldError('HTTP 服务不使用命令或 stdio 环境变量', input.command ? 'server.command' : 'server.envRefs');
    Object.assign(server, { url: url.href, headerRefs: refs(input.headerRefs, 'server.headerRefs') });
  }
  return server;
}
export function normalizeServers(input) {
  if (!plain(input) || input.schemaVersion !== 1 || !Array.isArray(input.servers) || input.servers.length > 500 || Object.keys(input).some(key => !['schemaVersion', 'servers'].includes(key))) throw error('MCP 主配置需要 schemaVersion: 1 和 servers 数组');
  const servers = input.servers.map(normalizeServer);
  if (new Set(servers.map(server => server.id)).size !== servers.length) throw error('MCP ID 重复');
  return servers;
}
