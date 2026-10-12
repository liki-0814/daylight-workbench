import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createExtensionsService } from '../extensions/service.mjs';
import { configDocument, patchConfig } from '../extensions/config-document.mjs';

const skill = name => `---\nname: ${name}\ndescription: Local fixture\n---\n`;
async function fixture(t, extra = {}) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'daylight-local-clients-')));
  const agentsRoot = path.join(home, '.agents');
  if (extra.selectClients !== false) await write(path.join(agentsRoot, 'daylight/clients.json'), JSON.stringify({ schemaVersion: 1, clients: [], selectedClients: ['codex', 'qoder', 'pi', 'grok', 'claude'] }));
  const service = await createExtensionsService({ home, agentsRoot, environment: { PATH: path.join(home, 'bin') }, cacheMs: 0, ...extra });
  t.after(async () => { await service.close(); await fs.rm(home, { recursive: true, force: true }); });
  const apply = async action => { const plan = await service.prepare(action); return service.apply({ requestId: randomUUID(), expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction }); };
  return { home, agentsRoot, service, apply };
}
async function write(file, text) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }

test('discovery never opts clients in; selection gates reads and mutations and survives cancel, restore and restart', async t => {
  const f = await fixture(t, { selectClients: false }), file = path.join(f.home, '.grok/config.toml');
  await write(path.join(f.agentsRoot, 'skills/common/SKILL.md'), skill('common'));
  await write(path.join(f.home, '.grok/skills/personal/SKILL.md'), skill('personal'));
  await write(file, '[mcp_servers.local]\ncommand = "node"\n');
  await write(path.join(f.home, '.claude/skills/common/SKILL.md'), skill('common'));
  await write(path.join(f.home, '.claude.json'), 'invalid MCP config');
  const initial = await f.service.state(true);
  assert.equal(initial.clients.filter(client => client.selected).length, 0);
  assert.deepEqual(initial.skills.map(item => item.name), ['common']); assert.deepEqual(initial.skills[0].bindings, []); assert.deepEqual(initial.servers, []);
  assert.deepEqual(initial.diagnostics, []); assert.deepEqual((await f.service.detail('grok')).skills, []);
  const action = { type: 'client.select', clientId: 'grok', selected: true };
  await f.service.prepare(action); await assert.rejects(fs.stat(path.join(f.agentsRoot, 'daylight/clients.json')), { code: 'ENOENT' });
  await assert.rejects(f.service.prepare({ type: 'binding.connect', id: initial.skills[0].id, clientId: 'grok' }), { code: 'EXTENSIONS_CLIENT_NOT_SELECTED' });
  await assert.rejects(f.service.prepare({ type: 'skill.create', clientId: 'grok', directory: 'new', content: skill('new') }), { code: 'EXTENSIONS_CLIENT_NOT_SELECTED' });
  await assert.rejects(f.service.prepare({ type: 'mcp.save', clientId: 'grok', server: { id: 'new', name: 'new', transport: 'stdio', command: 'node' } }), { code: 'EXTENSIONS_CLIENT_NOT_SELECTED' });
  await write(path.join(f.home, '.claude.json'), 'another invalid config'); assert.equal((await f.service.state(true)).version, initial.version);
  await f.apply(action); let state = await f.service.state(true);
  assert.deepEqual(state.clients.filter(client => client.selected).map(client => client.id), ['grok']);
  assert.equal(state.skills.length, 2); assert.equal(state.servers[0].clientId, 'grok'); assert.deepEqual(state.skills[0].bindings.map(binding => binding.clientId), ['grok']);
  const shared = state.skills.find(item => item.scope === 'shared'); await f.apply({ type: 'binding.connect', id: shared.id, clientId: 'grok' });
  const original = await fs.readFile(file, 'utf8'), target = path.join(f.home, '.grok/skills/common');
  const deselected = await f.apply({ type: 'client.select', clientId: 'grok', selected: false }); state = await f.service.state(true);
  assert.equal(state.clients.filter(client => client.selected).length, 0); assert.deepEqual(state.skills[0].bindings, []); assert.deepEqual(state.servers, []);
  assert.equal(await fs.readFile(file, 'utf8'), original); assert.equal(await fs.realpath(target), shared.sourcePath);
  await f.apply({ type: 'operation.restore', operationId: deselected.operationId }); assert.equal((await f.service.state(true)).clients.find(client => client.id === 'grok').selected, true);
  const restarted = await createExtensionsService({ home: f.home, agentsRoot: f.agentsRoot, environment: { PATH: '' }, cacheMs: 0 });
  try { assert.equal((await restarted.state(true)).clients.find(client => client.id === 'grok').selected, true); } finally { await restarted.close(); }
});

test('legacy explicit registrations and managed bindings carry selection; explicit deselection wins', async t => {
  const f = await fixture(t, { selectClients: false }), file = path.join(f.agentsRoot, 'daylight/clients.json');
  const client = { id: 'client_grok', name: 'Grok', command: 'grok', root: path.join(f.home, '.grok'), skillsDirectory: 'skills', mcpFormat: 'toml' };
  await write(file, JSON.stringify({ schemaVersion: 1, clients: [client] }));
  await f.apply({ type: 'skill.create', directory: 'common', content: skill('common') });
  await f.apply({ type: 'client.select', clientId: 'codex', selected: true });
  const shared = (await f.service.state(true)).skills[0]; await f.apply({ type: 'binding.connect', id: shared.id, clientId: 'codex' });
  const config = JSON.parse(await fs.readFile(file)); delete config.selectedClients; await write(file, JSON.stringify(config));
  assert.deepEqual((await f.service.state(true)).clients.filter(client => client.selected).map(client => client.id), ['codex', 'grok']);
  await f.apply({ type: 'client.select', clientId: 'codex', selected: false });
  assert.deepEqual((await f.service.state(true)).clients.filter(client => client.selected).map(client => client.id), ['grok']);
  assert.equal(await fs.realpath(path.join(f.home, '.codex/skills/common')), shared.sourcePath);
  await f.apply({ type: 'client.remove', clientId: 'client_grok' }); assert.equal((await f.service.state(true)).clients.find(client => client.id === 'grok').selected, true);
});

test('discovery is inert, de-duplicates registered Grok and migrates records on reviewed removal', async t => {
  const f = await fixture(t), root = path.join(f.home, '.grok'), marker = path.join(f.home, 'executed');
  await write(path.join(f.home, 'bin/grok'), '#!/bin/sh\ntouch ' + marker); await fs.chmod(path.join(f.home, 'bin/grok'), 0o755);
  const profile = { id: 'client_grok', name: 'Grok', command: 'grok', root, skillsDirectory: 'skills', mcpFormat: 'json' };
  await write(path.join(f.agentsRoot, 'daylight/clients.json'), JSON.stringify({ schemaVersion: 1, clients: [profile] }));
  await write(path.join(f.agentsRoot, 'skills/common/SKILL.md'), skill('common'));
  let state = await f.service.state(true), cli = state.clients.find(client => client.id === 'grok');
  assert.equal(cli.registrationId, 'client_grok'); assert.equal(cli.mcpFormat, 'toml'); assert.equal(cli.mcpMode, 'native');
  assert.equal(state.clients.filter(client => client.adapter === 'grok').length, 1);
  await f.apply({ type: 'binding.connect', id: state.skills[0].id, clientId: 'grok' });
  const manifestPath = path.join(f.agentsRoot, 'daylight/bindings.json'), manifest = JSON.parse(await fs.readFile(manifestPath));
  manifest.bindings[0].clientId = 'client_grok'; await write(manifestPath, JSON.stringify(manifest));
  const removed = await f.apply({ type: 'client.remove', clientId: 'client_grok' });
  assert.equal(JSON.parse(await fs.readFile(manifestPath)).bindings[0].clientId, 'grok');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.agentsRoot, 'daylight/clients.json'))).clients, []);
  assert.equal(await fs.realpath(path.join(root, 'skills/common')), path.join(f.agentsRoot, 'skills/common'));
  await f.apply({ type: 'operation.restore', operationId: removed.operationId });
  assert.equal(JSON.parse(await fs.readFile(manifestPath)).bindings[0].clientId, 'client_grok');
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('one catalog and mutation flow handles native Skills, shared links and opaque external links', async t => {
  const f = await fixture(t), base = path.join(f.home, '.grok/skills');
  await write(path.join(base, 'personal/SKILL.md'), skill('personal'));
  await write(path.join(f.agentsRoot, 'skills/common/SKILL.md'), skill('common'));
  await fs.symlink(path.join(f.agentsRoot, 'skills/common'), path.join(base, 'common'));
  await fs.mkdir(path.join(f.home, '.codex/skills'), { recursive: true });
  await fs.symlink(path.join(base, 'personal'), path.join(f.home, '.codex/skills/personal'));
  const outside = path.join(f.home, 'outside'); await write(path.join(outside, 'SKILL.md'), skill('secret')); await fs.symlink(outside, path.join(base, 'external'));
  const state = await f.service.state(true); assert.equal(state.skills.length, 3);
  const personal = state.skills.find(item => item.name === 'personal'), external = state.skills.find(item => item.name === 'external');
  assert.equal(personal.bindings.find(binding => binding.clientId === 'codex').state, 'existing'); assert.equal(personal.scope, 'client'); assert.equal(personal.clientId, 'grok');
  assert.equal((await f.service.detail(personal.id)).content, skill('personal'));
  await f.apply({ type: 'skill.update', id: personal.id, content: skill('personal') + 'edit\n' });
  const archived = await f.apply({ type: 'skill.archive', id: personal.id }); await assert.rejects(fs.stat(personal.sourcePath), { code: 'ENOENT' });
  await f.apply({ type: 'operation.restore', operationId: archived.operationId }); assert.match(await fs.readFile(path.join(personal.sourcePath, 'SKILL.md'), 'utf8'), /edit/);
  assert.equal((await f.service.detail(external.id)).content, null);
  await f.apply({ type: 'skill.archive', id: external.id }); assert.equal(await fs.readFile(path.join(outside, 'SKILL.md'), 'utf8'), skill('secret'));
  await f.apply({ type: 'skill.create', clientId: 'grok', directory: 'new-local', content: skill('new-local') });
  assert.equal(await fs.readFile(path.join(base, 'new-local/SKILL.md'), 'utf8'), skill('new-local'));
});

test('native TOML edits preserve secrets, unknown settings and comments; versions, restore and same-name install are guarded', async t => {
  const f = await fixture(t), file = path.join(f.home, '.grok/config.toml');
  const original = '# preserved\nmodel = "local"\ndisabled_mcp_servers = ["local"]\n[mcp_servers.local]\ncommand = "node" # launcher\nargs = ["old.mjs"]\nenabled = false\nstartup_timeout_sec = 42\n[mcp_servers.local.env]\nTOKEN = "secret-value-must-stay-private" # token comment\nREF = "${REFERENCE}"\n[ui]\nscreen_mode = "minimal" # ui comment\n';
  await write(file, original); const state = await f.service.state(true), server = state.servers[0];
  assert.equal(server.enabled, false); assert.deepEqual(server.envRefs, { REF: 'REFERENCE' });
  assert.ok(!JSON.stringify(state).includes('secret-value'));
  const action = { type: 'mcp.save', clientId: 'grok', server: { id: 'local', name: 'local', transport: 'stdio', command: 'node', args: ['new.mjs'], enabled: true, envRefs: { REF: 'NEXT' } } };
  const plan = await f.service.prepare(action); assert.ok(!JSON.stringify(plan).includes('secret-value')); assert.equal(plan.files[0].before, undefined);
  const result = await f.apply(action), updated = await fs.readFile(file, 'utf8');
  assert.match(updated, /secret-value-must-stay-private/); assert.match(updated, /# token comment/); assert.match(updated, /# launcher/); assert.match(updated, /screen_mode = "minimal" # ui comment/);
  const data = configDocument(updated, 'toml').data; assert.equal(data.mcp_servers.local.startup_timeout_sec, 42); assert.equal(data.mcp_servers.local.env.REF, '${NEXT}'); assert.deepEqual(data.disabled_mcp_servers, []);
  await f.apply({ type: 'operation.restore', operationId: result.operationId }); assert.equal(await fs.readFile(file, 'utf8'), original);
  const stale = await f.service.prepare(action); await write(file, original + '# external edit\n');
  await assert.rejects(f.service.apply({ requestId: randomUUID(), expectedVersion: stale.expectedVersion, planId: stale.planId, action }), /变化/);
  const existing = (await f.service.state(true)).servers[0]; await f.apply({ type: 'mcp.toggle', id: existing.id, enabled: true }); assert.equal((await f.service.state(true)).servers[0].enabled, true);
  const removed = await f.apply({ type: 'mcp.archive', id: existing.id }); assert.deepEqual(configDocument(await fs.readFile(file, 'utf8'), 'toml').data.mcp_servers || {}, {});
  await f.apply({ type: 'operation.restore', operationId: removed.operationId });
  await f.apply({ type: 'mcp.save', server: { id: 'local', name: 'template', transport: 'stdio', command: 'node', args: [] } });
  assert.ok((await f.service.prepare({ type: 'mcp.install', id: 'local', clientId: 'grok' })).conflicts.length);
});

test('JSON adapters edit user MCP with one document editor; unsupported toggles are not fabricated', async t => {
  const f = await fixture(t);
  for (const [clientId, file, urlField] of [['qoder', '.qoder/settings.json', 'url'], ['claude', '.claude.json', 'url']]) {
    if (clientId === 'claude') await fs.mkdir(path.join(f.home, '.claude'));
    await write(path.join(f.home, file), '{\n// keep comment\n"model": "mine", "mcpServers": { "local": { "command":"node", "args":[], "env":{"SECRET":"opaque"}, "timeout":42 } }\n}\n');
    let server = (await f.service.state(true)).servers.find(item => item.clientId === clientId);
    assert.ok(server); assert.ok(!JSON.stringify(await f.service.detail(server.id)).includes('opaque'));
    await f.apply({ type: 'mcp.save', clientId, server: { id: 'local', name: 'local', transport: 'http', url: 'https://example.com/mcp', enabled: true, headerRefs: {} } });
    const text = await fs.readFile(path.join(f.home, file), 'utf8'), data = configDocument(text, 'json').data;
    assert.match(text, /keep comment/); assert.equal(data.model, 'mine'); assert.equal(data.mcpServers.local.timeout, 42); assert.equal(data.mcpServers.local.env.SECRET, 'opaque'); assert.equal(data.mcpServers.local[urlField], 'https://example.com/mcp'); assert.equal(data.mcpServers.local.command, undefined);
    server = (await f.service.state(true)).servers.find(item => item.clientId === clientId);
    if (clientId === 'claude') await assert.rejects(f.service.prepare({ type: 'mcp.toggle', id: server.id, enabled: false }), /不支持/);
    else { await f.apply({ type: 'mcp.toggle', id: server.id, enabled: false }); assert.equal((await f.service.state(true)).servers.find(item => item.id === server.id).enabled, false); }
    if (clientId === 'qoder') await assert.rejects(f.service.prepare({ type: 'mcp.save', clientId, server: { id: 'local', name: 'local', transport: 'http', url: 'https://example.com/mcp', headerRefs: { Authorization: 'TOKEN' } } }), /凭据引用形式未验证/);
  }
});

test('opaque Codex references remain private and unchanged; invalid native files cannot be overwritten', async t => {
  const f = await fixture(t), file = path.join(f.home, '.codex/config.toml');
  await write(file, '[mcp_servers.local]\ncommand = "node"\nenv_vars = ["VISIBLE", "opaque=secret", { name = "remote", source = "opaque" }]\nenv_http_headers = { Authorization = "opaque=secret", Public = "PUBLIC" }\n');
  const server = (await f.service.state(true)).servers.find(item => item.clientId === 'codex');
  assert.deepEqual(server.envRefs, { VISIBLE: 'VISIBLE' }); assert.deepEqual(server.headerRefs, { Public: 'PUBLIC' });
  assert.ok(!JSON.stringify(await f.service.detail(server.id)).includes('opaque'));
  await f.apply({ type: 'mcp.save', clientId: 'codex', server: { id: 'local', name: 'local', transport: 'stdio', command: 'node', args: ['changed'], envRefs: { VISIBLE: 'VISIBLE' } } });
  const data = configDocument(await fs.readFile(file, 'utf8'), 'toml').data.mcp_servers.local;
  assert.ok(data.env_vars.includes('opaque=secret')); assert.equal(data.env_http_headers.Authorization, 'opaque=secret'); assert.ok(data.env_vars.some(item => item?.source === 'opaque'));
  const invalid = '[mcp_servers.local\ncommand = "node"\n'; await write(file, invalid);
  await assert.rejects(f.service.prepare({ type: 'mcp.save', clientId: 'codex', server: { id: 'new', name: 'new', transport: 'stdio', command: 'node' } }), /格式无效/);
  assert.equal(await fs.readFile(file, 'utf8'), invalid);
});

test('config editor handles quoted keys, inline maps, multiline strings and rejects ambiguous JSON', () => {
  const original = 'note = """\n[mcp_servers.fake]\n"""\n[mcp_servers."a.b"]\nenv = { TOKEN = "opaque", REF = "${OLD}" } # inline\nargs = ["x"]\n';
  const text = patchConfig(original, 'toml', [[['mcp_servers', 'a.b', 'env', 'REF'], '${NEW}'], [['mcp_servers', 'a.b', 'enabled'], false]]);
  assert.match(text, /# inline/); assert.equal(configDocument(text, 'toml').data.mcp_servers['a.b'].env.TOKEN, 'opaque');
  assert.throws(() => configDocument('{"mcpServers":{},"mcpServers":{}}', 'json'), /格式无效/);
});

test('native server keys retain CLI naming rules without colliding with catalog IDs', async t => {
  const f = await fixture(t), file = path.join(f.home, '.grok/config.toml');
  await write(file, '[mcp_servers."a.b"]\ncommand = "node"\n[mcp_servers.codex]\ncommand = "node"\n');
  for (const key of ['a.b', 'codex']) {
    const server = (await f.service.state(true)).servers.find(item => item.serverKey === key); assert.equal(server.editable, true);
    await f.apply({ type: 'mcp.save', clientId: 'grok', server: { id: key, name: key, transport: 'stdio', command: 'node', args: ['updated'] } });
    assert.deepEqual(configDocument(await fs.readFile(file, 'utf8'), 'toml').data.mcp_servers[key].args, ['updated']);
  }
  const text = patchConfig('env = { REF = "${OLD}" }\n', 'toml', [[['env', '__proto__', 'secret'], 'opaque']]);
  assert.equal(configDocument(text, 'toml').data.env.__proto__.secret, 'opaque'); assert.equal(Object.prototype.secret, undefined);
});
