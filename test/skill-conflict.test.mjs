import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { createExtensionsService } from '../extensions/service.mjs';
import { skillId } from '../extensions/skill-files.mjs';
import { fingerprintEntry, REDACTED_LINE } from '../extensions/conflicts.mjs';

// Fixture conflicts (E-11): the shared Skill `example` exists; Qoder holds a real directory of the same name,
// Pi holds a single file, Codex holds a link to some other folder.
const SECRET = 'sk-live-0123456789abcdefghij';
const sharedText = '---\nname: example\ndescription: demo\n---\nstep one\nstep two\nstep three\n';
const localText = '---\nname: example\ndescription: demo\n---\nstep one\nstep 2 (local edit)\nstep three\napi_key = ' + SECRET + '\n';
async function fixture(t) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'daylight-skill-conflict-')));
  const agentsRoot = path.join(temp, 'agents'), clientRoots = Object.fromEntries(['codex', 'qoder', 'pi'].map(id => [id, path.join(temp, id)]));
  await fs.mkdir(path.join(agentsRoot, 'daylight'), { recursive: true });
  await fs.writeFile(path.join(agentsRoot, 'daylight/clients.json'), JSON.stringify({ schemaVersion: 1, clients: [], selectedClients: ['codex', 'qoder', 'pi'] }));
  const service = await createExtensionsService({ agentsRoot, clientRoots, environment: { PATH: '' }, cacheMs: 0 });
  const server = http.createServer((req, res) => { void service.handle(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.close(); await service.close(); await fs.rm(temp, { recursive: true, force: true }); });
  const call = async (route, input) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/extensions' + route, { method: input ? 'POST' : 'GET', ...(input ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) } : {}) });
    const raw = await response.text();
    return { status: response.status, raw, value: JSON.parse(raw) };
  };
  const apply = async (action, requestId = randomUUID()) => { const plan = await service.prepare(action); return service.apply({ requestId, expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction }); };
  const skill = async id => (await service.state(true)).skills.find(item => item.id === id);
  const binding = async (id, client) => (await skill(id)).bindings.find(item => item.clientId === client);
  const target = client => path.join(clientRoots[client], client === 'pi' ? 'agent/skills' : 'skills', 'example');
  const manifest = async () => JSON.parse(await fs.readFile(path.join(agentsRoot, 'daylight/bindings.json'), 'utf8'));
  await apply({ type: 'skill.create', directory: 'example', content: sharedText });
  const id = skillId('example');
  await fs.mkdir(target('qoder'), { recursive: true });
  await fs.writeFile(path.join(target('qoder'), 'SKILL.md'), localText);
  await fs.writeFile(path.join(target('qoder'), '.env'), 'TOKEN=' + SECRET + '\n');
  await fs.writeFile(path.join(target('qoder'), 'notes.md'), 'local only\n');
  await fs.mkdir(path.dirname(target('pi')), { recursive: true }); await fs.writeFile(target('pi'), 'just a file ' + SECRET + '\n');
  await fs.mkdir(path.join(temp, 'elsewhere'), { recursive: true }); await fs.writeFile(path.join(temp, 'elsewhere/SKILL.md'), 'outside ' + SECRET);
  await fs.mkdir(path.dirname(target('codex')), { recursive: true }); await fs.symlink(path.join(temp, 'elsewhere'), target('codex'));
  const tree = async dir => createHash('sha256').update(JSON.stringify(await fingerprintEntry(dir))).digest('hex');
  return { temp, agentsRoot, service, call, apply, skill, binding, target, manifest, id, tree, shared: path.join(agentsRoot, 'skills/example') };
}
const enc = value => encodeURIComponent(value);

test('the fixture reports all three conflicts', async t => {
  const f = await fixture(t);
  for (const client of ['qoder', 'pi', 'codex']) assert.equal((await f.binding(f.id, client)).state, 'conflict', client);
  assert.equal((await f.binding(f.id, 'qoder')).resolution, null);
  assert.equal((await f.service.state(true)).diagnostics.filter(item => item.code === 'BINDING_CONFLICT' && item.id === f.id).length, 3);
});

test('compare is read-only, bounded and never echoes credentials', async t => {
  const f = await fixture(t), before = await f.tree(f.target('qoder')), version = (await f.service.state(true)).version;
  const { status, raw, value } = await f.call('/compare?id=' + f.id + '&clientId=qoder&expectedVersion=' + version);
  assert.equal(status, 200); assert.equal(value.readOnly, true); assert.equal(value.compared, true); assert.equal(value.local.kind, 'directory'); assert.equal(value.version, version);
  assert.ok(!raw.includes(SECRET), 'no credential value in the response');
  const byPath = Object.fromEntries(value.files.map(file => [file.path, file]));
  assert.equal(byPath['SKILL.md'].status, 'different');
  assert.ok(byPath['SKILL.md'].diff.flatMap(hunk => hunk.lines).some(line => line.op === 'shared' && line.text === 'step two'));
  assert.ok(byPath['SKILL.md'].diff.flatMap(hunk => hunk.lines).some(line => line.op === 'local' && line.text === 'step 2 (local edit)'));
  assert.ok(byPath['SKILL.md'].diff.flatMap(hunk => hunk.lines).some(line => line.text === REDACTED_LINE)); assert.equal(byPath['SKILL.md'].redactedLines, 1);
  assert.equal(byPath['.env'].status, 'onlyLocal'); assert.equal(byPath['.env'].diff, undefined);
  assert.equal(byPath['notes.md'].status, 'onlyLocal');
  assert.equal(value.summary.onlyLocal, 2); assert.equal(value.summary.different, 1); assert.equal(value.summary.redactedLines, 1);
  assert.equal(value.identical, false);
  assert.equal(await f.tree(f.target('qoder')), before, 'compare changed nothing');
  assert.equal((await f.service.state(true)).version, version);
});

test('compare withholds same-named sensitive files, does not follow links and validates its input', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.shared, '.env'), 'TOKEN=other\n');
  const { value, raw } = await f.call('/compare?id=' + f.id + '&clientId=qoder');
  const env = value.files.find(file => file.path === '.env');
  assert.equal(env.withheld, 'sensitive'); assert.equal(env.status, 'different'); assert.equal(env.diff, undefined); assert.ok(!raw.includes('other'));
  const link = (await f.call('/compare?id=' + f.id + '&clientId=codex')).value;
  assert.equal(link.compared, false); assert.equal(link.reason, 'link'); assert.deepEqual(link.files, []); assert.ok(!JSON.stringify(link).includes(SECRET));
  const file = (await f.call('/compare?id=' + f.id + '&clientId=pi')).value;
  assert.equal(file.local.kind, 'file'); assert.ok(!JSON.stringify(file).includes(SECRET));
  const only = file.files.find(item => item.path === 'SKILL.md'); assert.equal(only.status, 'different'); assert.ok(only.note); assert.ok(only.diff.flatMap(hunk => hunk.lines).some(line => line.text === REDACTED_LINE));
  assert.equal((await f.call('/compare?clientId=qoder')).value.field, 'id');
  assert.equal((await f.call('/compare?id=' + f.id)).value.field, 'clientId');
  const stale = await f.call('/compare?id=' + f.id + '&clientId=qoder&expectedVersion=stale');
  assert.equal(stale.status, 409); assert.equal(stale.value.code, 'EXTENSIONS_VERSION_CONFLICT');
  assert.equal((await f.call('/compare?id=skill_000000000000000000000000&clientId=qoder')).status, 404);
  assert.equal((await f.call('/compare?id=' + f.id + '&clientId=ghost')).status, 404);
  await fs.rm(f.target('codex'));
  const clean = await f.call('/compare?id=' + f.id + '&clientId=codex'); assert.equal(clean.status, 409); assert.equal(clean.value.code, 'EXTENSIONS_NOT_CONFLICT');
  assert.equal((await f.call('/compare', {})).status, 404, 'compare is GET only');
});

test('compare of identical content reports identical and bounds large trees', async t => {
  const f = await fixture(t);
  await fs.rm(f.target('qoder'), { recursive: true }); await fs.cp(f.shared, f.target('qoder'), { recursive: true });
  const same = (await f.call('/compare?id=' + f.id + '&clientId=qoder')).value;
  assert.equal(same.identical, true); assert.equal(same.summary.same, 1);
  for (let index = 0; index < 520; index++) await fs.writeFile(path.join(f.target('qoder'), 'f' + String(index).padStart(3, '0') + '.txt'), 'x');
  const big = (await f.call('/compare?id=' + f.id + '&clientId=qoder')).value;
  assert.equal(big.truncated, true); assert.ok(big.files.length <= 501); assert.equal(big.identical, false);
});

test('keepLocal marks the conflict as handled without touching files, and reopens when the content changes', async t => {
  const f = await fixture(t), before = await f.tree(f.target('qoder'));
  const plan = await f.service.prepare({ type: 'skill.resolveConflict', id: f.id, clientId: 'qoder', resolution: 'keepLocal' });
  assert.equal(plan.conflicts.length, 0); assert.deepEqual(plan.changedIds, [f.id]); assert.match(plan.impact[0], /不改动任何文件/);
  assert.deepEqual(plan.files.map(file => path.basename(file.path)), ['bindings.json']);
  assert.ok(!JSON.stringify(plan).includes(SECRET));
  const receipt = await f.service.apply({ requestId: randomUUID(), expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction });
  assert.equal(receipt.status, 'applied'); assert.ok(!JSON.stringify(receipt).includes(SECRET));
  assert.equal(await f.tree(f.target('qoder')), before);
  const entry = await f.binding(f.id, 'qoder');
  assert.equal(entry.state, 'conflict'); assert.equal(entry.resolution, 'keepLocal'); assert.equal(entry.resolutionStale, undefined);
  assert.ok(!(await f.service.state(true)).diagnostics.some(item => item.code === 'BINDING_CONFLICT' && item.id === f.id && item.clientId === 'qoder'));
  assert.ok((await f.service.state(true)).diagnostics.some(item => item.code === 'BINDING_CONFLICT' && item.id === f.id && item.clientId === 'pi'), 'other conflicts remain');
  const saved = (await f.manifest()).conflictResolutions; assert.equal(saved.length, 1); assert.equal(saved[0].clientId, 'qoder'); assert.match(saved[0].fingerprint, /^[a-f0-9]{64}$/); assert.ok(!JSON.stringify(saved).includes(SECRET));
  await assert.rejects(f.service.prepare({ type: 'skill.resolveConflict', id: f.id, clientId: 'qoder', resolution: 'keepLocal' }), { code: 'EXTENSIONS_ALREADY_RESOLVED' });
  // linking is still refused while the foreign content stays
  assert.ok((await f.service.prepare({ type: 'binding.connect', id: f.id, clientId: 'qoder' })).conflicts.length > 0);
  // the local content changes -> the decision no longer applies
  await fs.appendFile(path.join(f.target('qoder'), 'notes.md'), 'more\n');
  const stale = await f.binding(f.id, 'qoder');
  assert.equal(stale.resolution, null); assert.equal(stale.resolutionStale, true);
  assert.ok((await f.service.state(true)).diagnostics.some(item => item.code === 'BINDING_CONFLICT' && item.id === f.id && item.clientId === 'qoder'));
});

test('reopen clears a kept decision; it needs a record', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.prepare({ type: 'skill.resolveConflict', id: f.id, clientId: 'qoder', resolution: 'reopen' }), { code: 'EXTENSIONS_NOT_RESOLVED' });
  await f.apply({ type: 'skill.resolveConflict', id: f.id, clientId: 'qoder', resolution: 'keepLocal' });
  await f.apply({ type: 'skill.resolveConflict', id: f.id, clientId: 'qoder', resolution: 'reopen' });
  assert.equal((await f.binding(f.id, 'qoder')).resolution, null);
  assert.equal((await f.manifest()).conflictResolutions, undefined);
  assert.ok((await f.service.state(true)).diagnostics.some(item => item.code === 'BINDING_CONFLICT' && item.id === f.id && item.clientId === 'qoder'));
});

test('adoptShared replaces the client entry with the shared link and operation.restore brings the original back', async t => {
  const f = await fixture(t), original = await f.tree(f.target('qoder'));
  const plan = await f.service.prepare({ type: 'skill.resolveConflict', id: f.id, clientId: 'qoder', resolution: 'adoptShared' });
  assert.equal(plan.conflicts.length, 0); assert.match(plan.impact[0], /用共享版本替换/); assert.match(plan.warnings[0], /对比差异/);
  assert.ok(!JSON.stringify(plan).includes(SECRET), 'a directory plan echoes no file bytes');
  const receipt = await f.service.apply({ requestId: randomUUID(), expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction });
  assert.ok(receipt.changedIds.includes(f.id)); assert.ok(!JSON.stringify(receipt).includes(SECRET));
  assert.equal(await fs.readlink(f.target('qoder')), f.shared);
  const entry = await f.binding(f.id, 'qoder'); assert.equal(entry.state, 'managed'); assert.equal(entry.owned, true);
  assert.ok(!(await f.service.state(true)).diagnostics.some(item => item.code === 'BINDING_CONFLICT' && item.id === f.id && item.clientId === 'qoder'));
  assert.equal(await fs.readFile(path.join(f.shared, 'SKILL.md'), 'utf8'), sharedText, 'the shared source is untouched');
  await f.apply({ type: 'operation.restore', operationId: receipt.operationId });
  assert.equal((await fs.lstat(f.target('qoder'))).isDirectory(), true);
  assert.equal(await f.tree(f.target('qoder')), original);
  assert.equal((await f.binding(f.id, 'qoder')).state, 'conflict');
});

test('adoptShared on a single-file entry keeps the file bytes out of the plan', async t => {
  const f = await fixture(t);
  const plan = await f.service.prepare({ type: 'skill.resolveConflict', id: f.id, clientId: 'pi', resolution: 'adoptShared' });
  assert.ok(!JSON.stringify(plan).includes(SECRET)); assert.match(plan.impact[0], /文件/);
  const receipt = await f.service.apply({ requestId: randomUUID(), expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction });
  assert.ok(!JSON.stringify(receipt).includes(SECRET)); assert.ok(!JSON.stringify(await f.service.operation(receipt.operationId)).includes(SECRET));
  assert.equal(await fs.readlink(f.target('pi')), f.shared);
  await f.apply({ type: 'operation.restore', operationId: receipt.operationId });
  assert.match(await fs.readFile(f.target('pi'), 'utf8'), /just a file/);
});

test('adoptShared on a foreign link replaces only the link, never the folder it points to', async t => {
  const f = await fixture(t);
  await f.apply({ type: 'skill.resolveConflict', id: f.id, clientId: 'codex', resolution: 'adoptShared' });
  assert.equal(await fs.readlink(f.target('codex')), f.shared);
  assert.match(await fs.readFile(path.join(f.temp, 'elsewhere/SKILL.md'), 'utf8'), /^outside/);
});

test('apply is guarded by expectedVersion and planId', async t => {
  const f = await fixture(t);
  const plan = await f.service.prepare({ type: 'skill.resolveConflict', id: f.id, clientId: 'qoder', resolution: 'adoptShared' });
  await fs.writeFile(path.join(f.target('qoder'), 'notes.md'), 'changed after the preview\n');
  await assert.rejects(f.service.apply({ requestId: randomUUID(), expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction }), { code: 'EXTENSIONS_VERSION_CONFLICT', status: 409 });
  assert.equal((await fs.lstat(f.target('qoder'))).isDirectory(), true, 'nothing was replaced');
  await assert.rejects(f.service.apply({ requestId: randomUUID(), expectedVersion: 'stale', planId: plan.planId, action: plan.normalizedAction }), { code: 'EXTENSIONS_VERSION_CONFLICT' });
  await assert.rejects(f.service.apply({ requestId: randomUUID(), planId: plan.planId, action: plan.normalizedAction }), /expectedVersion/);
});

test('invalid input is rejected with a field', async t => {
  const f = await fixture(t);
  const bad = async (action, check) => assert.rejects(f.service.prepare(action), check);
  await bad({ type: 'skill.resolveConflict', id: f.id, clientId: 'qoder', resolution: 'overwrite' }, { field: 'resolution' });
  await bad({ type: 'skill.resolveConflict', id: f.id, clientId: 'qoder' }, { field: 'resolution' });
  await bad({ type: 'skill.resolveConflict', id: f.id, resolution: 'keepLocal' }, { field: 'clientId' });
  await bad({ type: 'skill.resolveConflict', id: f.id, clientId: 'qoder', resolution: 'keepLocal', force: true }, /无效/);
  await bad({ type: 'skill.resolveConflict', id: 'skill_000000000000000000000000', clientId: 'qoder', resolution: 'keepLocal' }, { code: 'EXTENSIONS_OBJECT_MISSING' });
  await bad({ type: 'skill.resolveConflict', id: f.id, clientId: 'ghost', resolution: 'keepLocal' }, { code: 'EXTENSIONS_OBJECT_MISSING' });
  const local = (await f.service.state(true)).skills.find(item => item.scope === 'client' && item.clientId === 'qoder');
  await bad({ type: 'skill.resolveConflict', id: local.id, clientId: 'qoder', resolution: 'keepLocal' }, { field: 'id' });
});

test('a position without a conflict, and a disabled Skill, cannot be resolved by adoption', async t => {
  const f = await fixture(t);
  await f.apply({ type: 'binding.connect', id: f.id, clientId: 'qoder' }).catch(() => {});
  await fs.rm(f.target('qoder'), { recursive: true }); await f.apply({ type: 'binding.connect', id: f.id, clientId: 'qoder' });
  for (const resolution of ['adoptShared', 'keepLocal']) await assert.rejects(f.service.prepare({ type: 'skill.resolveConflict', id: f.id, clientId: 'qoder', resolution }), { code: 'EXTENSIONS_NOT_CONFLICT', status: 409 });
  await assert.rejects(f.service.prepare({ type: 'skill.resolveConflict', id: f.id, clientId: 'pi', resolution: 'adoptShared' }).then(() => f.apply({ type: 'skill.disable', id: f.id })).then(() => f.service.prepare({ type: 'skill.resolveConflict', id: f.id, clientId: 'codex', resolution: 'adoptShared' })), { code: 'EXTENSIONS_SKILL_DISABLED' });
  await f.apply({ type: 'skill.resolveConflict', id: f.id, clientId: 'codex', resolution: 'keepLocal' });
});

test('archiving the Skill drops its kept decisions; a damaged record pauses writes', async t => {
  const f = await fixture(t);
  await f.apply({ type: 'skill.resolveConflict', id: f.id, clientId: 'qoder', resolution: 'keepLocal' });
  assert.equal((await f.manifest()).conflictResolutions.length, 1);
  await f.apply({ type: 'skill.archive', id: f.id });
  assert.equal((await f.manifest()).conflictResolutions, undefined);
  const g = await fixture(t), file = path.join(g.agentsRoot, 'daylight/bindings.json');
  await g.apply({ type: 'skill.resolveConflict', id: g.id, clientId: 'qoder', resolution: 'keepLocal' });
  const saved = JSON.parse(await fs.readFile(file, 'utf8')); saved.conflictResolutions[0].fingerprint = 'nope'; await fs.writeFile(file, JSON.stringify(saved));
  const state = await g.service.state(true);
  assert.ok(state.diagnostics.some(item => item.code === 'BINDINGS_FORMAT'));
  await assert.rejects(g.service.prepare({ type: 'skill.resolveConflict', id: g.id, clientId: 'pi', resolution: 'keepLocal' }), { status: 409 });
});

// User-visible copy: validation errors, conflicts, impact lines and warnings of the E-11 flow are plain Chinese. The API values
// (adoptShared / keepLocal / reopen) and fields (resolution, clientId, operation.restore) stay as they are but never appear inside a message.
test('user-visible E-11 copy has no API jargon and names the choices in plain Chinese', async t => {
  const f = await fixture(t), messages = [], jargon = /adoptShared|keepLocal|reopen|resolution|clientId|operation\.restore|expectedVersion|bindings\.json/;
  const rejected = async (action) => { try { await f.service.prepare(action); assert.fail('expected a rejection'); } catch (error) { assert.ok(error.message); messages.push(error.message); } };
  await rejected({ type: 'skill.resolveConflict', id: f.id, clientId: 'qoder', resolution: 'overwrite' });
  await rejected({ type: 'skill.resolveConflict', id: f.id, resolution: 'keepLocal' });
  await rejected({ type: 'skill.resolveConflict', id: f.id, clientId: 'qoder', resolution: 'reopen' });
  const query = await f.call('/compare?id=' + f.id); assert.equal(query.status, 400); messages.push(query.value.error);
  const adopt = await f.service.prepare({ type: 'skill.resolveConflict', id: f.id, clientId: 'qoder', resolution: 'adoptShared' });
  const keep = await f.service.prepare({ type: 'skill.resolveConflict', id: f.id, clientId: 'qoder', resolution: 'keepLocal' });
  messages.push(...adopt.impact, ...adopt.warnings, ...keep.impact, ...keep.warnings);
  await f.apply({ type: 'skill.resolveConflict', id: f.id, clientId: 'qoder', resolution: 'keepLocal' });
  await rejected({ type: 'skill.resolveConflict', id: f.id, clientId: 'qoder', resolution: 'keepLocal' });
  assert.ok(messages.length >= 9, 'covered ' + messages.length + ' messages');
  for (const message of messages) assert.doesNotMatch(String(message), jargon, String(message));
  const joined = messages.join('\n'); for (const name of ['采用共享版本', '保留软件内版本', '重新处理']) assert.match(joined, new RegExp(name));
});
