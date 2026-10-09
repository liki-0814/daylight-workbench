import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createExtensionsService } from '../extensions/service.mjs';

const content = '---\nname: source\ndescription: test\n---\nBefore';
async function setup(t) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'daylight-extension-transaction-')));
  const options = { agentsRoot: path.join(temp, 'agents'), clientRoots: Object.fromEntries(['codex', 'qoder', 'pi'].map(id => [id, path.join(temp, id)])), environment: { PATH: '' }, cacheMs: 0 };
  const service = await createExtensionsService(options); t.after(async () => { await service.close(); await fs.rm(temp, { recursive: true, force: true }); });
  const create = await service.prepare({ type: 'skill.create', directory: 'source', content });
  await service.apply({ requestId: 'create-original-source', expectedVersion: create.expectedVersion, planId: create.planId, action: create.normalizedAction });
  const skill = (await service.state(true)).skills[0];
  const plan = await service.prepare({ type: 'skill.update', id: skill.id, content: content + '\nAfter' });
  const request = { requestId: 'transaction-original', expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction };
  return { temp, options, service, skill, request, source: path.join(options.agentsRoot, 'skills', 'source', 'SKILL.md') };
}
test('a real killed writer leaves a stale lock and applying journal; next writer restores only its own change', async t => {
  const f = await setup(t);
  const script = `import {createExtensionsService} from ${JSON.stringify(new URL('../extensions/service.mjs', import.meta.url).href)}; const service=await createExtensionsService({...JSON.parse(process.env.EXTENSION_OPTIONS),fault:point=>{if(point==='afterStep')process.kill(process.pid,'SIGKILL');}}); await service.apply(JSON.parse(process.env.EXTENSION_REQUEST));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, EXTENSION_OPTIONS: JSON.stringify(f.options), EXTENSION_REQUEST: JSON.stringify(f.request) }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => stderr += data);
  const exit = await new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  assert.equal(exit.signal, 'SIGKILL', stderr); assert.match(await fs.readFile(f.source, 'utf8'), /After/);
  assert.equal((await f.service.operation(f.request.requestId)).status, 'applying');
  await assert.rejects(f.service.apply(f.request), /恢复修改前/);
  assert.equal(await fs.readFile(f.source, 'utf8'), content); assert.equal((await f.service.operation(f.request.requestId)).status, 'rolled_back');
});
test('rollback cannot overwrite an external edit; after manual reconciliation the old operation can be resolved', async t => {
  const f = await setup(t);
  const faulty = await createExtensionsService({ ...f.options, fault: async point => { if (point === 'afterStep') { await fs.writeFile(f.source, 'External retained'); throw new Error('injected disk failure'); } } }); t.after(() => faulty.close());
  await assert.rejects(faulty.apply(f.request), /injected/);
  assert.equal(await fs.readFile(f.source, 'utf8'), 'External retained'); assert.equal((await f.service.operation(f.request.requestId)).status, 'recovery_required');
  await assert.rejects(f.service.apply(f.request), /人工核对/); assert.equal(await fs.readFile(f.source, 'utf8'), 'External retained');
  await fs.writeFile(f.source, content); await assert.rejects(f.service.apply(f.request), /恢复修改前/); assert.equal((await f.service.operation(f.request.requestId)).status, 'rolled_back');
});
test('response loss after receipt keeps applied result and original request replays after restart', async t => {
  const f = await setup(t), faulty = await createExtensionsService({ ...f.options, fault: point => { if (point === 'afterReceipt') throw new Error('lost response'); } }); t.after(() => faulty.close());
  await assert.rejects(faulty.apply(f.request), /lost response/); assert.equal((await f.service.operation(f.request.requestId)).status, 'applied');
  const result = await f.service.apply(f.request); assert.equal(result.operationId, f.request.requestId); assert.equal(await fs.readFile(f.source, 'utf8'), content + '\nAfter');
});
test('competing service instances use a shared exclusive lock and preserve the original plan', async t => {
  const f = await setup(t); let unlock, entered;
  const waiting = new Promise(resolve => entered = resolve), gate = new Promise(resolve => unlock = resolve);
  const first = await createExtensionsService({ ...f.options, fault: async point => { if (point === 'beforeStep') { entered(); await gate; } } }); t.after(() => first.close());
  const pending = first.apply(f.request); await waiting;
  await assert.rejects(f.service.apply({ ...f.request, requestId: 'competing-request' }), failure => failure.code === 'EXTENSIONS_BUSY');
  unlock(); const result = await pending; assert.deepEqual(await f.service.apply(f.request), result);
});
test('a client parent replaced between validation and writing cannot redirect a managed link outside its root', async t => {
  const f = await setup(t), skillsRoot = path.join(f.options.clientRoots.qoder, 'skills');
  await fs.mkdir(skillsRoot, { recursive: true });
  const outside = path.join(f.temp, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'source'), 'user content');
  const plan = await f.service.prepare({ type: 'binding.connect', id: f.skill.id, clientId: 'qoder' });
  const faulty = await createExtensionsService({ ...f.options, fault: async point => {
    if (point === 'beforeStep') { await fs.rmdir(skillsRoot); await fs.symlink(outside, skillsRoot); }
  } }); t.after(() => faulty.close());
  const request = { requestId: 'parent-swap-request', expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction };
  await assert.rejects(faulty.apply(request), /软链接/);
  assert.equal(await fs.readFile(path.join(outside, 'source'), 'utf8'), 'user content');
  assert.deepEqual(await fs.readdir(outside), ['source']);
  assert.equal((await f.service.operation(request.requestId)).status, 'recovery_required');
});
