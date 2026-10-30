import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createExtensionsService } from '../extensions/service.mjs';
import { serverWarnings } from '../extensions/mcp-server.mjs';

const skillText = (name = 'example') => '---\nname: ' + name + '\ndescription: demo\n---\nbody\n';
const stdio = (id, extra = {}) => ({ id, name: id, transport: 'stdio', command: 'node', args: [], ...extra });
async function fixture(t) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'daylight-ext-safety-')));
  const agentsRoot = path.join(temp, 'agents'), clientRoots = Object.fromEntries(['codex', 'qoder', 'pi'].map(id => [id, path.join(temp, id)]));
  await fs.mkdir(path.join(agentsRoot, 'daylight'), { recursive: true });
  await fs.writeFile(path.join(agentsRoot, 'daylight/clients.json'), JSON.stringify({ schemaVersion: 1, clients: [], selectedClients: ['codex', 'qoder', 'pi'] }));
  const service = await createExtensionsService({ agentsRoot, clientRoots, environment: { PATH: '' }, cacheMs: 0 });
  const server = http.createServer((req, res) => { void service.handle(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.close(); await service.close(); await fs.rm(temp, { recursive: true, force: true }); });
  const call = async (route, input, method = input ? 'POST' : 'GET') => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/extensions' + route, { method, ...(input ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) } : {}) });
    return { status: response.status, value: await response.json() };
  };
  const apply = async (action, requestId = randomUUID()) => { const plan = await service.prepare(action); return service.apply({ requestId, expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction }); };
  return { temp, agentsRoot, clientRoots, service, call, apply };
}

test('E-01: mcp.save with create refuses an existing ID (409) while edits without create still replace it', async t => {
  const f = await fixture(t);
  await f.apply({ type: 'mcp.save', create: true, server: stdio('dup', { name: 'original' }) });
  await assert.rejects(f.service.prepare({ type: 'mcp.save', create: true, server: stdio('dup', { name: 'overwrite' }) }), failure => failure.status === 409 && failure.code === 'EXTENSIONS_DUPLICATE_ID' && failure.field === 'server.id');
  const http409 = await f.call('/prepare', { action: { type: 'mcp.save', create: true, server: stdio('dup', { name: 'overwrite' }) } });
  assert.equal(http409.status, 409); assert.equal(http409.value.code, 'EXTENSIONS_DUPLICATE_ID'); assert.equal(http409.value.field, 'server.id');
  assert.equal((await f.service.state(true)).servers.find(server => server.id === 'dup').name, 'original');
  // Regression: editing the same ID (no create flag) is still a plain replace.
  await f.apply({ type: 'mcp.save', server: stdio('dup', { name: 'edited' }) });
  assert.equal((await f.service.state(true)).servers.find(server => server.id === 'dup').name, 'edited');
  // A brand-new ID with create succeeds and create must be a boolean.
  await f.apply({ type: 'mcp.save', create: true, server: stdio('fresh') });
  await assert.rejects(f.service.prepare({ type: 'mcp.save', create: 'yes', server: stdio('fresh2') }), failure => failure.field === 'create');
});

test('E-01: create also refuses an existing ID inside a client-local MCP configuration', async t => {
  const f = await fixture(t);
  await f.apply({ type: 'mcp.save', clientId: 'codex', create: true, server: stdio('local') });
  await assert.rejects(f.service.prepare({ type: 'mcp.save', clientId: 'codex', create: true, server: stdio('local', { name: 'other' }) }), failure => failure.status === 409 && failure.code === 'EXTENSIONS_DUPLICATE_ID');
  await f.apply({ type: 'mcp.save', clientId: 'codex', server: stdio('local', { name: 'edited' }) });
});

test('E-16: validation errors name the failing field, over HTTP too', async t => {
  const f = await fixture(t);
  const cases = [
    [stdio('bad id!'), 'server.id'], [stdio('ok', { name: '  ' }), 'server.name'], [{ ...stdio('ok'), transport: 'ws' }, 'server.transport'],
    [stdio('ok', { command: '' }), 'server.command'], [stdio('ok', { args: ['--token=abc'] }), 'server.args'], [stdio('ok', { cwd: 'relative' }), 'server.cwd'],
    [stdio('ok', { envRefs: { A: 'has space' } }), 'server.envRefs'], [{ id: 'h', name: 'h', transport: 'http', url: 'not a url' }, 'server.url'],
    [{ id: 'h', name: 'h', transport: 'http', url: 'https://x.test/?token=1' }, 'server.url'], [{ id: 'h', name: 'h', transport: 'http', url: 'https://x.test', headerRefs: { A: 'bad ref' } }, 'server.headerRefs'],
    [stdio('skill_reserved'), 'server.id'], [{ ...stdio('ok'), plaintext: 'x' }, 'server'],
  ];
  for (const [server, field] of cases) {
    const response = await f.call('/prepare', { action: { type: 'mcp.save', server } });
    assert.equal(response.status, 400, field); assert.equal(response.value.field, field, JSON.stringify(server)); assert.ok(response.value.error);
  }
  const bad = await f.call('/prepare', { action: { type: 'skill.create', directory: 'Bad Name', content: skillText() } });
  assert.equal(bad.status, 400); assert.equal(bad.value.field, 'directory');
  const frontmatter = await f.call('/prepare', { action: { type: 'skill.create', directory: 'fine', content: 'no frontmatter' } });
  assert.equal(frontmatter.status, 400); assert.equal(frontmatter.value.field, 'content');
});

test('E-17: plain http:// is allowed but reported as a warning on plans and state; https and loopback are not', async t => {
  const f = await fixture(t);
  const insecure = { id: 'remote', name: 'remote', transport: 'http', url: 'http://mcp.example.test/mcp', headerRefs: { Authorization: 'MCP_AUTH' } };
  const plan = await f.call('/prepare', { action: { type: 'mcp.save', create: true, server: insecure } });
  assert.equal(plan.status, 200); assert.equal(plan.value.warnings.length, 1); assert.equal(plan.value.warnings[0].code, 'INSECURE_HTTP'); assert.equal(plan.value.warnings[0].field, 'server.url'); assert.match(plan.value.warnings[0].message, /请求头/);
  await f.apply({ type: 'mcp.save', create: true, server: insecure });
  assert.deepEqual((await f.service.state(true)).servers.find(server => server.id === 'remote').warnings.map(item => item.code), ['INSECURE_HTTP']);
  assert.deepEqual((await f.call('/prepare', { action: { type: 'mcp.save', create: true, server: { ...insecure, id: 'secure', url: 'https://mcp.example.test/mcp' } } })).value.warnings, []);
  assert.deepEqual(serverWarnings({ transport: 'http', url: 'http://127.0.0.1:3000/mcp', headerRefs: {} }), []);
  assert.deepEqual(serverWarnings({ transport: 'http', url: 'http://localhost/mcp', headerRefs: {} }), []);
  assert.deepEqual(serverWarnings({ transport: 'stdio', command: 'node' }), []);
  // warnings never leak into the normalized action / stored config
  assert.equal(JSON.parse(await fs.readFile(path.join(f.agentsRoot, 'mcp/servers.json'), 'utf8')).servers[0].warnings, undefined);
});

test('E-07: a missing object returns a message for its own kind and reports the kind', async t => {
  const f = await fixture(t);
  const skill = await f.call('/objects/skill_' + 'a'.repeat(24)); assert.equal(skill.status, 404); assert.match(skill.value.error, /^Skill/); assert.equal(skill.value.kind, 'skill'); assert.equal(skill.value.code, 'EXTENSIONS_OBJECT_MISSING');
  const mcp = await f.call('/objects/gone-server?kind=mcp'); assert.equal(mcp.status, 404); assert.match(mcp.value.error, /^MCP/); assert.doesNotMatch(mcp.value.error, /Skill/); assert.equal(mcp.value.kind, 'mcp');
  const unknown = await f.call('/objects/gone-server'); assert.equal(unknown.status, 404); assert.doesNotMatch(unknown.value.error, /Skill/);
  const ignoredKind = await f.call('/objects/gone-server?kind=bogus'); assert.doesNotMatch(ignoredKind.value.error, /Skill|MCP 服务/);
});

test('E-08/E-25: diagnostics are tagged per tab; a corrupt servers.json reports file and position without echoing content', async t => {
  const f = await fixture(t);
  await f.apply({ type: 'skill.create', directory: 'broken', content: skillText('broken') });
  await fs.writeFile(path.join(f.agentsRoot, 'skills/broken/SKILL.md'), 'not frontmatter');
  await fs.mkdir(path.join(f.agentsRoot, 'mcp'), { recursive: true });
  await fs.writeFile(path.join(f.agentsRoot, 'mcp/servers.json'), '{\n "schemaVersion": 1,\n "servers": [ SECRET_VALUE_xyz ]\n}');
  const state = await f.service.state(true); assert.equal(state.mcpValid, false);
  const mcp = state.diagnostics.find(item => item.code === 'MCP_FORMAT');
  assert.equal(mcp.tab, 'mcp'); assert.equal(mcp.path, path.join(f.agentsRoot, 'mcp/servers.json')); assert.equal(mcp.line, 3); assert.ok(mcp.column > 0);
  assert.doesNotMatch(JSON.stringify(state.diagnostics), /SECRET_VALUE_xyz/);
  assert.equal(state.diagnostics.find(item => item.id === state.skills[0].id).tab, 'skills');
  assert.ok(state.diagnostics.every(item => ['skills', 'mcp', 'clients'].includes(item.tab)));
  const route = await f.call('/diagnostics'); assert.ok(route.value.diagnostics.every(item => item.tab));
  // management writes stay paused and the corrupt file is untouched
  await assert.rejects(f.service.prepare({ type: 'mcp.save', create: true, server: stdio('x') }), failure => failure.status === 409);
  assert.match(await fs.readFile(path.join(f.agentsRoot, 'mcp/servers.json'), 'utf8'), /SECRET_VALUE_xyz/);
  // a schema (not syntax) problem carries its own safe reason
  await fs.writeFile(path.join(f.agentsRoot, 'mcp/servers.json'), JSON.stringify({ schemaVersion: 1, servers: [stdio('a'), stdio('a')] }));
  assert.match((await f.service.state(true)).diagnostics.find(item => item.code === 'MCP_FORMAT').reason, /重复/);
});
