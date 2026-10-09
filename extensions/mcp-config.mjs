import path from 'node:path';
import { error } from './files.mjs';

const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const idPattern = /^[a-zA-Z0-9_-]{1,80}$/;
export const privateEnvironmentNames = ['DAYLIGHT_AI_TOKEN', 'DAYLIGHT_QODER_TOKEN', 'DAYLIGHT_TOOL_TOKEN'];
function refs(value = {}) {
  if (!plain(value) || Object.keys(value).length > 40 || Object.entries(value).some(([key, ref]) => !/^[a-zA-Z_][a-zA-Z0-9_-]{0,100}$/.test(key) || typeof ref !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,100}$/.test(ref))) throw error('凭据只能填写环境变量引用名称');
  if (Object.entries(value).some(([key, ref]) => privateEnvironmentNames.includes(key) || privateEnvironmentNames.includes(ref))) throw error('公共 MCP 不能引用 Daylight 内部凭据');
  return value;
}
export function normalizeServer(input) {
  const fields = ['id', 'name', 'transport', 'enabled', 'command', 'args', 'cwd', 'url', 'envRefs', 'headerRefs'];
  if (!plain(input) || Object.keys(input).some(key => !fields.includes(key)) || typeof input.id !== 'string' || !idPattern.test(input.id) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200 || !['stdio', 'http'].includes(input.transport) || input.enabled !== undefined && typeof input.enabled !== 'boolean') throw error('MCP 服务字段无效');
  const server = { id: input.id, name: input.name.trim(), transport: input.transport, enabled: input.enabled !== false };
  if (input.id.startsWith('skill_') || input.id.startsWith('client_') || ['codex', 'qoder', 'pi'].includes(input.id)) throw error('MCP ID 与保留对象名称冲突');
  if (input.transport === 'stdio') {
    if (typeof input.command !== 'string' || !input.command || input.command.length > 2000 || /[\r\n\0]/.test(input.command)) throw error('stdio 需要有效的可执行命令，不接受 shell 脚本');
    const args = input.args ?? [];
    if (!Array.isArray(args) || args.length > 100 || args.some(arg => typeof arg !== 'string' || arg.length > 2000 || /[\r\n\0]/.test(arg) || /(?:token|password|secret|api[-_]?key)\s*[=:]|^--?(?:token|password|secret|api[-_]?key)$/i.test(arg))) throw error('参数无效；凭据请使用环境变量引用');
    if (input.cwd !== undefined && (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd) || /[\r\n\0]/.test(input.cwd))) throw error('工作目录需要绝对路径');
    if (input.url || input.headerRefs && Object.keys(input.headerRefs).length) throw error('stdio 不使用 URL 或 HTTP 请求头');
    Object.assign(server, { command: input.command, args, ...(input.cwd ? { cwd: input.cwd } : {}), envRefs: refs(input.envRefs) });
  } else {
    let url; try { url = new URL(input.url); } catch { throw error('HTTP 服务需要合法 URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => /token|key|secret|password|auth/i.test(key))) throw error('URL 不能包含凭据；请通过请求头环境变量引用');
    if (input.command || input.args?.length || input.cwd || input.envRefs && Object.keys(input.envRefs).length) throw error('HTTP 服务不使用命令或 stdio 环境变量');
    Object.assign(server, { url: url.href, headerRefs: refs(input.headerRefs) });
  }
  return server;
}
export function normalizeServers(input) {
  if (!plain(input) || input.schemaVersion !== 1 || !Array.isArray(input.servers) || input.servers.length > 500 || Object.keys(input).some(key => !['schemaVersion', 'servers'].includes(key))) throw error('MCP 主配置需要 schemaVersion: 1 和 servers 数组');
  const servers = input.servers.map(normalizeServer);
  if (new Set(servers.map(server => server.id)).size !== servers.length) throw error('MCP ID 重复');
  return servers;
}
export function renderMcpConfig(client, servers) {
  if (client.mcpMode === 'unsupported') throw error('该 CLI 尚未选择支持的 MCP 配置格式');
  const enabled = servers.filter(server => server.enabled);
  if (client.format === 'toml') {
    const quote = value => JSON.stringify(value);
    return enabled.map(server => {
      const lines = ['[mcp_servers.' + quote(server.id) + ']'];
      if (server.transport === 'stdio') {
        lines.push('command = ' + quote(server.command), 'args = ' + JSON.stringify(server.args));
        if (server.cwd) lines.push('cwd = ' + quote(server.cwd));
        if (Object.entries(server.envRefs).some(([key, ref]) => key !== ref)) throw error('TOML stdio 生成配置要求环境变量名称与引用名称一致');
        if (Object.keys(server.envRefs).length) lines.push('env_vars = ' + JSON.stringify(Object.keys(server.envRefs)));
      } else {
        lines.push('url = ' + quote(server.url));
        if (Object.keys(server.headerRefs).length) lines.push('[mcp_servers.' + quote(server.id) + '.env_http_headers]', ...Object.entries(server.headerRefs).map(([key, ref]) => quote(key) + ' = ' + quote(ref)));
      }
      return lines.join('\n');
    }).join('\n\n') + '\n';
  }
  // Do not emit literal ${VAR} placeholders without verified client interpolation.
  if (enabled.some(server => Object.keys(server.envRefs || server.headerRefs || {}).length)) throw error('JSON 适配的凭据引用形式未验证；请在客户端配置环境变量，不生成明文凭据');
  return JSON.stringify({ mcpServers: Object.fromEntries(enabled.map(server => [server.id, server.transport === 'stdio' ? { command: server.command, args: server.args, ...(server.cwd ? { cwd: server.cwd } : {}) } : { type: 'http', url: server.url }])) }, null, 2) + '\n';
}
