import { error } from './files.mjs';
import { changeClientMcp } from './client-mcp.mjs';
import { configDocument } from './config-document.mjs';
import { clientAdapters } from './client-adapters.mjs';
export { normalizeServer, normalizeServers, privateEnvironmentNames } from './mcp-server.mjs';

export function renderMcpConfig(client, servers) {
  if (client.mcpMode === 'unsupported') throw error('该 CLI 尚未选择支持的 MCP 配置格式');
  // Manual exports explicitly use the labelled Codex/Qoder format. They never
  // infer a native CLI schema, and reuse the same codec as native writes.
  const target = client.mcp ? client : { ...client, mcp: clientAdapters.find(adapter => adapter.id === (client.format === 'toml' ? 'codex' : 'qoder')).mcp };
  let raw = null;
  for (const server of servers.filter(server => server.enabled)) {
    const document = { valid: true, raw, data: configDocument(raw, target.mcp.format).data, servers: [] };
    raw = changeClientMcp(target, document, { type: 'save', server, key: server.id });
  }
  return raw ?? (target.mcp.format === 'json' ? '{\n  "mcpServers": {}\n}\n' : '\n');
}
