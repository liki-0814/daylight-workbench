// Shared with JavaScriptCore. Keep this module free of filesystem and SDK imports.
export const extensionActions = ['skill.create', 'skill.update', 'skill.archive', 'mcp.save', 'mcp.archive', 'mcp.generate', 'mcp.probe', 'binding.connect', 'binding.adopt', 'binding.disconnect', 'client.save', 'client.remove', 'operation.restore'];
// Swift JSONSerialization and JS may order keys differently. Identity is semantic.
export function canonicalJSON(value, space) {
  const sorted = input => Array.isArray(input) ? input.map(sorted) : input && typeof input === 'object' ? Object.fromEntries(Object.keys(input).sort().map(key => [key, sorted(input[key])])) : input;
  return JSON.stringify(sorted(value), null, space);
}
export function extensionMethod(route, method) {
  if (['/state', '/diagnostics'].includes(route)) return method === 'GET';
  if (['/refresh', '/prepare', '/actions', '/probes'].includes(route)) return method === 'POST';
  if (/^\/(objects|operations)\/[a-zA-Z0-9_-]{1,100}$/.test(route)) return method === 'GET';
  if (/^\/probes\/[a-zA-Z0-9_-]{1,100}$/.test(route)) return ['GET', 'DELETE'].includes(method);
  return false;
}
export const extensionsCapability = {
  source: '~/.agents', skills: '~/.agents/skills', mcp: '~/.agents/mcp/servers.json',
  reads: 'GET /api/v1/extensions/state', prepare: 'POST /api/v1/extensions/prepare',
  writes: 'POST /api/v1/extensions/actions {requestId, expectedVersion, planId, action}',
  recovery: 'GET /api/v1/extensions/operations/:requestId', operations: extensionActions,
  clients: ['codex', 'qoder', 'pi'], clientRegistration: '~/.agents/daylight/clients.json', approval: 'AI proposals require user review; queries never start MCP',
};
