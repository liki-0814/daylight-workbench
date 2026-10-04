import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { buildNativeCore } from '../scripts/build-native-core.mjs';
import { resolveRoute, webAssets } from '../core/contracts.js';

test('the generated native entry loads without Node or source-text rewriting', async () => {
  const context = vm.createContext({ randomUUID, structuredClone, console });
  vm.runInContext(await buildNativeCore(), context);
  const core = context.Daylight;
  const state = core.initialState();
  const next = core.applyAction(state, { type: 'task.create', title: 'native UUID' }, '2026-10-04');
  assert.match(next.tasks[0].id, /^[a-f0-9-]{36}$/);
  assert.equal(core.taskQuery(next, 1, {status:'open'}).tasks.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(core.resolveRoute('/api/v1/ai/actions','POST'))), resolveRoute('/api/v1/ai/actions','POST'));
  assert.equal(core.capabilities().taskQuery.path, '/api/v1/tasks');
});

test('the shared asset allowlist points to real resources and rejects prototype/traversal paths', async () => {
  for (const [url, file] of Object.entries(webAssets)) {
    await access(new URL('../public/' + file, import.meta.url));
    assert.equal(resolveRoute(url, 'GET').file, file);
    assert.equal(resolveRoute(url, 'POST').file, null);
  }
  for (const path of ['/constructor','/__proto__','/../state.json','/.local/agent-token']) assert.equal(resolveRoute(path,'GET').file,null);
  assert.equal(resolveRoute('/api/v1/ai/conversations','GET').handler,'missing');
  assert.equal(resolveRoute('/api/v1/unknown','GET').auth,'agent');
});
