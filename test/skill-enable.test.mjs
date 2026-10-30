import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createExtensionsService } from '../extensions/service.mjs';
import { skillId } from '../extensions/skill-files.mjs';

const skillText = (name = 'example') => '---\nname: ' + name + '\ndescription: demo\n---\nbody\n';
async function fixture(t) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'daylight-skill-enable-')));
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
  const skill = async id => (await service.state(true)).skills.find(item => item.id === id);
  const link = client => path.join(clientRoots[client], 'skills', 'example');
  const exists = async file => !!(await fs.lstat(file).catch(() => null));
  const create = async () => { await apply({ type: 'skill.create', directory: 'example', content: skillText() }); return skillId('example'); };
  return { temp, agentsRoot, clientRoots, service, call, apply, skill, link, exists, create, manifest: async () => JSON.parse(await fs.readFile(path.join(agentsRoot, 'daylight/bindings.json'), 'utf8')) };
}

test('disable removes every managed link, keeps the source and remembers the bindings; enable restores them', async t => {
  const f = await fixture(t), id = await f.create();
  await f.apply({ type: 'binding.connect', id, clientId: 'codex' }); await f.apply({ type: 'binding.connect', id, clientId: 'qoder' });
  const source = path.join(f.agentsRoot, 'skills/example');
  assert.deepEqual((await f.skill(id)).bindings.filter(item => item.state === 'managed').map(item => item.clientId).sort(), ['codex', 'qoder']);
  const before = (await f.service.state(true)).version;
  const plan = await f.service.prepare({ type: 'skill.disable', id });
  assert.deepEqual(plan.changedIds, [id]); assert.equal(plan.conflicts.length, 0); assert.match(plan.impact[0], /将取消 2 个软件的链接/);
  const receipt = await f.service.apply({ requestId: randomUUID(), expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction });
  assert.ok(receipt.changedIds.includes(id)); assert.notEqual(receipt.version, before);
  const disabled = await f.skill(id);
  assert.equal(disabled.enabled, false); assert.deepEqual([...disabled.rememberedClientIds].sort(), ['codex', 'qoder']);
  assert.ok(disabled.bindings.every(item => item.state === 'not_connected'));
  assert.equal(await f.exists(f.link('codex')), false); assert.equal(await f.exists(f.link('qoder')), false);
  assert.equal(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8'), skillText());
  const manifest = await f.manifest();
  assert.equal(manifest.schemaVersion, 1); assert.deepEqual(manifest.bindings, []);
  assert.equal(manifest.skillStates[id].disabled, true); assert.equal(manifest.skillStates[id].rememberedBindings.length, 2);
  assert.deepEqual(Object.keys(manifest.skillStates[id].rememberedBindings[0]).sort(), ['clientId', 'linkTarget', 'source', 'target']);
  // Enable restores every remembered link and clears the memory.
  await f.apply({ type: 'skill.enable', id });
  const enabled = await f.skill(id);
  assert.equal(enabled.enabled, true); assert.deepEqual(enabled.rememberedClientIds, []);
  assert.deepEqual(enabled.bindings.filter(item => item.state === 'managed').map(item => item.clientId).sort(), ['codex', 'qoder']);
  assert.equal(await fs.readlink(f.link('codex')), source);
  const restored = await f.manifest();
  assert.equal(restored.skillStates, undefined); assert.equal(restored.bindings.length, 2);
});

test('state errors: disable twice, enable when enabled, connect while disabled, missing id, client-local Skill', async t => {
  const f = await fixture(t), id = await f.create();
  await assert.rejects(f.service.prepare({ type: 'skill.enable', id }), failure => failure.status === 409 && failure.code === 'EXTENSIONS_ALREADY_ENABLED');
  await f.apply({ type: 'skill.disable', id });
  await assert.rejects(f.service.prepare({ type: 'skill.disable', id }), failure => failure.status === 409 && failure.code === 'EXTENSIONS_ALREADY_DISABLED');
  await assert.rejects(f.service.prepare({ type: 'binding.connect', id, clientId: 'codex' }), failure => failure.status === 409 && failure.code === 'EXTENSIONS_SKILL_DISABLED');
  await assert.rejects(f.service.prepare({ type: 'skill.disable', id: 'skill_' + '0'.repeat(24) }), failure => failure.status === 404 && failure.kind === 'skill');
  const http404 = await f.call('/prepare', { action: { type: 'skill.enable', id: 'skill_' + '1'.repeat(24) } }); assert.equal(http404.status, 404);
  await assert.rejects(f.service.prepare({ type: 'skill.enable', id, extra: 1 }), /字段无效/);
  // A disabled Skill with no remembered links can simply be enabled again.
  await f.apply({ type: 'skill.enable', id }); assert.equal((await f.skill(id)).enabled, true);
  await f.apply({ type: 'binding.connect', id, clientId: 'codex' });
  // A Skill that lives inside a client is local to it and cannot be disabled.
  await f.apply({ type: 'skill.create', directory: 'local-only', clientId: 'pi', content: skillText('local-only') });
  const local = (await f.service.state(true)).skills.find(item => item.scope === 'client');
  await assert.rejects(f.service.prepare({ type: 'skill.disable', id: local.id }), failure => failure.status === 400 && failure.field === 'id');
});

test('enable never overwrites an occupied target and supports restoring a subset with clientIds', async t => {
  const f = await fixture(t), id = await f.create();
  await f.apply({ type: 'binding.connect', id, clientId: 'codex' }); await f.apply({ type: 'binding.connect', id, clientId: 'qoder' });
  await f.apply({ type: 'skill.disable', id });
  await fs.mkdir(path.dirname(f.link('codex')), { recursive: true }); await fs.mkdir(f.link('codex')); await fs.writeFile(path.join(f.link('codex'), 'keep.txt'), 'mine');
  const plan = await f.service.prepare({ type: 'skill.enable', id });
  assert.equal(plan.conflicts.length, 1);
  await assert.rejects(f.service.apply({ requestId: randomUUID(), expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction }), failure => failure.status === 409 && failure.code === 'EXTENSIONS_CONFLICT');
  assert.equal(await fs.readFile(path.join(f.link('codex'), 'keep.txt'), 'utf8'), 'mine'); assert.equal((await f.skill(id)).enabled, false);
  await assert.rejects(f.service.prepare({ type: 'skill.enable', id, clientIds: ['pi'] }), failure => failure.status === 400 && failure.field === 'clientIds');
  await assert.rejects(f.service.prepare({ type: 'skill.enable', id, clientIds: 'qoder' }), failure => failure.field === 'clientIds');
  // Restoring only qoder enables the Skill and keeps codex in memory.
  await f.apply({ type: 'skill.enable', id, clientIds: ['qoder'] });
  const partial = await f.skill(id);
  assert.equal(partial.enabled, true); assert.deepEqual(partial.rememberedClientIds, ['codex']);
  assert.equal((await fs.lstat(f.link('qoder'))).isSymbolicLink(), true);
  // Once the occupying directory is gone the rest can be restored by a second enable.
  await fs.rm(f.link('codex'), { recursive: true });
  await f.apply({ type: 'skill.enable', id });
  const done = await f.skill(id); assert.deepEqual(done.rememberedClientIds, []); assert.equal(done.bindings.find(item => item.clientId === 'codex').state, 'managed');
});

test('an existing correct link that Daylight does not own is also removed and restored; wrong links are left alone', async t => {
  const f = await fixture(t), id = await f.create(), source = path.join(f.agentsRoot, 'skills/example');
  await fs.mkdir(path.dirname(f.link('codex')), { recursive: true }); await fs.symlink(source, f.link('codex'));
  await fs.mkdir(path.dirname(f.link('pi')), { recursive: true }); await fs.mkdir(f.link('pi'));
  assert.equal((await f.skill(id)).bindings.find(item => item.clientId === 'codex').state, 'existing');
  await f.apply({ type: 'skill.disable', id });
  assert.equal(await f.exists(f.link('codex')), false); assert.equal((await fs.lstat(f.link('pi'))).isDirectory(), true);
  assert.deepEqual((await f.skill(id)).rememberedClientIds, ['codex']);
  await f.apply({ type: 'skill.enable', id });
  assert.equal(await fs.readlink(f.link('codex')), source);
  assert.equal((await f.skill(id)).bindings.find(item => item.clientId === 'codex').state, 'managed');
});

test('a link that was repointed outside Daylight is never touched or remembered', async t => {
  const f = await fixture(t), id = await f.create(), elsewhere = path.join(f.temp, 'elsewhere');
  await f.apply({ type: 'binding.connect', id, clientId: 'codex' }); await f.apply({ type: 'binding.connect', id, clientId: 'qoder' });
  await fs.rm(f.link('codex')); await fs.symlink(elsewhere, f.link('codex'));
  await f.apply({ type: 'skill.disable', id });
  assert.equal(await fs.readlink(f.link('codex')), elsewhere);
  assert.equal(await f.exists(f.link('qoder')), false);
  assert.deepEqual((await f.skill(id)).rememberedClientIds, ['qoder']);
});

test('manifest compatibility: old manifests are enabled, damaged skillStates pause writes, archive drops the memory', async t => {
  const f = await fixture(t), id = await f.create();
  const file = path.join(f.agentsRoot, 'daylight/bindings.json');
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, bindings: [] }));
  assert.equal((await f.skill(id)).enabled, true); assert.deepEqual((await f.skill(id)).rememberedClientIds, []);
  await f.apply({ type: 'binding.connect', id, clientId: 'codex' });
  await f.apply({ type: 'skill.disable', id });
  await f.apply({ type: 'skill.archive', id });
  assert.equal((await f.manifest()).skillStates, undefined);
  for (const broken of [{ [id]: { disabled: 'yes', rememberedBindings: [] } }, { bad: { disabled: true, rememberedBindings: [] } }, [], { [id]: { disabled: true, rememberedBindings: [{ clientId: 'codex' }] } }]) {
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, bindings: [], skillStates: broken }));
    const state = await f.service.state(true);
    assert.ok(state.diagnostics.some(item => item.code === 'BINDINGS_FORMAT'), JSON.stringify(broken));
    await assert.rejects(f.service.prepare({ type: 'binding.connect', id: skillId('none'), clientId: 'codex' }), failure => [404, 409].includes(failure.status));
  }
});

test('requestId replay is idempotent and operation.restore reverses a disable', async t => {
  const f = await fixture(t), id = await f.create(), source = path.join(f.agentsRoot, 'skills/example');
  await f.apply({ type: 'binding.connect', id, clientId: 'codex' });
  const requestId = randomUUID(), action = { type: 'skill.disable', id };
  const plan = await f.service.prepare(action), input = { requestId, expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction };
  const first = await f.service.apply(input), second = await f.service.apply(input);
  assert.deepEqual(second, first);
  assert.equal((await f.skill(id)).enabled, false);
  await f.apply({ type: 'operation.restore', operationId: requestId });
  const back = await f.skill(id);
  assert.equal(back.enabled, true); assert.equal(back.bindings.find(item => item.clientId === 'codex').state, 'managed'); assert.equal(await fs.readlink(f.link('codex')), source);
});

test('over HTTP: prepare and actions accept the new action types', async t => {
  const f = await fixture(t), id = await f.create();
  await f.apply({ type: 'binding.connect', id, clientId: 'codex' });
  const prepared = await f.call('/prepare', { action: { type: 'skill.disable', id } });
  assert.equal(prepared.status, 200); assert.deepEqual(prepared.value.changedIds, [id]);
  const applied = await f.call('/actions', { requestId: randomUUID(), expectedVersion: prepared.value.expectedVersion, planId: prepared.value.planId, action: prepared.value.normalizedAction });
  assert.equal(applied.status, 200); assert.equal(applied.value.ok, true);
  const state = await f.call('/state'); const entry = state.value.skills.find(item => item.id === id);
  assert.equal(entry.enabled, false); assert.deepEqual(entry.rememberedClientIds, ['codex']);
  const stale = await f.call('/actions', { requestId: randomUUID(), expectedVersion: prepared.value.expectedVersion, planId: prepared.value.planId, action: { type: 'skill.disable', id } });
  assert.equal(stale.status, 409);
});
