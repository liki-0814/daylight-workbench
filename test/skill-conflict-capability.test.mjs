import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createExtensionsService } from '../extensions/service.mjs';
import { capabilities } from '../core/contracts.js';
import { extensionsCapability, extensionActions } from '../core/extensions-contracts.js';

// capabilities.extensions.skillConflict (optional key): E-11 backend is present. Nested exactly like the other extensions.* keys, in both
// GET /api/v1/capabilities (source) and the web mirror carried by /state and /refresh. A client hides the E-11 flow only on a literal `false`.
async function service(t) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'daylight-skill-conflict-cap-')));
  const agentsRoot = path.join(temp, 'agents'), clientRoots = { codex: path.join(temp, 'codex') };
  await fs.mkdir(path.join(agentsRoot, 'daylight'), { recursive: true });
  await fs.writeFile(path.join(agentsRoot, 'daylight/clients.json'), JSON.stringify({ schemaVersion: 1, clients: [], selectedClients: ['codex'] }));
  const created = await createExtensionsService({ agentsRoot, clientRoots, environment: { PATH: '' }, cacheMs: 0 });
  const server = http.createServer((req, res) => { void created.handle(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  created.call = async (route, input) => { const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/extensions' + route, { method: input ? 'POST' : 'GET', ...(input ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) } : {}) }); return { status: response.status, value: await response.json() }; };
  t.after(async () => { server.close(); await created.close(); await fs.rm(temp, { recursive: true, force: true }); });
  return created;
}

test('skillConflict: literal true in /api/v1/capabilities extensions, next to the actions it covers', () => {
  assert.equal(capabilities().extensions.skillConflict, true);
  assert.equal(extensionsCapability.skillConflict, true);
  assert.ok(extensionActions.includes('skill.resolveConflict'), 'the key is only true while the action exists');
  assert.match(extensionsCapability.conflictCompare, /\/compare/);
});

test('skillConflict: the web mirror in /state and /refresh has the same nesting, key name and value true', async t => {
  const extensions = await service(t);
  for (const state of [await extensions.state(true), await extensions.state(false)]) {
    assert.deepEqual(state.capabilities, { extensions: { skillConflict: true } });
    assert.equal(state.capabilities.extensions.skillConflict, capabilities().extensions.skillConflict, 'same key, same truth as /api/v1');
    for (const key of Object.keys(state.capabilities.extensions)) assert.ok(key in capabilities().extensions, `${key} exists in /api/v1/capabilities extensions`);
  }
  for (const [route, input] of [['/state'], ['/refresh', {}]]) { const reply = await extensions.call(route, input); assert.equal(reply.status, 200); assert.deepEqual(reply.value.capabilities, { extensions: { skillConflict: true } }, route); }
  assert.equal(JSON.stringify((await extensions.state(true)).capabilities).includes('/'), false, 'the mirror carries booleans only, no paths or descriptions');
});
