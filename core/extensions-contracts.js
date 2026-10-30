// Shared with JavaScriptCore. Keep this module free of filesystem and SDK imports.
export const extensionActions = ['skill.create', 'skill.update', 'skill.archive', 'skill.disable', 'skill.enable', 'skill.import', 'skill.resolveConflict', 'mcp.importJson', 'mcp.save', 'mcp.archive', 'mcp.generate', 'mcp.probe', 'mcp.install', 'mcp.toggle', 'mcp.restoreBackup', 'binding.connect', 'binding.adopt', 'binding.disconnect', 'client.save', 'client.remove', 'client.select', 'operation.restore'];
// Swift JSONSerialization and JS may order keys differently. Identity is semantic.
export function canonicalJSON(value, space) {
  const sorted = input => Array.isArray(input) ? input.map(sorted) : input && typeof input === 'object' ? Object.fromEntries(Object.keys(input).sort().map(key => [key, sorted(input[key])])) : input;
  return JSON.stringify(sorted(value), null, space);
}
export function extensionMethod(route, method) {
  if (['/state', '/diagnostics', '/compare', '/backups'].includes(route)) return method === 'GET';
  if (['/refresh', '/prepare', '/actions', '/probes', '/mcp-compare', '/reveal'].includes(route)) return method === 'POST';
  if (/^\/(objects|operations)\/[a-zA-Z0-9_-]{1,100}$/.test(route)) return method === 'GET';
  if (/^\/probes\/[a-zA-Z0-9_-]{1,100}$/.test(route)) return ['GET', 'DELETE'].includes(method);
  return false;
}
// The one list of `extensions.*` capability keys that the web UI also reads from the /state & /refresh mirror (`capabilities.extensions`,
// value `true`). Every key here must exist in `extensionsCapability` below (the /api/v1/capabilities source); service.mjs derives the mirror from this
// list and a test fails if a listed key is missing from either side. Add a key here, not in service.mjs. Optional keys: the web client hides a
// feature only on a literal `false`; a missing key means "unknown, keep working".
export const extensionsMirrorKeys = Object.freeze(['skillConflict', 'mcpConflictCompare', 'restoreBackup']);
// Mirrored only where the feature is available: `reveal` needs the standalone Node server on a system that can open Finder (darwin; `reveal.supported`).
// /api/v1/capabilities adds it in server.mjs under the same condition, so it is not part of the static `extensionsCapability`.
export const extensionsConditionalMirrorKeys = Object.freeze(['reveal']);
export const extensionsCapability = {
  source: '~/.agents', skills: '~/.agents/skills', mcp: '~/.agents/mcp/servers.json',
  reads: 'GET /api/v1/extensions/state', prepare: 'POST /api/v1/extensions/prepare',
  writes: 'POST /api/v1/extensions/actions {requestId, expectedVersion, planId, action}',
  recovery: 'GET /api/v1/extensions/operations/:requestId', conflictCompare: 'GET /api/v1/extensions/compare?id=&clientId=', skillConflict: true, restoreBackup: 'GET /api/v1/extensions/backups?kind=mcpConfig, then action mcp.restoreBackup {operationId}', mcpConflictCompare: 'POST /api/v1/extensions/mcp-compare {scope, clientId?, json|server, expectedVersion?}', operations: extensionActions,
  clients: ['codex', 'qoder', 'pi', 'grok', 'claude'], discovery: 'Known CLI candidates; only user-selected clients are scanned and managed', clientMcp: 'User-level native configuration via verified adapters', clientRegistration: '~/.agents/daylight/clients.json', approval: 'AI proposals require user review; queries never start MCP',
};
