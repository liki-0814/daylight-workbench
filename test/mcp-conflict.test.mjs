import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createExtensionsService } from '../extensions/service.mjs';
import { extensionMethod, extensionsCapability } from '../core/extensions-contracts.js';

// PR-12: same-ID MCP conflicts. Fake secret below must never appear in any response, plan or receipt.
const LITERAL = 'sk-live-0123456789abcdefSECRET', REF_VALUE = 'ref-value-must-not-leak-4242';
async function fixture(t) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'daylight-mcp-conflict-')));
  const agentsRoot = path.join(temp, 'agents'), clientRoots = Object.fromEntries(['codex', 'qoder', 'pi'].map(id => [id, path.join(temp, id)]));
  await fs.mkdir(path.join(agentsRoot, 'daylight'), { recursive: true });
  await fs.writeFile(path.join(agentsRoot, 'daylight/clients.json'), JSON.stringify({ schemaVersion: 1, clients: [], selectedClients: ['codex', 'qoder', 'pi'] }));
  const service = await createExtensionsService({ agentsRoot, clientRoots, environment: { PATH: '', MY_TOKEN: REF_VALUE }, cacheMs: 0 });
  const server = http.createServer((req, res) => { void service.handle(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.close(); await service.close(); await fs.rm(temp, { recursive: true, force: true }); });
  const call = async (route, input) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/extensions' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const text = await response.text(); return { status: response.status, text, value: JSON.parse(text) };
  };
  const plan = action => service.prepare(action);
  const commit = (p, requestId = randomUUID()) => service.apply({ requestId, expectedVersion: p.expectedVersion, planId: p.planId, action: p.normalizedAction });
  const apply = async (action, requestId) => commit(await plan(action), requestId);
  return { temp, agentsRoot, service, call, plan, commit, apply, state: () => service.state(true), servers: async () => (await service.state(true)).servers };
}
const code = (status, extra = {}) => failure => failure.status === status && Object.entries(extra).every(([key, value]) => failure[key] === value);
const shared = (id, extra = {}) => ({ id, name: id, transport: 'stdio', command: 'node', args: ['one.mjs'], ...extra });
const mcp = servers => JSON.stringify({ mcpServers: servers });
const seed = f => f.apply({ type: 'mcp.save', create: true, server: shared('alpha', { name: 'Original', envRefs: { TOKEN: 'MY_TOKEN' }, args: ['one.mjs', '--flag'] }) });

test('capability and route: mcp-compare is a read-only POST', () => {
  assert.equal(extensionMethod('/mcp-compare', 'POST'), true); assert.equal(extensionMethod('/mcp-compare', 'GET'), false);
  assert.match(extensionsCapability.mcpConflictCompare, /mcp-compare/);
});

test('compare shows redacted differences with refs and refStatus, never values, and writes nothing', async t => {
  const f = await fixture(t); await seed(f);
  const before = await fs.readFile(path.join(f.agentsRoot, 'mcp/servers.json'), 'utf8'), version = (await f.state()).version;
  const json = mcp({ alpha: { command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: '${OTHER_VAR}', EXTRA: '${MY_TOKEN}' } }, fresh: { command: 'node' } });
  const response = await f.call('/mcp-compare', { scope: 'shared', json, expectedVersion: version });
  assert.equal(response.status, 200); assert.equal(response.value.readOnly, true); assert.equal(response.value.version, version);
  assert.deepEqual(response.value.newIds, ['fresh']); assert.deepEqual(response.value.resolutions, ['adoptNew', 'keepExisting']);
  const [item] = response.value.items; assert.equal(item.id, 'alpha'); assert.equal(item.identical, false); assert.equal(item.editable, true);
  assert.deepEqual(item.fields.map(field => field.field).sort(), ['args', 'command', 'name']);
  assert.deepEqual(item.refs.map(ref => [ref.key, ref.status, ref.existingRef, ref.incomingRef]).sort(), [['EXTRA', 'added', null, 'MY_TOKEN'], ['TOKEN', 'changed', 'MY_TOKEN', 'OTHER_VAR']]);
  assert.deepEqual(item.existing.refs, [{ kind: 'env', key: 'TOKEN', ref: 'MY_TOKEN', set: true, internal: false }]);
  assert.deepEqual(item.incoming.refs.map(ref => [ref.key, ref.set]).sort(), [['EXTRA', true], ['TOKEN', false]]);
  assert.equal(response.text.includes(LITERAL), false); assert.equal(response.text.includes(REF_VALUE), false);
  assert.equal(await fs.readFile(path.join(f.agentsRoot, 'mcp/servers.json'), 'utf8'), before); assert.equal((await f.state()).version, version);
});

test('compare validates input, reports identical content and rejects a stale version', async t => {
  const f = await fixture(t); await seed(f);
  const same = await f.call('/mcp-compare', { scope: 'shared', server: shared('alpha', { name: 'Original', envRefs: { TOKEN: 'MY_TOKEN' }, args: ['one.mjs', '--flag'] }) });
  assert.equal(same.status, 200); assert.equal(same.value.items[0].identical, true); assert.deepEqual(same.value.items[0].fields, []);
  assert.equal((await f.call('/mcp-compare', { scope: 'shared', server: shared('alpha'), expectedVersion: 'stale' })).status, 409);
  assert.equal((await f.call('/mcp-compare', { scope: 'shared' })).status, 400);
  assert.equal((await f.call('/mcp-compare', { scope: 'shared', json: '{}', server: shared('x') })).status, 400);
  assert.equal((await f.call('/mcp-compare', { scope: 'client', json: '{}' })).value.field, 'clientId');
  const plaintext = await f.call('/mcp-compare', { scope: 'shared', json: mcp({ alpha: { command: 'node', env: { TOKEN: LITERAL } } }) });
  assert.equal(plaintext.status, 400); assert.equal(plaintext.text.includes(LITERAL), false);
  const secretArg = await f.call('/mcp-compare', { scope: 'shared', json: mcp({ alpha: { command: 'node', args: ['--api-key=' + LITERAL] } }) });
  assert.equal(secretArg.status, 400); assert.equal(secretArg.text.includes(LITERAL), false);
});

test('importJson: unresolved ids still conflict; adoptNew replaces in place; keepExisting skips; undo restores', async t => {
  const f = await fixture(t); await seed(f); await f.apply({ type: 'mcp.save', create: true, server: shared('beta', { name: 'Beta' }) });
  const file = path.join(f.agentsRoot, 'mcp/servers.json'), original = await fs.readFile(file, 'utf8');
  const json = mcp({ alpha: { command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: '${OTHER_VAR}' }, disabled: true }, beta: { command: 'other' }, gamma: { command: 'node' } });
  const unresolved = await f.plan({ type: 'mcp.importJson', scope: 'shared', json, resolutions: { alpha: 'adoptNew' } });
  assert.equal(unresolved.conflicts.length, 1); assert.match(unresolved.conflicts[0], /beta/);
  await assert.rejects(f.commit(unresolved), code(409, { code: 'EXTENSIONS_CONFLICT' })); assert.equal(await fs.readFile(file, 'utf8'), original);

  const resolutions = { alpha: 'adoptNew', beta: 'keepExisting' }, version = (await f.state()).version;
  const plan = await f.plan({ type: 'mcp.importJson', scope: 'shared', json, resolutions });
  assert.deepEqual(plan.conflicts, []); assert.equal(plan.expectedVersion, version); assert.deepEqual(plan.resolved.map(item => item.resolution).sort(), ['adoptNew', 'keepExisting']);
  assert.deepEqual(plan.changedIds.sort(), ['alpha', 'gamma']); assert.ok(plan.impact.some(line => /替换现有 MCP「alpha」/.test(line))); assert.ok(plan.impact.some(line => /保留现有配置.*beta/.test(line)));
  assert.equal(plan.files.length, 1);
  const receipt = await f.commit(plan, 'conflict-import'); assert.equal(receipt.status, 'applied');
  const servers = await f.servers(), ids = servers.map(item => item.id);
  assert.deepEqual(ids, ['alpha', 'beta', 'gamma']); // alpha keeps its position
  const alpha = servers.find(item => item.id === 'alpha'); assert.deepEqual([alpha.command, alpha.enabled, alpha.envRefs], ['npx', false, { TOKEN: 'OTHER_VAR' }]);
  assert.equal(servers.find(item => item.id === 'beta').name, 'Beta');
  // Same planId cannot be reapplied against a changed catalog.
  await assert.rejects(f.commit(plan), code(409, { code: 'EXTENSIONS_VERSION_CONFLICT' }));
  // Undo through the operation snapshot.
  await f.apply({ type: 'operation.restore', operationId: 'conflict-import' });
  assert.equal(await fs.readFile(file, 'utf8'), original.replace(/\n?$/, '\n'));
});

test('importJson: keepExisting-only import applies as an empty plan and writes nothing', async t => {
  const f = await fixture(t); await seed(f);
  const file = path.join(f.agentsRoot, 'mcp/servers.json'), original = await fs.readFile(file, 'utf8');
  const plan = await f.plan({ type: 'mcp.importJson', scope: 'shared', json: mcp({ alpha: { command: 'other' } }), resolutions: { alpha: 'keepExisting' } });
  assert.deepEqual([plan.files, plan.changedIds, plan.conflicts], [[], [], []]);
  assert.equal((await f.commit(plan)).status, 'applied'); assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('importJson: invalid resolutions are rejected with a field and without echoing content', async t => {
  const f = await fixture(t); await seed(f); const json = mcp({ alpha: { command: 'node' } });
  await assert.rejects(f.plan({ type: 'mcp.importJson', scope: 'shared', json, resolutions: { alpha: 'overwrite' } }), code(400, { field: 'resolutions.alpha' }));
  await assert.rejects(f.plan({ type: 'mcp.importJson', scope: 'shared', json, resolutions: { zzz: 'adoptNew' } }), code(400, { field: 'resolutions.zzz' }));
  await assert.rejects(f.plan({ type: 'mcp.importJson', scope: 'shared', json, resolutions: ['alpha'] }), code(400, { field: 'resolutions' }));
  await assert.rejects(f.plan({ type: 'mcp.importJson', scope: 'shared', json, resolutions: Object.fromEntries(Array.from({ length: 101 }, (_, index) => ['s' + index, 'adoptNew'])) }), code(400, { field: 'resolutions' }));
});

test('mcp.save create: duplicate still 409 without onConflict; adoptNew replaces; keepExisting is a no-op; undo works', async t => {
  const f = await fixture(t); await seed(f);
  const file = path.join(f.agentsRoot, 'mcp/servers.json'), original = await fs.readFile(file, 'utf8'), incoming = shared('alpha', { name: 'Replaced', command: 'deno', args: [] });
  await assert.rejects(f.plan({ type: 'mcp.save', create: true, server: incoming }), code(409, { code: 'EXTENSIONS_DUPLICATE_ID' }));
  await assert.rejects(f.plan({ type: 'mcp.save', create: true, server: incoming, onConflict: 'merge' }), code(400, { field: 'onConflict' }));
  await assert.rejects(f.plan({ type: 'mcp.save', server: incoming, onConflict: 'adoptNew' }), code(400, { field: 'onConflict' }));
  const keep = await f.plan({ type: 'mcp.save', create: true, server: incoming, onConflict: 'keepExisting' });
  assert.deepEqual([keep.files, keep.changedIds], [[], []]); await f.commit(keep); assert.equal(await fs.readFile(file, 'utf8'), original);
  const plan = await f.plan({ type: 'mcp.save', create: true, server: incoming, onConflict: 'adoptNew' });
  assert.deepEqual(plan.resolved, [{ id: 'alpha', resolution: 'adoptNew' }]); assert.ok(plan.warnings.some(line => /重新生成/.test(line)));
  await f.commit(plan, 'conflict-save'); assert.equal((await f.servers()).find(item => item.id === 'alpha').command, 'deno');
  await f.apply({ type: 'operation.restore', operationId: 'conflict-save' }); assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('client scope: adoptNew keeps unreadable literal credentials, refuses non-editable entries, and restores', async t => {
  const f = await fixture(t);
  await f.apply({ type: 'mcp.importJson', scope: 'client', clientId: 'codex', json: mcp({ alpha: { command: 'node', args: ['a.mjs'] }, risky: { command: 'node' } }) });
  const entry = (await f.state()).servers.find(item => item.clientId === 'codex' && item.serverKey === 'alpha'), file = entry.sourcePath;
  await fs.writeFile(file, '[mcp_servers.alpha]\ncommand = "node"\nargs = ["a.mjs"]\n[mcp_servers.alpha.env]\nLITERAL = "' + LITERAL + '"\n[mcp_servers.risky]\ncommand = "node"\nargs = ["--token=' + LITERAL + '"]\n');
  const original = await fs.readFile(file, 'utf8');
  const json = mcp({ alpha: { command: 'npx', args: ['-y', 'pkg'] }, risky: { command: 'node' } });
  const compare = await f.call('/mcp-compare', { scope: 'client', clientId: 'codex', json });
  assert.equal(compare.status, 200); assert.equal(compare.text.includes(LITERAL), false);
  const byId = Object.fromEntries(compare.value.items.map(item => [item.id, item]));
  assert.deepEqual(byId.alpha.existing.secretKeys, ['env.LITERAL']); assert.equal(byId.alpha.editable, true); assert.equal(byId.risky.editable, false);
  const blocked = await f.plan({ type: 'mcp.importJson', scope: 'client', clientId: 'codex', json, resolutions: { alpha: 'adoptNew', risky: 'adoptNew' } });
  assert.equal(blocked.conflicts.length, 1); assert.match(blocked.conflicts[0], /risky/); assert.equal(JSON.stringify(blocked).includes(LITERAL), false);
  const plan = await f.plan({ type: 'mcp.importJson', scope: 'client', clientId: 'codex', json, resolutions: { alpha: 'adoptNew', risky: 'keepExisting' } });
  assert.deepEqual(plan.conflicts, []); assert.equal(JSON.stringify(plan).includes(LITERAL), false); assert.ok(plan.impact.some(line => /凭据保持原样/.test(line)));
  const receipt = await f.commit(plan, 'conflict-client'); assert.equal(JSON.stringify(receipt).includes(LITERAL), false);
  const after = await fs.readFile(file, 'utf8'); assert.match(after, /npx/); assert.ok(after.includes(LITERAL), 'literal credential stays in the CLI file'); assert.match(after, /risky/);
  await f.apply({ type: 'operation.restore', operationId: 'conflict-client' }); assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('mcp.save on a client entry honours onConflict', async t => {
  const f = await fixture(t);
  await f.apply({ type: 'mcp.importJson', scope: 'client', clientId: 'codex', json: mcp({ alpha: { command: 'node' } }) });
  const file = (await f.state()).servers.find(item => item.clientId === 'codex').sourcePath, original = await fs.readFile(file, 'utf8'), server = { id: 'alpha', name: 'alpha', transport: 'stdio', command: 'deno', args: [] };
  await assert.rejects(f.plan({ type: 'mcp.save', clientId: 'codex', create: true, server }), code(409, { code: 'EXTENSIONS_DUPLICATE_ID' }));
  const keep = await f.plan({ type: 'mcp.save', clientId: 'codex', create: true, server, onConflict: 'keepExisting' }); assert.deepEqual(keep.files, []); await f.commit(keep);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  await f.apply({ type: 'mcp.save', clientId: 'codex', create: true, server, onConflict: 'adoptNew' }, 'client-save'); assert.match(await fs.readFile(file, 'utf8'), /deno/);
  await f.apply({ type: 'operation.restore', operationId: 'client-save' }); assert.equal(await fs.readFile(file, 'utf8'), original);
});

// User-visible copy: conflict warnings, impact lines and validation errors speak plain Chinese. The API field names and values
// (resolutions / onConflict / adoptNew / keepExisting) stay exactly as they are, but they never appear inside a message.
test('user-visible conflict copy has no API jargon and names the two choices in plain Chinese', async t => {
  const f = await fixture(t); await seed(f); const messages = [];
  const rejected = async (action) => { try { await f.plan(action); assert.fail('expected a rejection'); } catch (error) { assert.ok(error.message, 'has a message'); messages.push(error.message); } };
  const json = mcp({ alpha: { command: 'node' } }), incoming = shared('alpha', { name: 'Again' });
  messages.push(...(await f.plan({ type: 'mcp.importJson', scope: 'shared', json })).conflicts);
  await rejected({ type: 'mcp.importJson', scope: 'shared', json, resolutions: { alpha: 'overwrite' } });
  await rejected({ type: 'mcp.importJson', scope: 'shared', json, resolutions: { zzz: 'adoptNew' } });
  await rejected({ type: 'mcp.importJson', scope: 'shared', json, resolutions: ['alpha'] });
  await rejected({ type: 'mcp.save', create: true, server: incoming });
  await rejected({ type: 'mcp.save', create: true, server: incoming, onConflict: 'merge' });
  await rejected({ type: 'mcp.save', server: incoming, onConflict: 'adoptNew' });
  await f.apply({ type: 'mcp.importJson', scope: 'client', clientId: 'codex', json });
  messages.push(...(await f.plan({ type: 'mcp.importJson', scope: 'client', clientId: 'codex', json })).conflicts);
  await rejected({ type: 'mcp.save', clientId: 'codex', create: true, server: incoming });
  const keep = await f.plan({ type: 'mcp.save', create: true, server: incoming, onConflict: 'keepExisting' }), adopt = await f.plan({ type: 'mcp.save', create: true, server: incoming, onConflict: 'adoptNew' });
  messages.push(...keep.impact, ...adopt.impact, ...adopt.warnings);
  assert.ok(messages.length >= 9, 'covered ' + messages.length + ' messages');
  for (const message of messages) assert.doesNotMatch(message, /adoptNew|keepExisting|resolutions|onConflict|create:true/, message);
  const joined = messages.join('\n'); assert.match(joined, /采用新配置/); assert.match(joined, /保留现有配置/);
});
