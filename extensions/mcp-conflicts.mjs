import { fieldError } from './files.mjs';
import { REDACTED_LINE } from './conflicts.mjs';

// 0.7 PR-12: same-ID MCP conflicts (mcp.importJson / mcp.save create). Compare output is built from normalized
// servers (references only, never values) and is additionally redacted before it leaves the service.
export const MCP_RESOLUTIONS = ['adoptNew', 'keepExisting'];
export const MCP_RESOLUTION_LIMIT = 100;
const sensitive = value => /(?:token|password|secret|api[-_]?key|authorization)\s*[=:]|^--?(?:token|password|secret|api[-_]?key)$/i.test(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

export function parseResolution(value, field) {
  if (value !== undefined && !MCP_RESOLUTIONS.includes(value)) throw fieldError('冲突处理方式不正确。请在下方选择处理方式。', field);
  return value;
}
// `resolutions` maps a server ID to its choice. Unknown IDs are rejected so a typo cannot silently overwrite nothing.
export function parseResolutions(value, ids) {
  if (value === undefined) return {};
  if (!plain(value) || Object.keys(value).length > MCP_RESOLUTION_LIMIT) throw fieldError('冲突处理的选择格式不对：需要为每个同 ID 的服务各选一个处理方式，最多 ' + MCP_RESOLUTION_LIMIT + ' 项。请在下方选择处理方式。', 'resolutions');
  const result = {};
  for (const [id, choice] of Object.entries(value)) {
    if (!ids.includes(id)) throw fieldError('「' + id.slice(0, 60) + '」不在导入内容中，无法为它选择处理方式。', 'resolutions.' + id.slice(0, 60));
    result[id] = parseResolution(choice, 'resolutions.' + id.slice(0, 60));
  }
  return result;
}
const hide = value => typeof value === 'string' && sensitive(value) ? REDACTED_LINE : value;
// Public view of a server: transport, command/args/url and reference names only. refStatus says whether a variable is set, never its value.
export function serverView(server, refStatus = []) {
  let url = server.url;
  if (typeof url === 'string') { try { const parsed = new URL(url); if (parsed.username || parsed.password || [...parsed.searchParams.keys()].some(key => /token|key|secret|password|auth/i.test(key))) url = '（已隐藏）'; } catch { url = '（已隐藏）'; } }
  return {
    id: server.id, name: server.name, transport: server.transport, enabled: server.enabled !== false,
    ...(server.command !== undefined ? { command: hide(server.command) } : {}), ...(server.args ? { args: server.args.map(hide) } : {}),
    ...(server.cwd ? { cwd: server.cwd } : {}), ...(url !== undefined ? { url } : {}),
    refs: refStatus.map(({ kind, key, ref, set, internal }) => ({ kind, key, ref, set, internal })),
    ...(server.secretKeys?.length ? { secretKeys: server.secretKeys.slice(0, 40) } : {}),
  };
}
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export function differences(existing, incoming) {
  const fields = [];
  for (const field of ['name', 'transport', 'enabled', 'command', 'args', 'cwd', 'url']) if (!same(existing[field], incoming[field])) fields.push({ field, existing: existing[field] ?? null, incoming: incoming[field] ?? null });
  const key = ref => ref.kind + ':' + ref.key, left = new Map(existing.refs.map(ref => [key(ref), ref])), right = new Map(incoming.refs.map(ref => [key(ref), ref]));
  const refs = [];
  for (const name of [...new Set([...left.keys(), ...right.keys()])]) {
    const a = left.get(name), b = right.get(name), ref = a || b;
    const status = !a ? 'added' : !b ? 'removed' : a.ref === b.ref ? 'same' : 'changed';
    if (status !== 'same') refs.push({ kind: ref.kind, key: ref.key, status, existingRef: a?.ref ?? null, incomingRef: b?.ref ?? null });
  }
  return { fields, refs, identical: !fields.length && !refs.length };
}
