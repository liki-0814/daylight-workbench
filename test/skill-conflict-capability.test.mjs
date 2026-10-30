import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createExtensionsService } from '../extensions/service.mjs';
import { capabilities } from '../core/contracts.js';
import * as contracts from '../core/extensions-contracts.js';
import { extensionsCapability, extensionActions, extensionsMirrorKeys } from '../core/extensions-contracts.js';

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

// One list drives the mirror. These checks fail when a key of the list is missing from the /state & /refresh mirror or from /api/v1/capabilities,
// when the mirror carries a key that is not in the list (or in the list of conditional keys, where a later PR has one), and when a value is not true.
const conditionalKeys = contracts.extensionsConditionalMirrorKeys || [];
export function mirrorProblems(keys, mirror, source, conditional = []) {
  const problems = [];
  for (const key of keys) { if (mirror[key] !== true) problems.push(`mirror is missing ${key}`); if (!(key in source)) problems.push(`/api/v1 is missing ${key}`); }
  for (const key of Object.keys(mirror)) { if (!keys.includes(key) && !conditional.includes(key)) problems.push(`mirror has unlisted ${key}`); if (mirror[key] !== true) problems.push(`mirror ${key} is not true`); if (!(key in source)) problems.push(`/api/v1 is missing mirrored ${key}`); }
  return problems;
}
test('extensionsMirrorKeys: the mirror in /state and /refresh and /api/v1 carry every listed key, and nothing else', async t => {
  const extensions = await service(t), source = capabilities().extensions;
  assert.ok(Object.isFrozen(extensionsMirrorKeys) && extensionsMirrorKeys.includes('skillConflict') && new Set(extensionsMirrorKeys).size === extensionsMirrorKeys.length);
  for (const mirror of [(await extensions.state(true)).capabilities.extensions, (await extensions.call('/state')).value.capabilities.extensions, (await extensions.call('/refresh', {})).value.capabilities.extensions]) assert.deepEqual(mirrorProblems(extensionsMirrorKeys, mirror, source, conditionalKeys), []);
});
test('mirrorProblems reports a listed key that is missing from the mirror or from /api/v1, and an unlisted mirror key', () => {
  assert.deepEqual(mirrorProblems(['a', 'b'], { a: true }, { a: 'x', b: 'y' }), ['mirror is missing b']);
  assert.deepEqual(mirrorProblems(['a', 'b'], { a: true, b: true }, { a: 'x' }), ['/api/v1 is missing b', '/api/v1 is missing mirrored b']);
  assert.deepEqual(mirrorProblems(['a'], { a: true, c: true }, { a: 'x', c: 'y' }), ['mirror has unlisted c']);
  assert.deepEqual(mirrorProblems(['a'], { a: true, c: true }, { a: 'x', c: 'y' }, ['c']), []);
  assert.deepEqual(mirrorProblems(['a'], { a: false }, { a: 'x' }), ['mirror is missing a', 'mirror a is not true']);
});
