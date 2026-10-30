import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createExtensionsService } from '../extensions/service.mjs';
import { extensionMethod, extensionsCapability, extensionActions } from '../core/extensions-contracts.js';
import { resolveRoute } from '../core/contracts.js';
import { nativeReveal, revealFromEnvironment } from '../extensions/reveal.mjs';

// api-contract §H: reveal in Finder and restore from backup. The fake value below must never appear in any response.
const REF_VALUE = 'ref-value-must-not-leak-9191';
async function fixture(t, { supported = true, failRun = false } = {}) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'daylight-reveal-restore-')));
  const agentsRoot = path.join(temp, 'agents'), clientRoots = Object.fromEntries(['codex', 'qoder', 'pi'].map(id => [id, path.join(temp, id)]));
  await fs.mkdir(path.join(agentsRoot, 'daylight'), { recursive: true });
  await fs.writeFile(path.join(agentsRoot, 'daylight/clients.json'), JSON.stringify({ schemaVersion: 1, clients: [], selectedClients: ['codex', 'qoder', 'pi'] }));
  const revealed = [];
  const reveal = { supported, run: async file => { revealed.push(file); if (failRun) throw new Error('open failed at ' + file); } };
  const service = await createExtensionsService({ agentsRoot, clientRoots, environment: { PATH: '', MY_TOKEN: REF_VALUE }, cacheMs: 0, reveal });
  const server = http.createServer((req, res) => { void service.handle(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.close(); await service.close(); await fs.rm(temp, { recursive: true, force: true }); });
  const call = async (route, input) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/extensions' + route, input === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    const text = await response.text(); return { status: response.status, text, value: JSON.parse(text) };
  };
  const commit = (p, requestId = randomUUID()) => service.apply({ requestId, expectedVersion: p.expectedVersion, planId: p.planId, action: p.normalizedAction });
  const apply = async (action, requestId) => commit(await service.prepare(action), requestId);
  const serversFile = path.join(agentsRoot, 'mcp/servers.json');
  return { temp, agentsRoot, clientRoots, serversFile, revealed, service, call, apply, commit, state: () => service.state(true) };
}
const shared = (id, extra = {}) => ({ id, name: id, transport: 'stdio', command: 'node', args: ['one.mjs'], ...extra });
const save = (f, id, extra) => f.apply({ type: 'mcp.save', create: true, server: shared(id, extra) });
const failure = (status, extra = {}) => e => e.status === status && Object.entries(extra).every(([key, value]) => e[key] === value);
const SKILL = '---\nname: demo-skill\ndescription: Demo skill for reveal tests\n---\nBody\n';

test('routes, action list and capabilities: reveal is web-only, restoreBackup is advertised', () => {
  assert.equal(extensionMethod('/reveal', 'POST'), true); assert.equal(extensionMethod('/reveal', 'GET'), false);
  assert.equal(extensionMethod('/backups', 'GET'), true); assert.equal(extensionMethod('/backups', 'POST'), false);
  assert.ok(extensionActions.includes('mcp.restoreBackup')); assert.match(extensionsCapability.restoreBackup, /backups/);
  assert.equal(resolveRoute('/api/extensions/reveal', 'POST').handler, 'ai');
  assert.equal(resolveRoute('/api/v1/extensions/reveal', 'POST').handler, 'missing', 'agents cannot open Finder windows');
  assert.equal(resolveRoute('/api/v1/extensions/backups', 'GET').handler, 'ai');
});

test('state advertises restoreBackup always and reveal only when supported', async t => {
  const on = await fixture(t), off = await fixture(t, { supported: false });
  assert.deepEqual((await on.call('/state')).value.capabilities, { extensions: { skillConflict: true, mcpConflictCompare: true, restoreBackup: true, reveal: true } });
  assert.deepEqual((await off.call('/state')).value.capabilities, { extensions: { skillConflict: true, mcpConflictCompare: true, restoreBackup: true } });
  assert.deepEqual((await off.call('/refresh', {})).value.capabilities, { extensions: { skillConflict: true, mcpConflictCompare: true, restoreBackup: true } });
});

test('reveal: unsupported environments answer 501 and never run anything', async t => {
  const f = await fixture(t, { supported: false });
  const response = await f.call('/reveal', { kind: 'mcpConfig' });
  assert.equal(response.status, 501); assert.equal(response.value.code, 'EXTENSIONS_UNSUPPORTED'); assert.deepEqual(f.revealed, []);
});

test('reveal: the server resolves skill, mcpConfig and client locations itself', async t => {
  const f = await fixture(t); await save(f, 'alpha');
  assert.equal((await f.call('/reveal', { kind: 'mcpConfig' })).status, 200);
  assert.deepEqual(f.revealed, [f.serversFile]);
  await f.apply({ type: 'skill.create', directory: 'demo-skill', content: SKILL });
  const skill = (await f.state()).skills.find(item => item.name === 'demo-skill');
  const ok = await f.call('/reveal', { kind: 'skill', id: skill.id });
  assert.deepEqual(ok.value, { ok: true }); assert.equal(f.revealed.at(-1), skill.sourcePath);
  // client without an MCP file falls back to its Skills directory; with one, the MCP file is revealed
  const client = (await f.state()).clients.find(item => item.id === 'qoder');
  assert.ok(client.selected && client.skillsRoot && client.mcpPath);
  await fs.mkdir(client.skillsRoot, { recursive: true });
  assert.equal((await f.call('/reveal', { kind: 'client', clientId: 'qoder' })).status, 200); assert.equal(f.revealed.at(-1), client.skillsRoot);
  await fs.writeFile(client.mcpPath, '{}');
  assert.equal((await f.call('/reveal', { kind: 'client', clientId: 'qoder' })).status, 200); assert.equal(f.revealed.at(-1), client.mcpPath);
});

test('reveal skill: shared, client-scope and connected Skills resolve to their own listed source; removed ones are 404', async t => {
  const f = await fixture(t);
  await f.apply({ type: 'skill.create', directory: 'demo-skill', content: SKILL });
  const state = await f.state(), shared = state.skills.find(item => item.name === 'demo-skill'), client = state.clients.find(item => item.id === 'codex');
  // a Skill that exists only inside a client's Skills directory
  const own = path.join(client.skillsRoot, 'client-only'); await fs.mkdir(own, { recursive: true });
  await fs.writeFile(path.join(own, 'SKILL.md'), '---\nname: client-only\ndescription: Lives in the client directory only\n---\nBody\n');
  // a connected Skill: the client directory holds a link to the shared one
  const connected = await f.apply({ type: 'binding.connect', id: shared.id, clientId: 'codex' }).catch(error => error);
  const after = await f.state(), clientOnly = after.skills.find(item => item.name === 'client-only');
  assert.ok(clientOnly, 'client-only Skill is listed');
  assert.ok(!(connected instanceof Error), String(connected?.message));
  assert.ok(after.skills.find(item => item.id === shared.id).bindings.some(item => item.clientId === 'codex' && item.state === 'managed'), 'connected: the client directory now holds a link');
  assert.equal((await f.call('/reveal', { kind: 'skill', id: clientOnly.id })).status, 200); assert.equal(f.revealed.at(-1), clientOnly.sourcePath); assert.ok(clientOnly.sourcePath.startsWith(client.skillsRoot));
  // a connected Skill still reveals its own source, never the link inside the client directory
  assert.equal((await f.call('/reveal', { kind: 'skill', id: shared.id })).status, 200); assert.equal(f.revealed.at(-1), shared.sourcePath); assert.ok(!f.revealed.at(-1).startsWith(client.skillsRoot));
  const before = f.revealed.length;
  await fs.rm(own, { recursive: true, force: true });
  const gone = await f.call('/reveal', { kind: 'skill', id: clientOnly.id }); assert.equal(gone.status, 404); assert.equal(gone.value.code, 'EXTENSIONS_OBJECT_MISSING'); assert.equal(f.revealed.length, before);
});

test('reveal client: MCP file first, then the Skills directory; unregistered, unselected or file-less clients never reveal', async t => {
  const f = await fixture(t);
  const client = (await f.state()).clients.find(item => item.id === 'pi');
  assert.ok(client.skillsRoot);
  // neither the MCP file nor the Skills directory exists yet
  const none = await f.call('/reveal', { kind: 'client', clientId: 'pi' }); assert.equal(none.status, 404); assert.equal(none.value.code, 'EXTENSIONS_OBJECT_MISSING');
  await fs.mkdir(client.skillsRoot, { recursive: true });
  assert.equal((await f.call('/reveal', { kind: 'client', clientId: 'pi' })).status, 200); assert.equal(f.revealed.at(-1), client.skillsRoot);
  // a path-looking or unknown clientId is only ever looked up by id, never used as a path
  for (const clientId of ['../../etc', '/etc', 'nobody', 'grok']) { const response = await f.call('/reveal', { kind: 'client', clientId }); assert.ok(response.status >= 400 && response.status < 500, clientId + ' → ' + response.status); }
  assert.deepEqual(f.revealed, [client.skillsRoot]);
  assert.doesNotMatch((await f.call('/reveal', { kind: 'client', clientId: 'nobody' })).text, /etc|passwd/);
});

test('reveal rejects raw paths, unknown kinds and unexpected fields; missing objects are 404', async t => {
  const f = await fixture(t);
  for (const body of [{ kind: 'mcpConfig', path: '/etc/passwd' }, { path: '/etc/passwd' }, { kind: 'file', path: '/etc' }, { kind: 'skill', id: 'x', path: '/etc' }, { kind: 'skill' }, { kind: 'client' }, { kind: 'mcpConfig', id: 'x' }, [], 'x']) {
    const response = await f.call('/reveal', body); assert.equal(response.status, 400, JSON.stringify(body)); assert.equal(response.value.code, 'EXTENSIONS_INVALID');
  }
  assert.equal((await f.call('/reveal', { kind: 'skill', id: 'skill_missing' })).status, 404);
  assert.equal((await f.call('/reveal', { kind: 'mcpConfig' })).value.code, 'EXTENSIONS_OBJECT_MISSING', 'no servers.json yet');
  assert.equal((await f.call('/reveal', { kind: 'client', clientId: 'nobody' })).status >= 400, true);
  assert.deepEqual(f.revealed, []);
});

test('reveal failure answers 500 without echoing the path', async t => {
  const f = await fixture(t, { failRun: true }); await save(f, 'alpha');
  const response = await f.call('/reveal', { kind: 'mcpConfig' });
  assert.equal(response.status, 500); assert.equal(response.value.code, 'EXTENSIONS_REVEAL_FAILED'); assert.equal(response.text.includes(f.temp), false);
});

test('backups list newest recovery points as metadata only, skipping the current content', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.call('/backups?kind=mcpConfig')).value.backups, []);
  const first = (await save(f, 'alpha', { envRefs: { TOKEN: 'MY_TOKEN' } })).operationId, second = (await save(f, 'beta')).operationId;
  const response = await f.call('/backups?kind=mcpConfig');
  assert.equal(response.status, 200); assert.equal(response.value.kind, 'mcpConfig');
  assert.deepEqual(response.value.backups.map(item => [item.operationId, item.servers]), [[first, 1]], 'newest content (beta) is the current file, so only the earlier state is a recovery point');
  assert.match(response.value.backups[0].summary, /alpha/); assert.ok(Date.parse(response.value.backups[0].at));
  assert.deepEqual(Object.keys(response.value.backups[0]).sort(), ['at', 'operationId', 'servers', 'summary']);
  for (const text of [response.text, JSON.stringify(response.value)]) { assert.equal(text.includes('one.mjs'), false); assert.equal(text.includes(REF_VALUE), false); assert.equal(text.includes('MY_TOKEN'), false); }
  assert.equal((await f.call('/backups?kind=skills')).status, 400); assert.equal((await f.call('/backups')).value.field, 'kind');
  assert.ok(second);
});

test('restoreBackup repairs a damaged servers.json through prepare→apply and is undoable', async t => {
  const f = await fixture(t);
  const first = (await save(f, 'alpha', { envRefs: { TOKEN: 'MY_TOKEN' } })).operationId; await save(f, 'beta');
  const damaged = '{ "schemaVersion": 1, "servers": [ ';
  await fs.writeFile(f.serversFile, damaged);
  assert.equal((await f.state()).mcpValid, false);
  const plan = await f.service.prepare({ type: 'mcp.restoreBackup', operationId: first });
  assert.equal(plan.conflicts.length, 0); assert.equal(plan.files.length, 1); assert.equal(plan.files[0].path, f.serversFile);
  assert.match(plan.impact.join(' '), /恢复为.*1 个服务/); assert.match(plan.impact.join(' '), /operation\.restore/);
  assert.equal(JSON.stringify(plan).includes(REF_VALUE), false);
  const applied = await f.commit(plan);
  assert.equal(applied.status, 'applied'); assert.equal(JSON.stringify(applied).includes(REF_VALUE), false);
  const state = await f.state(); assert.equal(state.mcpValid, true); assert.deepEqual(state.servers.filter(server => server.scope === 'shared').map(server => server.id), ['alpha']);
  assert.notEqual(await fs.readFile(f.serversFile, 'utf8'), damaged);
  // the restore itself is undoable: the damaged bytes come back exactly
  await f.apply({ type: 'operation.restore', operationId: applied.operationId });
  assert.equal(await fs.readFile(f.serversFile, 'utf8'), damaged);
});

test('restoreBackup on a healthy file reports removed services and warns about generated client configs', async t => {
  const f = await fixture(t);
  const first = (await save(f, 'alpha')).operationId; await save(f, 'beta');
  const plan = await f.service.prepare({ type: 'mcp.restoreBackup', operationId: first });
  assert.deepEqual(plan.changedIds, ['beta']); assert.match(plan.warnings.join(' '), /beta/); assert.match(plan.warnings.join(' '), /不会自动更新/);
  await f.commit(plan);
  assert.deepEqual((await f.state()).servers.map(server => server.id), ['alpha']);
  const same = await f.service.prepare({ type: 'mcp.restoreBackup', operationId: first });
  assert.equal(same.files.length, 0); assert.match(same.warnings.join(' '), /已与该恢复点相同/);
});

test('restoreBackup validates the operation, the snapshot and the plan version', async t => {
  const f = await fixture(t); const first = (await save(f, 'alpha')).operationId; await save(f, 'beta');
  const prepare = action => f.service.prepare({ type: 'mcp.restoreBackup', ...action });
  await assert.rejects(prepare({}), failure(400, { field: 'operationId' }));
  await assert.rejects(prepare({ operationId: '../etc' }), failure(400, { field: 'operationId' }));
  await assert.rejects(prepare({ operationId: 'nonexistent-operation' }), failure(400, { field: 'operationId' }));
  await assert.rejects(f.service.prepare({ type: 'mcp.restoreBackup', operationId: first, path: '/tmp/x' }), failure(400));
  const skillOp = (await f.apply({ type: 'skill.create', directory: 'demo-skill', content: SKILL })).operationId;
  await assert.rejects(prepare({ operationId: skillOp }), failure(400, { field: 'operationId' }), 'an operation that never touched servers.json is not a recovery point');
  // records that look applied but hold unusable snapshots, or never completed, are refused and never listed
  const operations = path.join(f.agentsRoot, 'daylight/operations'), step = after => ({ path: f.serversFile, before: { kind: 'missing' }, after, completed: true });
  const fake = (name, status, after) => fs.writeFile(path.join(operations, name + '.json'), JSON.stringify({ requestId: name, status, action: { type: 'mcp.save' }, createdAt: new Date().toISOString(), steps: [step(after)] }));
  const bad = { kind: 'file', data: Buffer.from('{ not json').toString('base64'), mode: 0o600 }, good = { kind: 'file', data: Buffer.from(JSON.stringify({ schemaVersion: 1, servers: [] })).toString('base64'), mode: 0o600 };
  await fake('fake-invalid-snapshot', 'applied', bad); await fake('fake-rolled-back', 'rolled_back', good);
  await assert.rejects(prepare({ operationId: 'fake-invalid-snapshot' }), failure(400, { field: 'operationId' }));
  await assert.rejects(prepare({ operationId: 'fake-rolled-back' }), failure(400, { field: 'operationId' }));
  const ids = (await f.call('/backups?kind=mcpConfig')).value.backups.map(item => item.operationId); assert.deepEqual(ids, [first]);
  const plan = await prepare({ operationId: first });
  await save(f, 'gamma');
  await assert.rejects(f.commit(plan), failure(409, { code: 'EXTENSIONS_VERSION_CONFLICT' }), 'stale plan after another write');
  const http = await f.call('/actions', { requestId: randomUUID(), expectedVersion: 'stale', planId: plan.planId, action: plan.normalizedAction });
  assert.equal(http.status, 409);
});

// Through the real server: /api/v1/capabilities carries extensions.restoreBackup always and extensions.reveal only where supported.
async function served(t, supported) {
  const { createTaskWorkbench, closeWorkbench } = await import('../fixtures/workbench.mjs');
  const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'daylight-reveal-http-'))), revealed = [];
  const extensionsOptions = { agentsRoot: path.join(directory, 'agents'), clientRoots: Object.fromEntries(['codex', 'qoder', 'pi'].map(id => [id, path.join(directory, id)])), environment: { PATH: '' }, reveal: { supported, run: async file => { revealed.push(file); } } };
  const server = await createTaskWorkbench(directory, { extensionsOptions }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await closeWorkbench(server); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (route, input, auth = 'web') => {
    const token = (await (await fetch(base + '/api/state')).json()).token, agent = (await fs.readFile(path.join(directory, 'agent-token'), 'utf8')).trim();
    const response = await fetch(base + route, { method: input === undefined ? 'GET' : 'POST', headers: { ...(auth === 'web' ? { 'X-Workbench-Token': token, Origin: base } : { Authorization: 'Bearer ' + agent }), ...(input === undefined ? {} : { 'content-type': 'application/json' }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, value: await response.json() };
  };
  return { api, revealed, extensionsOptions };
}

test('/api/v1/capabilities: extensions.restoreBackup always, extensions.reveal only where Finder can be opened; agents cannot reveal', async t => {
  const on = await served(t, true), off = await served(t, false);
  const capsOn = (await on.api('/api/v1/capabilities', undefined, 'agent')).value.extensions, capsOff = (await off.api('/api/v1/capabilities', undefined, 'agent')).value.extensions;
  assert.match(capsOn.restoreBackup, /mcp\.restoreBackup/); assert.match(capsOff.restoreBackup, /mcp\.restoreBackup/);
  assert.match(capsOn.reveal, /POST \/api\/extensions\/reveal/); assert.equal('reveal' in capsOff, false);
  assert.equal(typeof capsOn.mcpConflictCompare, 'string', 'same namespace as mcpConflictCompare');
  // the web mirror has the same nesting and the same keys as the /api/v1 source (reveal only where supported), and every mirrored value is true
  for (const [side, source] of [[on, capsOn], [off, capsOff]]) {
    const mirror = (await side.api('/api/extensions/state')).value.capabilities;
    assert.deepEqual(Object.keys(mirror), ['extensions']);
    const shared = ['skillConflict', 'mcpConflictCompare', 'restoreBackup', 'reveal'].filter(key => key in source);
    assert.deepEqual(Object.keys(mirror.extensions).sort(), shared.sort()); assert.ok(Object.values(mirror.extensions).every(value => value === true));
  }
  await fs.mkdir(path.join(on.extensionsOptions.agentsRoot, 'mcp'), { recursive: true }); await fs.writeFile(path.join(on.extensionsOptions.agentsRoot, 'mcp/servers.json'), '{"schemaVersion":1,"servers":[]}');
  assert.equal((await on.api('/api/v1/extensions/reveal', { kind: 'mcpConfig' }, 'agent')).status, 404);
  assert.deepEqual(on.revealed, []);
  assert.deepEqual((await on.api('/api/extensions/reveal', { kind: 'mcpConfig' })).value, { ok: true }); assert.equal(on.revealed.length, 1);
  assert.equal((await off.api('/api/extensions/reveal', { kind: 'mcpConfig' })).status, 501);
});

test('reveal (native shell): the helper answers with the resolved path for the shell; nothing is opened and no path comes from the caller', async t => {
  assert.equal(revealFromEnvironment({}), undefined); assert.equal(revealFromEnvironment({ DAYLIGHT_REVEAL: 'open' }), undefined);
  const native = revealFromEnvironment({ DAYLIGHT_REVEAL: 'native' });
  assert.equal(native.supported, true); assert.deepEqual(await native.run('/x/y'), { hostReveal: '/x/y' });
  const temp = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'daylight-reveal-native-')));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const agentsRoot = path.join(temp, 'agents'); await fs.mkdir(agentsRoot, { recursive: true });
  const service = await createExtensionsService({ agentsRoot, clientRoots: { codex: path.join(temp, 'codex') }, environment: { PATH: '' }, cacheMs: 0, reveal: nativeReveal() });
  t.after(() => service.close());
  const server = http.createServer((req, res) => { void service.handle(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const post = async input => { const r = await fetch('http://127.0.0.1:' + server.address().port + '/api/extensions/reveal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); return { status: r.status, value: await r.json() }; };
  const created = await service.prepare({ type: 'skill.create', directory: 'native-skill', content: SKILL });
  await service.apply({ requestId: randomUUID(), expectedVersion: created.expectedVersion, planId: created.planId, action: created.normalizedAction });
  const skill = (await service.state(true)).skills.find(item => item.name === 'demo-skill');
  const ok = await post({ kind: 'skill', id: skill.id });
  assert.equal(ok.status, 200); assert.deepEqual(ok.value, { ok: true, hostReveal: skill.sourcePath });
  // a raw path is still never accepted, and an unknown object never yields a path
  assert.equal((await post({ kind: 'skill', id: skill.id, path: '/etc' })).status, 400);
  const missing = await post({ kind: 'skill', id: 'skill-missing' }); assert.equal(missing.status, 404); assert.equal(JSON.stringify(missing.value).includes('hostReveal'), false);
});

test('reveal (native shell): the AI helper wires the environment switch and the shell strips the field', async () => {
  const sidecar = await fs.readFile(new URL('../ai/sidecar.mjs', import.meta.url), 'utf8');
  assert.match(sidecar, /reveal: revealFromEnvironment\(process\.env\)/);
  // a standalone server never hands paths out: it does not use nativeReveal
  const standalone = await fs.readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(standalone, /nativeReveal|revealFromEnvironment|hostReveal/);
});
