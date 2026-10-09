import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createExtensionsService } from '../extensions/service.mjs';
import { metadata } from '../extensions/skill-files.mjs';
import { createCatalog } from '../extensions/catalog.mjs';
import { clientRegistry } from '../extensions/clients.mjs';

const content = (name = 'example', body = 'first') => '---\nname: ' + name + '\ndescription: |\n  中文用途\n  second line\nmetadata:\n  unknown: kept\n---\n' + body;
async function fixture(t, options = {}) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'daylight-extensions-')));
  const agentsRoot = path.join(temp, 'agents'), clientRoots = Object.fromEntries(['codex', 'qoder', 'pi'].map(id => [id, path.join(temp, id)]));
  const service = await createExtensionsService({ agentsRoot, clientRoots, environment: { PATH: '' }, cacheMs: 0, ...options });
  t.after(async () => { await service.close(); await fs.rm(temp, { recursive: true, force: true }); });
  const apply = async (action, requestId = randomUUID()) => { const plan = await service.prepare(action); return service.apply({ requestId, expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction }); };
  return { temp, agentsRoot, clientRoots, service, apply };
}

test('listing missing canonical root and prepare are read only; standard YAML and unknown metadata survive edits', async t => {
  const f = await fixture(t); assert.equal((await f.service.state()).skills.length, 0);
  await assert.rejects(fs.stat(f.agentsRoot), { code: 'ENOENT' });
  const action = { type: 'skill.create', directory: 'example', content: content() };
  await f.service.prepare(action); await assert.rejects(fs.stat(f.agentsRoot), { code: 'ENOENT' });
  const result = await f.apply(action); const state = await f.service.state(true), skill = state.skills[0];
  assert.equal(skill.description, '中文用途\nsecond line\n'); assert.equal(skill.dependencies, null); assert.equal(result.changedIds[0], skill.id);
  assert.equal((await f.service.detail(skill.id)).content, content());
  const staging = path.join(f.agentsRoot, 'skills/.daylight-example-staging'); await fs.mkdir(staging); await fs.writeFile(path.join(staging, 'SKILL.md'), content());
  assert.equal((await f.service.state(true)).skills.length, 1, 'interrupted staging is not an active source');
  await f.apply({ type: 'skill.update', id: skill.id, content: content('example', 'second') });
  assert.match((await f.service.detail(skill.id)).content, /unknown: kept/);
  await assert.rejects(fs.stat(f.clientRoots.codex), { code: 'ENOENT' }); await assert.rejects(fs.stat(f.clientRoots.pi), { code: 'ENOENT' });
  assert.throws(() => metadata('---\nname: broken\nname: duplicate\ndescription: test\n---\n'), /格式/);
});

test('Qoder connects only individual links; native clients zero writes; unowned matching links require explicit adoption', async t => {
  const f = await fixture(t); await f.apply({ type: 'skill.create', directory: 'example', content: content() });
  const skill = (await f.service.state(true)).skills[0];
  const native = await f.service.prepare({ type: 'binding.connect', id: skill.id, clientId: 'codex' }); assert.equal(native.files.length, 0);
  await f.apply(native.normalizedAction); await assert.rejects(fs.stat(f.clientRoots.codex), { code: 'ENOENT' });
  await fs.mkdir(path.join(f.clientRoots.qoder, 'skills'), { recursive: true });
  await fs.writeFile(path.join(f.clientRoots.qoder, 'skills', 'mine.txt'), 'preserve');
  const target = path.join(f.clientRoots.qoder, 'skills', 'example');
  await fs.symlink(path.join(f.agentsRoot, 'skills', 'example'), target);
  assert.equal((await f.service.state(true)).skills[0].bindings.find(b => b.clientId === 'qoder').state, 'existing');
  assert.ok((await f.service.prepare({ type: 'binding.disconnect', id: skill.id, clientId: 'qoder' })).conflicts.length);
  await f.apply({ type: 'binding.adopt', id: skill.id, clientId: 'qoder' });
  await f.apply({ type: 'binding.disconnect', id: skill.id, clientId: 'qoder' });
  await assert.rejects(fs.lstat(target), { code: 'ENOENT' });
  await f.apply({ type: 'binding.connect', id: skill.id, clientId: 'qoder' }); assert.equal(await fs.realpath(target), path.join(f.agentsRoot, 'skills', 'example'));
  await fs.unlink(target); await fs.symlink(path.relative(path.dirname(target), path.join(f.agentsRoot, 'skills', 'example')), target);
  assert.equal((await f.service.state(true)).skills[0].bindings.find(b => b.clientId === 'qoder').state, 'existing');
  assert.ok((await f.service.prepare({ type: 'binding.disconnect', id: skill.id, clientId: 'qoder' })).conflicts.length);
  await f.apply({ type: 'binding.adopt', id: skill.id, clientId: 'qoder' });
  await f.apply({ type: 'binding.disconnect', id: skill.id, clientId: 'qoder' }); await assert.rejects(fs.lstat(target), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.clientRoots.qoder, 'skills', 'mine.txt'), 'utf8'), 'preserve');
});

test('external symlinks and same-name entities are preserved; path traversal is refused', async t => {
  const f = await fixture(t); await f.apply({ type: 'skill.create', directory: 'example', content: content() });
  const skill = (await f.service.state(true)).skills[0];
  const outside = path.join(f.temp, 'private.txt'); await fs.writeFile(outside, 'private');
  await fs.symlink(outside, path.join(f.agentsRoot, 'skills', 'example', 'linked.txt'));
  await assert.rejects(f.service.prepare({ type: 'skill.update', id: skill.id, file: 'linked.txt', content: 'bad' }), /软链接/);
  await assert.rejects(f.service.prepare({ type: 'skill.update', id: skill.id, file: '../private.txt', content: 'bad' }), /路径/);
  const binary = path.join(f.agentsRoot, 'skills/example/asset.bin'), bytes = Buffer.from([255, 216, 0, 1]); await fs.writeFile(binary, bytes);
  await assert.rejects(f.service.detail(skill.id, 'asset.bin'), failure => failure.code === 'EXTENSIONS_FILE_BINARY'); assert.deepEqual(await fs.readFile(binary), bytes);
  await fs.mkdir(path.join(f.clientRoots.qoder, 'skills', 'example'), { recursive: true });
  await fs.writeFile(path.join(f.clientRoots.qoder, 'skills', 'example', 'mine.txt'), 'untouched');
  const plan = await f.service.prepare({ type: 'binding.connect', id: skill.id, clientId: 'qoder' }); assert.ok(plan.conflicts.length);
  await assert.rejects(f.service.apply({ requestId: 'conflict-test', expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction }), /存在其他内容/);
  assert.equal(await fs.readFile(path.join(f.clientRoots.qoder, 'skills', 'example', 'mine.txt'), 'utf8'), 'untouched'); assert.equal(await fs.readFile(outside, 'utf8'), 'private');
  await fs.symlink(f.temp, path.join(f.agentsRoot, 'skills', 'external'));
  assert.ok((await f.service.state(true)).diagnostics.some(d => d.code === 'EXTERNAL_SOURCE'));
});

test('Skill archive removes owned links, preserves unowned links and restores from the operation with drift checks', async t => {
  const f = await fixture(t); await f.apply({ type: 'skill.create', directory: 'example', content: content() }); const skill = (await f.service.state(true)).skills[0];
  await f.apply({ type: 'binding.connect', id: skill.id, clientId: 'qoder' });
  await fs.mkdir(path.join(f.clientRoots.codex, 'skills'), { recursive: true }); const legacy = path.join(f.clientRoots.codex, 'skills', 'example'); await fs.symlink(path.join(f.agentsRoot, 'skills', 'example'), legacy);
  const archived = await f.apply({ type: 'skill.archive', id: skill.id }); assert.equal((await f.service.state(true)).skills.length, 0); assert.ok((await fs.lstat(legacy)).isSymbolicLink());
  await f.apply({ type: 'operation.restore', operationId: archived.operationId }); assert.equal((await f.service.state(true)).skills[0].id, skill.id); assert.ok((await fs.lstat(path.join(f.clientRoots.qoder, 'skills', 'example'))).isSymbolicLink());
  const edited = await f.apply({ type: 'skill.update', id: skill.id, content: content('example', 'changed') });
  await fs.writeFile(path.join(f.agentsRoot, 'skills', 'example', 'SKILL.md'), content('example', 'external edit'));
  const restore = await f.service.prepare({ type: 'operation.restore', operationId: edited.operationId }); assert.ok(restore.conflicts.length);
});

test('MCP credentials remain references; generation is confined to canonical root and cannot overwrite mixed global settings', async t => {
  const f = await fixture(t); const server = { id: 'local', name: '本地服务', transport: 'stdio', command: 'node', args: ['server.mjs'], envRefs: { API_TOKEN: 'API_TOKEN' } };
  await f.apply({ type: 'mcp.save', server });
  for (const clientId of ['codex', 'qoder']) { await fs.mkdir(f.clientRoots[clientId]); await fs.writeFile(path.join(f.clientRoots[clientId], clientId === 'codex' ? 'config.toml' : 'settings.json'), 'my-other-config'); }
  await f.apply({ type: 'mcp.generate', clientId: 'codex' });
  const generated = await f.service.detail('codex'); assert.match(generated.generated.content, /env_vars = \["API_TOKEN"\]/); assert.equal(generated.generated.current, true);
  await assert.rejects(f.service.prepare({ type: 'mcp.generate', clientId: 'qoder' }), /引用形式未验证/);
  await assert.rejects(f.service.prepare({ type: 'mcp.generate', clientId: 'pi' }), /MCP/);
  await assert.rejects(f.service.prepare({ type: 'mcp.save', server: { ...server, env: { TOKEN: 'plaintext' } } }), /字段无效/);
  await assert.rejects(f.service.prepare({ type: 'mcp.save', server: { ...server, id: 123 } }), failure => failure.status === 400);
  await assert.rejects(f.service.prepare({ type: 'mcp.save', server: { ...server, envRefs: { TOKEN: 'DAYLIGHT_AI_TOKEN' } } }), /内部凭据/);
  await assert.rejects(f.service.prepare({ type: 'mcp.save', server: { ...server, args: ['--token=secret'] } }), /凭据/);
  await assert.rejects(f.service.prepare({ type: 'mcp.save', server: { id: 'bad', name: 'bad', transport: 'http', url: 'https://example.test/mcp?token=secret' } }), /凭据/);
  assert.equal(await fs.readFile(path.join(f.clientRoots.codex, 'config.toml'), 'utf8'), 'my-other-config'); assert.equal(await fs.readFile(path.join(f.clientRoots.qoder, 'settings.json'), 'utf8'), 'my-other-config');
  const archived = await f.apply({ type: 'mcp.archive', id: 'local' }); assert.equal((await f.service.state(true)).servers.length, 0);
  await f.apply({ type: 'operation.restore', operationId: archived.operationId }); assert.equal((await f.service.state(true)).servers[0].id, 'local');
});

test('idempotent receipts survive service restart, changed action/preview/external file reject without overwrite', async t => {
  const f = await fixture(t), action = { type: 'skill.create', directory: 'example', content: content() }, plan = await f.service.prepare(action);
  const request = { requestId: 'repeat-request-id', expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction };
  const applied = await f.service.apply(request); assert.deepEqual(await f.service.apply(request), applied);
  assert.deepEqual(await f.service.apply({ action: { content: request.action.content, directory: request.action.directory, type: request.action.type }, planId: request.planId, expectedVersion: request.expectedVersion, requestId: request.requestId }), applied);
  const second = await createExtensionsService({ agentsRoot: f.agentsRoot, clientRoots: f.clientRoots, environment: { PATH: '' } }); t.after(() => second.close()); assert.deepEqual(await second.apply(request), applied);
  await assert.rejects(second.apply({ ...request, action: { ...action, content: content('example', 'different') } }), /其他变更/);
  const skill = (await f.service.state(true)).skills[0], edit = await f.service.prepare({ type: 'skill.update', id: skill.id, content: content('example', 'proposal') });
  await fs.writeFile(path.join(f.agentsRoot, 'skills', 'example', 'SKILL.md'), content('example', 'external'));
  await assert.rejects(f.service.apply({ requestId: 'stale-preview', expectedVersion: edit.expectedVersion, planId: edit.planId, action: edit.normalizedAction }), /已变化/);
  assert.match(await fs.readFile(path.join(f.agentsRoot, 'skills', 'example', 'SKILL.md'), 'utf8'), /external$/);
});
test('a scan that overlaps a saved source cannot publish its obsolete snapshot after invalidation', async t => {
  const f = await fixture(t); await f.apply({ type: 'skill.create', directory: 'example', content: content() });
  let release, entered, delayed = true;
  const blocked = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  const catalog = createCatalog({ root: f.agentsRoot, clients: [{ id: 'qoder', name: 'Qoder', skillMode: 'symlink', skillsRoot: path.join(f.clientRoots.qoder, 'skills'), detect: async () => {
    if (delayed) { delayed = false; entered(); await gate; } return { installed: false };
  } }], environment: { PATH: '' } });
  const ongoing = catalog.state(true); await blocked;
  await fs.writeFile(path.join(f.agentsRoot, 'skills/example/SKILL.md'), content('example', 'newly saved'));
  catalog.invalidate(); const afterWrite = catalog.state(true); release();
  const [first, second] = await Promise.all([ongoing, afterWrite]);
  assert.equal(first.version, second.version); assert.equal(first.skills[0].revision, (await f.service.state(true)).skills[0].revision);
});
test('MCP writes cannot exceed the readable master limit or overwrite a malformed master', async t => {
  const f = await fixture(t), master = path.join(f.agentsRoot, 'mcp/servers.json'); await fs.mkdir(path.dirname(master), { recursive: true });
  const server = id => ({ id, name: id, transport: 'http', url: 'http://127.0.0.1:1/mcp' });
  const original = JSON.stringify({ schemaVersion: 1, servers: Array.from({ length: 500 }, (_, index) => server('server-' + index)) }); await fs.writeFile(master, original);
  await assert.rejects(f.service.prepare({ type: 'mcp.save', server: server('one-more') }), /500/); assert.equal(await fs.readFile(master, 'utf8'), original);
  await fs.writeFile(master, 'invalid-but-preserved'); await assert.rejects(f.service.prepare({ type: 'mcp.save', server: server('one-more') }), /修复 MCP/);
  assert.equal(await fs.readFile(master, 'utf8'), 'invalid-but-preserved');
});
test('minimal desktop PATH still discovers an installed CLI without executing it', async t => {
  const f = await fixture(t), binary = path.join(f.temp, '.local/bin/qodercli'); await fs.mkdir(path.dirname(binary), { recursive: true });
  const marker = path.join(f.temp, 'must-not-run'); await fs.writeFile(binary, '#!/bin/sh\ntouch "' + marker + '"\n', { mode: 0o700 });
  const qoder = clientRegistry({ home: f.temp, clientRoots: f.clientRoots, environment: { PATH: '/usr/bin:/bin' } }).find(client => client.id === 'qoder');
  const detected = await qoder.detect(); assert.equal(detected.installed, true); assert.equal(detected.executable, binary); assert.equal(detected.runtimeVerified, false);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('Codex reports its primary directory separately from shared Skills and respects CODEX_HOME', async t => {
  const f = await fixture(t);
  const registry = options => clientRegistry({ home: f.temp, environment: { PATH: '', ...options.environment }, ...options }).find(client => client.id === 'codex');
  const standard = registry({}); assert.equal(standard.root, path.join(f.temp, '.codex')); assert.match(standard.note, /主目录 ~\/.codex/);
  const custom = registry({ environment: { CODEX_HOME: path.join(f.temp, 'custom-codex') } });
  assert.equal(custom.root, path.join(f.temp, 'custom-codex')); assert.equal(custom.skillsRoot, path.join(custom.root, 'skills'));
  assert.match(custom.note, /custom-codex/); assert.equal(custom.skillMode, 'nativeRoot');
  assert.equal(registry({ environment: { CODEX_HOME: custom.root }, clientRoots: f.clientRoots }).root, f.clientRoots.codex);
  const state = await f.service.state(true), detail = await f.service.detail('codex');
  assert.equal(state.clients.find(client => client.id === 'codex').root, f.clientRoots.codex);
  assert.equal(detail.root, f.clientRoots.codex); assert.equal(state.root, f.agentsRoot);
  await assert.rejects(fs.stat(f.clientRoots.codex), { code: 'ENOENT' });
});

test('reviewed removal of an existing correct link preserves the source and can restore the exact link', async t => {
  const f = await fixture(t); await f.apply({ type: 'skill.create', directory: 'example', content: content() });
  const skill = (await f.service.state(true)).skills[0], source = path.join(f.agentsRoot, 'skills/example'), link = path.join(f.clientRoots.qoder, 'skills/example');
  await fs.mkdir(path.dirname(link), { recursive: true });
  for (const target of [source, path.relative(path.dirname(link), source)]) {
    await fs.symlink(target, link);
    assert.ok((await f.service.prepare({ type: 'binding.disconnect', id: skill.id, clientId: 'qoder' })).conflicts.length);
    const action = { type: 'binding.disconnect', id: skill.id, clientId: 'qoder', includeExisting: true }, plan = await f.service.prepare(action);
    assert.equal(plan.conflicts.length, 0); assert.equal(await fs.readlink(link), target, 'preview does not remove the link');
    assert.match(plan.impact.join('\n'), /主 Skill 和其他软件保持原样/);
    const receipt = await f.apply(action); await assert.rejects(fs.lstat(link), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8'), content());
    await f.apply({ type: 'operation.restore', operationId: receipt.operationId }); assert.equal(await fs.readlink(link), target);
    await fs.unlink(link);
  }
  await assert.rejects(f.service.prepare({ type: 'binding.disconnect', id: skill.id, clientId: 'qoder', includeExisting: 'true' }), /布尔值/);
});

test('explicit existing-link removal still blocks other targets, entities and externally changed owned links', async t => {
  const f = await fixture(t); await f.apply({ type: 'skill.create', directory: 'example', content: content() });
  const skill = (await f.service.state(true)).skills[0], source = path.join(f.agentsRoot, 'skills/example'), link = path.join(f.clientRoots.qoder, 'skills/example');
  const action = { type: 'binding.disconnect', id: skill.id, clientId: 'qoder', includeExisting: true };
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.symlink(f.temp, link); assert.ok((await f.service.prepare(action)).conflicts.length); assert.equal(await fs.readlink(link), f.temp); await fs.unlink(link);
  await fs.mkdir(link); assert.ok((await f.service.prepare(action)).conflicts.length); assert.ok((await fs.stat(link)).isDirectory()); await fs.rmdir(link);
  await f.apply({ type: 'binding.connect', id: skill.id, clientId: 'qoder' });
  await fs.unlink(link); const relative = path.relative(path.dirname(link), source); await fs.symlink(relative, link);
  assert.ok((await f.service.prepare(action)).conflicts.length, 'includeExisting cannot bypass a changed owned link');
  assert.equal(await fs.readlink(link), relative);
  await f.apply({ type: 'binding.adopt', id: skill.id, clientId: 'qoder' }); await f.apply(action); await assert.rejects(fs.lstat(link), { code: 'ENOENT' });
});

test('nested bundled Skill sources beyond seven levels scan without false limits', async t => {
  const f = await fixture(t), directory = path.join(f.agentsRoot, 'skills/development/modules/vendor/data/project/one/two/three/four');
  await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'SKILL.md'), content('nested'));
  const state = await f.service.state(true); assert.equal(state.skills.length, 1); assert.equal(state.skills[0].name, 'nested');
  assert.equal(state.diagnostics.filter(issue => issue.code === 'SCAN_LIMIT').length, 0);
});

test('depth limits retain one actionable diagnostic and continue scanning other branches', async t => {
  const f = await fixture(t);
  for (const branch of ['a', 'b']) await fs.mkdir(path.join(f.agentsRoot, 'skills', branch, ...Array.from({ length: 33 }, (_, i) => 'd' + i)), { recursive: true });
  const directory = path.join(f.agentsRoot, 'skills/z-valid'); await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'SKILL.md'), content());
  const state = await f.service.state(true), issues = state.diagnostics.filter(issue => issue.code === 'SCAN_LIMIT');
  assert.equal(state.skills.length, 1); assert.equal(issues.length, 1); assert.equal(issues[0].reason, 'depth');
  assert.equal(issues[0].limit, 32); assert.equal(issues[0].skippedBranches, 2); assert.match(issues[0].path, /^skills\/a\//); assert.match(issues[0].message, /其他来源继续扫描/);
});

test('directory count remains bounded with one diagnostic for unscanned sources', async t => {
  const f = await fixture(t), base = path.join(f.agentsRoot, 'skills'); await fs.mkdir(base, { recursive: true });
  for (let i = 0; i < 5001; i++) await fs.mkdir(path.join(base, 'd' + String(i).padStart(4, '0')));
  const issues = (await f.service.state(true)).diagnostics.filter(issue => issue.code === 'SCAN_LIMIT');
  assert.equal(issues.length, 1); assert.equal(issues[0].reason, 'directories'); assert.equal(issues[0].limit, 5000); assert.ok(issues[0].path.startsWith('skills/'));
});
