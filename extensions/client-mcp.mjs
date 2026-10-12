import path from 'node:path';
import { error, hash, readText, safePath } from './files.mjs';
import { configDocument, patchConfig } from './config-document.mjs';
import { normalizeServer } from './mcp-server.mjs';

const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const reference = value => typeof value === 'string' && value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1];
const sensitive = value => /(?:token|password|secret|api[-_]?key|authorization)\s*[=:]|^--?(?:token|password|secret|api[-_]?key)$/i.test(value);
const refs = (values, interpolation) => Object.fromEntries(Object.entries(values || {}).flatMap(([key, value]) => interpolation && reference(value) ? [[key, reference(value)]] : []));

export async function readClientMcp(client) {
  if (!client.mcp) return { clientId: client.id, raw: null, servers: [], valid: true };
  try {
    await safePath(path.dirname(client.mcpPath), client.mcpPath);
    const raw = await readText(client.mcpPath, 2_000_000), document = configDocument(raw, client.mcp.format);
    const definitions = document.data[client.mcp.section] ?? {};
    if (!plain(definitions) || Object.keys(definitions).length > 500) throw error('MCP 服务表无效或超过 500 项');
    const servers = Object.entries(definitions).map(([key, config]) => {
      const schema = client.mcp, valid = plain(config);
      const transport = config?.command ? 'stdio' : schema.url && config?.[schema.url] ? 'http' : config?.type === 'sse' || schema.url && config?.url ? 'sse' : config?.url ? 'http' : 'unknown';
      const excluded = schema.toggle === 'excluded' ? document.data.mcp?.excluded || [] : [], allowed = schema.toggle === 'excluded' ? document.data.mcp?.allowed : null;
      const disabled = document.data[schema.disabledList] || [];
      const enabled = (schema.toggle !== 'enabled' || config?.enabled !== false) && !excluded.includes(key) && !disabled.includes(key) && (!Array.isArray(allowed) || allowed.includes(key));
      const envRefs = schema.env === 'env_vars' ? Object.fromEntries((config?.env_vars || []).filter(item => typeof item === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(item)).map(name => [name, name])) : refs(config?.env, schema.interpolation);
      const headerRefs = schema.headers === 'env_http_headers' ? Object.fromEntries(Object.entries(config?.env_http_headers || {}).filter(([, value]) => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value))) : refs(config?.headers, schema.interpolation);
      const secretKeys = Object.keys(config?.env || {}).filter(name => !envRefs[name]).map(name => 'env.' + name).concat(Object.keys({ ...config?.http_headers, ...config?.headers, ...config?.env_http_headers }).filter(name => !headerRefs[name]).map(name => 'headers.' + name));
      const args = Array.isArray(config?.args) ? config.args : [];
      const unsafeCommand = typeof config?.command === 'string' && sensitive(config.command), unsafeArgs = args.some(arg => typeof arg !== 'string' || sensitive(arg));
      let url = config?.[schema.url || 'url'] || config?.url, unsafeUrl = false;
      if (url) { try { const parsed = new URL(url); unsafeUrl = !!(parsed.username || parsed.password || [...parsed.searchParams.keys()].some(key => /token|key|secret|password|auth/i.test(key))); } catch { unsafeUrl = true; } }
      return { id: 'mcp_' + hash([client.id, key]).slice(0, 24), kind: 'mcp', scope: 'client', clientId: client.id, serverKey: key, name: key,
        sourcePath: client.mcpPath, transport, enabled, valid, editable: valid && ['stdio', 'http'].includes(transport) && !unsafeCommand && !unsafeArgs && !unsafeUrl,
        toggleSupported: !!schema.toggle, revision: hash(config), dependencies: [], secretKeys,
        command: unsafeCommand ? '（已隐藏）' : config?.command, args: unsafeArgs ? [] : args,
        ...(url ? { url: unsafeUrl ? '（已隐藏）' : url } : {}), ...(config?.cwd ? { cwd: config.cwd } : {}), envRefs, headerRefs, runtimeVerified: false,
      };
    });
    return { clientId: client.id, raw, data: document.data, servers, valid: true };
  } catch { return { clientId: client.id, raw: null, servers: [], valid: false, message: '用户级 MCP 配置无法读取或格式无效，原文件已保留：' + client.mcpPath }; }
}

export function changeClientMcp(client, document, { type, server, key, enabled }) {
  if (!client.mcp) throw error('此 CLI 尚无已核实的 MCP 配置适配器');
  if (!document.valid) throw error(document.message, 409);
  const schema = client.mcp, base = [schema.section, key || server?.id], changes = [];
  const original = document.data[schema.section]?.[base[1]];
  if (type === 'remove') changes.push([base, undefined]);
  else if (type === 'toggle') {
    if (!original) throw error('MCP 服务不存在', 404);
    if (!schema.toggle) throw error('该 CLI 的用户配置尚不支持此启停操作');
  } else {
    server = normalizeServer(server, { nativeKey: true });
    const desired = server.transport === 'stdio' ? { command: server.command, args: server.args, ...(server.cwd ? { cwd: server.cwd } : {}) } : { [schema.url || 'url']: server.url, ...(schema.format === 'json' && !schema.url ? { type: 'http' } : {}) };
    if ((Object.keys(server.envRefs || {}).length || Object.keys(server.headerRefs || {}).length) && !schema.interpolation && schema.env !== 'env_vars') throw error('JSON 适配的凭据引用形式未验证；请保留原凭据或在 CLI 中配置');
    if (schema.env === 'env_vars') {
      if (Object.entries(server.envRefs || {}).some(([name, ref]) => name !== ref)) throw error('Codex 环境变量名和引用名必须一致');
      desired.env_vars = [...(original?.env_vars || []).filter(item => typeof item !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item)), ...Object.keys(server.envRefs || {})];
    }
    else for (const [name, ref] of Object.entries(server.envRefs || {})) changes.push([[...base, 'env', name], '${' + ref + '}']);
    if (Object.keys(server.headerRefs || {}).length) for (const [name, ref] of Object.entries(server.headerRefs)) changes.push([[...base, schema.headers, name], schema.headers === 'env_http_headers' ? ref : '${' + ref + '}']);
    // Remove only old references omitted by the editor. Literal credentials stay opaque.
    const view = document.servers.find(item => item.serverKey === base[1]);
    for (const name of Object.keys(view?.envRefs || {})) if (!server.envRefs?.[name] && schema.env !== 'env_vars') changes.push([[...base, 'env', name], undefined]);
    for (const name of Object.keys(view?.headerRefs || {})) if (!server.headerRefs?.[name]) changes.push([[...base, schema.headers, name], undefined]);
    for (const name of ['command', 'args', 'cwd', 'url', 'httpUrl', 'type']) if (original?.[name] !== undefined && desired[name] === undefined) changes.push([[...base, name], undefined]);
    for (const [name, value] of Object.entries(desired)) changes.push([[...base, name], value]);
    enabled = server.enabled;
    if (!schema.toggle && !enabled) throw error('该 CLI 尚不支持保存为禁用；可以移除配置');
  }
  if (type !== 'remove' && schema.toggle) {
    if (schema.toggle === 'enabled') changes.push([[...base, 'enabled'], enabled]);
    if (schema.toggle === 'excluded') {
      const excluded = document.data.mcp?.excluded || [];
      if (!Array.isArray(excluded)) throw error('CLI MCP excluded 字段无效');
      changes.push([['mcp', 'excluded'], [...new Set([...excluded.filter(name => name !== base[1]), ...(!enabled ? [base[1]] : [])])]]);
    }
    if (schema.disabledList) changes.push([[schema.disabledList], (document.data[schema.disabledList] || []).filter(name => name !== base[1]).concat(enabled ? [] : [base[1]])]);
    if (enabled && schema.toggle === 'excluded' && Array.isArray(document.data.mcp?.allowed) && !document.data.mcp.allowed.includes(base[1])) changes.push([['mcp', 'allowed'], [...document.data.mcp.allowed, base[1]]]);
  }
  const content = patchConfig(document.raw, schema.format, changes);
  if (Buffer.byteLength(content) > 2_000_000) throw error('CLI MCP 配置超过 2 MB，请减少服务或参数');
  return content;
}
