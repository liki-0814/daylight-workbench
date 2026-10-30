// Shared with JavaScriptCore. Keep this module free of filesystem and SDK imports.
export const extensionActions = ['skill.create', 'skill.update', 'skill.archive', 'skill.disable', 'skill.enable', 'skill.import', 'skill.resolveConflict', 'mcp.importJson', 'mcp.save', 'mcp.archive', 'mcp.generate', 'mcp.probe', 'mcp.install', 'mcp.toggle', 'binding.connect', 'binding.adopt', 'binding.disconnect', 'client.save', 'client.remove', 'client.select', 'operation.restore'];
// Swift JSONSerialization and JS may order keys differently. Identity is semantic.
export function canonicalJSON(value, space) {
  const sorted = input => Array.isArray(input) ? input.map(sorted) : input && typeof input === 'object' ? Object.fromEntries(Object.keys(input).sort().map(key => [key, sorted(input[key])])) : input;
  return JSON.stringify(sorted(value), null, space);
}
export function extensionMethod(route, method) {
  if (['/state', '/diagnostics', '/compare'].includes(route)) return method === 'GET';
  if (['/refresh', '/prepare', '/actions', '/probes', '/mcp-compare'].includes(route)) return method === 'POST';
  if (/^\/(objects|operations)\/[a-zA-Z0-9_-]{1,100}$/.test(route)) return method === 'GET';
  if (/^\/probes\/[a-zA-Z0-9_-]{1,100}$/.test(route)) return ['GET', 'DELETE'].includes(method);
  return false;
}
// The one list of `extensions.*` capability keys that the web UI also reads from the /state & /refresh mirror (`capabilities.extensions`,
// value `true`). Every key here must exist in `extensionsCapability` below (the /api/v1/capabilities source); service.mjs derives the mirror from this
// list and a test fails if a listed key is missing from either side. Add a key here, not in service.mjs. The web client shows a
// feature only on a literal `true`; a missing key (or anything else) means "not supported", so a backend without the capability just omits the key.
export const extensionsMirrorKeys = Object.freeze(['skillConflict', 'mcpConflictCompare']);
export const extensionsCapability = {
  source: '~/.agents', skills: '~/.agents/skills', mcp: '~/.agents/mcp/servers.json',
  reads: 'GET /api/v1/extensions/state', prepare: 'POST /api/v1/extensions/prepare',
  writes: 'POST /api/v1/extensions/actions {requestId, expectedVersion, planId, action}',
  recovery: 'GET /api/v1/extensions/operations/:requestId', conflictCompare: 'GET /api/v1/extensions/compare?id=&clientId=', skillConflict: true, mcpConflictCompare: 'POST /api/v1/extensions/mcp-compare {scope, clientId?, json|server, expectedVersion?}', operations: extensionActions,
  clients: ['codex', 'qoder', 'pi', 'grok', 'claude'], discovery: 'Known CLI candidates; only user-selected clients are scanned and managed', clientMcp: 'User-level native configuration via verified adapters', clientRegistration: '~/.agents/daylight/clients.json', approval: 'AI proposals require user review; queries never start MCP',
};
