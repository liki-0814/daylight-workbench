import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CredentialSessions } from '../proxy/shared/credential-sessions.js';
import { CustomSources } from '../proxy/custom/sources.js';
import { Secrets } from '../proxy/shared/secrets.js';

const denied = () => Object.assign(new Error('old helper required'), { code: 'EKEYCHAIN_AUTH_FAILED' });
const source = () => ({
  id: 'source', revision: 'stable-revision', name: 'Custom', baseUrl: 'https://example.test/v1', protocol: 'chat', auth: 'bearer', enabled: true, hasHeaders: false,
  models: [{ id: 'manual-alias', upstreamId: 'vendor-model', contextWindow: 128000, effort: 'high' }],
  keys: [{ id: 'default', enabled: true, hasKey: true, credentialId: 'old-one', models: [{ id: 'manual-alias', upstreamId: 'vendor-model', contextWindow: 128000, effort: 'high' }] }],
  unknownSetting: { preserve: true },
});

test('sessions silently migrate a readable previous-helper item and publish only after current-helper readback', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'daylight-session-upgrade-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const current = new Map(), calls = [];
  const secrets = {
    get: async (id, options) => { calls.push(['get', id, options]); if (id === 'review-oauth') throw denied(); return current.get(id); },
    set: async (id, value, options) => { calls.push(['set', id, options]); current.set(id, value); },
    delete: async id => { throw denied(); },
  };
  const legacySecrets = { get: async (id, options) => { calls.push(['legacy-get', id, options]); return 'synthetic-session'; } };
  const sessions = new CredentialSessions({ secrets, legacySecrets, key: 'review-oauth', dataDir });
  const [first, second] = await Promise.all([sessions.get(), sessions.get()]);
  assert.equal(first, 'synthetic-session');
  assert.equal(second, 'synthetic-session');
  assert.equal(calls.filter(([op]) => op === 'set').length, 1);
  assert.equal(calls.filter(([op]) => op === 'legacy-get').length, 1);
  const state = await sessions.state();
  assert.notEqual(state.current, 'review-oauth');
  assert.equal(current.get(state.current), 'synthetic-session');
  assert.deepEqual(state.retired, ['review-oauth']);
  assert(calls.filter(([op]) => op === 'set').every(([, , options]) => options?.interactive === false && options.timeoutMs <= 4000));
  assert(calls.filter(([op]) => op === 'legacy-get').every(([, , options]) => options?.interactive !== true && options.timeoutMs <= 4000));
  assert(calls.filter(([op]) => op === 'get' || op === 'legacy-get').every(([, , options]) => options?.interactive !== true));
  assert(!(await readFile(sessions.file, 'utf8')).includes('synthetic-session'));
  assert.equal(await sessions.get(), 'synthetic-session');
});

test('failed previous-helper reads and current-helper verification preserve the original session reference', async t => {
  for (const verifyFails of [false, true]) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'daylight-session-upgrade-failure-'));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const current = new Map();
    const secrets = {
      get: async id => { if (id === 'review-oauth' || verifyFails) throw denied(); return current.get(id); },
      set: async (id, value) => current.set(id, value),
      delete: async () => {},
    };
    const legacySecrets = { get: async () => { if (!verifyFails) throw denied(); return 'synthetic-session'; } };
    const sessions = new CredentialSessions({ secrets, legacySecrets, key: 'review-oauth', dataDir });
    await assert.rejects(sessions.get(), { code: 'EKEYCHAIN_AUTH_FAILED' });
    assert.equal((await sessions.state()).current, 'review-oauth');
    assert.equal(current.size, verifyFails ? 1 : 0);
  }
});

test('custom source migration preserves every model and setting, avoids network and verifies replacement keys', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'daylight-custom-upgrade-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const original = source(), other = { ...source(), id: 'other', name: 'Other' };
  const customFile = path.join(dataDir, 'custom-proxy/sources.json');
  await mkdir(path.dirname(customFile), { recursive: true });
  await writeFile(customFile, JSON.stringify([original, other]));
  const current = new Map(), calls = [];
  const secrets = {
    get: async (id, options) => { calls.push(['get', id, options]); if (![...current.keys()].includes(id)) throw denied(); return current.get(id); },
    set: async (id, value, options) => { calls.push(['set', id, options]); current.set(id, value); },
    delete: async id => { calls.push(['delete', id]); current.delete(id); },
  };
  const legacySecrets = { get: async (id, options) => { calls.push(['legacy-get', id, options]); return id.endsWith(':old-one') ? 'synthetic-key:' + id : undefined; } };
  const custom = new CustomSources({ dataDir, secrets, legacySecrets, fetchImpl: async () => { throw new Error('migration must not use network'); } });
  assert.deepEqual(await custom.migrateCredentials(), { migrated: 2, failed: 0 });
  const stored = JSON.parse(await readFile(customFile, 'utf8'));
  assert.deepEqual(stored[0].unknownSetting, original.unknownSetting);
  assert.deepEqual(stored[1].unknownSetting, other.unknownSetting);
  assert.deepEqual(stored[0].models, original.models);
  assert.deepEqual(stored[1].models, other.models);
  assert.deepEqual(stored[0].keys[0].models, original.keys[0].models);
  assert.deepEqual(stored[1].keys[0].models, other.keys[0].models);
  assert.notEqual(stored[0].keys[0].credentialId, 'old-one');
  assert.notEqual(stored[1].keys[0].credentialId, 'old-one');
  assert.notEqual(stored[0].keys[0].credentialId, stored[1].keys[0].credentialId);
  assert.equal(await custom.readKey('source'), 'synthetic-key:source:credential:old-one');
  assert.equal(await custom.readKey('other'), 'synthetic-key:other:credential:old-one');
  assert(!JSON.stringify(stored).includes('synthetic-key'));
  assert(calls.filter(([op]) => op === 'set' || op === 'legacy-get').every(([, , options]) => options?.interactive !== true && options.timeoutMs <= 4000));
  assert.deepEqual(await custom.migrateCredentials(), { migrated: 0, failed: 0 });
});

test('custom migration failure keeps the original source file and allows a later retry', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'daylight-custom-upgrade-failure-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const original = source(), customFile = path.join(dataDir, 'custom-proxy/sources.json');
  await mkdir(path.dirname(customFile), { recursive: true });
  await writeFile(customFile, JSON.stringify([original]));
  const before = await readFile(customFile, 'utf8'), current = new Map(), deleted = [];
  let legacyValue = 'pending-verification';
  const secrets = {
    get: async id => { if (!current.has(id) || current.get(id) === 'pending-verification') throw denied(); return current.get(id); },
    set: async (id, value) => current.set(id, value),
    delete: async id => { deleted.push(id); current.delete(id); },
  };
  const custom = new CustomSources({ dataDir, secrets, legacySecrets: { get: async () => legacyValue } });
  assert.deepEqual(await custom.migrateCredentials(), { migrated: 0, failed: 1 });
  assert.equal(await readFile(customFile, 'utf8'), before);
  assert.equal(current.size, 0);
  assert.equal(deleted.length, 1);
  assert.match(deleted[0], /:credential:/);
  legacyValue = 'recovered';
  assert.deepEqual(await custom.migrateCredentials(), { migrated: 1, failed: 0 });
  assert.equal(await custom.readKey('source'), 'recovered');
});

test('interactive repair still prompts only after the previous helper cannot migrate', async () => {
  const current = new Map(), calls = [];
  const secrets = {
    get: async (id, options) => {
      calls.push(['get', id, !!options?.interactive]);
      if (options?.interactive) return 'from-prompt';
      if (current.has(id)) return current.get(id);
      throw denied();
    },
    set: async (id, value) => current.set(id, value),
    delete: async () => {},
  };
  const legacySecrets = { get: async () => { throw denied(); } };
  const sessions = new CredentialSessions({ secrets, legacySecrets, key: 'review-oauth' });
  await assert.rejects(sessions.get(), { code: 'EKEYCHAIN_AUTH_FAILED' });
  assert.equal(await sessions.get({ interactive: true }), 'from-prompt');
  assert.deepEqual(calls.filter(([, , interactive]) => interactive), [['get', 'review-oauth', true]]);
});

test('custom migration moves unreadable request headers to a new item and leaves readable headers unchanged', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'daylight-custom-header-upgrade-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const original = { ...source(), hasHeaders: true };
  const customFile = path.join(dataDir, 'custom-proxy/sources.json');
  await mkdir(path.dirname(customFile), { recursive: true });
  await writeFile(customFile, JSON.stringify([original]));
  const current = new Map([['source:headers', 'already-readable']]), calls = [];
  const secrets = {
    get: async (id, options) => { calls.push(['get', id, options]); if (!current.has(id)) throw denied(); return current.get(id); },
    set: async (id, value, options) => { calls.push(['set', id, options]); current.set(id, value); },
    delete: async id => { calls.push(['delete', id]); current.delete(id); },
  };
  const legacySecrets = { get: async (id, options) => { calls.push(['legacy-get', id, options]); return id.endsWith(':headers') ? '{"X-Project":"header-secret"}' : 'synthetic-key:' + id; } };
  const readable = new CustomSources({ dataDir, secrets, legacySecrets, fetchImpl: async () => { throw new Error('migration must not use network'); } });
  assert.deepEqual(await readable.migrateCredentials(), { migrated: 1, failed: 0 });
  assert.equal(JSON.parse(await readFile(customFile, 'utf8'))[0].headerCredentialId, undefined);
  current.delete('source:headers');
  assert.deepEqual(await readable.migrateCredentials(), { migrated: 1, failed: 0 });
  const stored = JSON.parse(await readFile(customFile, 'utf8'))[0];
  assert.equal(current.get('source:headers:' + stored.headerCredentialId), '{"X-Project":"header-secret"}');
  assert.equal(await readable.readKey('source'), 'synthetic-key:source:credential:old-one');
  assert.equal(current.has('source:headers'), false);
  assert(!JSON.stringify(stored).includes('header-secret'));
  assert(calls.filter(([op]) => op === 'set' || op === 'get' || op === 'legacy-get').every(([, , options]) => options?.interactive !== true));
});

test('previous helpers are verified before execution and rejected helpers are never spawned', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'daylight-helper-upgrade-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const helper = path.join(dataDir, 'updates/backup/Daylight.app/Contents/Resources/DaylightCredentials');
  await mkdir(path.dirname(helper), { recursive: true });
  await writeFile(helper, 'synthetic-helper');
  const checks = [];
  const secrets = new Secrets({
    spawnImpl: () => { throw new Error('must not spawn'); },
    verifyHelper: async (candidate, reference) => { checks.push({ candidate, reference }); throw Object.assign(new Error('signature mismatch'), { code: 'EKEYCHAIN_UNAVAILABLE' }); },
  });
  const previous = secrets.previous(dataDir);
  await assert.rejects(previous.get('fixture'), { code: 'EKEYCHAIN_UNAVAILABLE' });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].candidate, helper);
  assert(checks[0].reference.endsWith('dist/native/Daylight.app/Contents/Resources/DaylightCredentials'));
});

function sessionDoubles() {
  const current = new Map(), sets = [];
  const secrets = {
    get: async id => { if (id === 'review-oauth' || !current.has(id)) throw denied(); return current.get(id); },
    set: async (id, value, options) => { sets.push([id, value, options]); current.set(id, value); },
    delete: async id => { current.delete(id); },
  };
  return { current, sets, secrets };
}

test('logout during legacy read does not publish the old session', async () => {
  const { current, sets, secrets } = sessionDoubles();
  let sessions;
  const legacySecrets = { get: async (_id, options) => { assert.ok(options.timeoutMs <= 4000); assert.notEqual(options.interactive, true); await sessions.logout(); return 'synthetic-session'; } };
  sessions = new CredentialSessions({ secrets, legacySecrets, key: 'review-oauth' });
  assert.equal(await sessions.get(), undefined);
  assert.equal((await sessions.state()).current, null);
  assert.equal(sets.length, 0);
  assert(![...current.values()].includes('synthetic-session'));
});

test('a newer login during legacy read is not overwritten by the old session', async () => {
  const { current, sets, secrets } = sessionDoubles();
  let sessions;
  const legacySecrets = { get: async () => { await sessions.replace('fresh-login', { interactive: false }); return 'old-session'; } };
  sessions = new CredentialSessions({ secrets, legacySecrets, key: 'review-oauth' });
  assert.equal(await sessions.get(), 'fresh-login');
  const state = await sessions.state();
  assert.equal(current.get(state.current), 'fresh-login');
  assert.equal(sets.length, 1);
  assert.equal(sets[0][1], 'fresh-login');
});

test('one aborted migration reader does not cancel an active sibling', async () => {
  const { current, sets, secrets } = sessionDoubles();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const legacySecrets = { get: async () => { entered(); await gate; return 'synthetic-session'; } };
  const sessions = new CredentialSessions({ secrets, legacySecrets, key: 'review-oauth' });
  const controller = new AbortController();
  const aborted = sessions.get({ signal: controller.signal });
  const active = sessions.get();
  await ready;
  controller.abort();
  release();
  await assert.rejects(aborted, { code: 'EKEYCHAIN_CANCELLED' });
  assert.equal(await active, 'synthetic-session');
  assert.equal(sets.length, 1);
  assert.equal(sets[0][1], 'synthetic-session');
  assert.equal(sets[0][2].interactive, false);
  assert.ok(sets[0][2].timeoutMs <= 4000);
  assert.equal(current.get((await sessions.state()).current), 'synthetic-session');
});

test('aborting the only migration reader publishes nothing', async () => {
  const { current, sets, secrets } = sessionDoubles();
  const controller = new AbortController();
  const legacySecrets = { get: async (_id, options) => { assert.ok(options.timeoutMs <= 4000); controller.abort(); return 'synthetic-session'; } };
  const sessions = new CredentialSessions({ secrets, legacySecrets, key: 'review-oauth' });
  await assert.rejects(sessions.get({ signal: controller.signal }), { code: 'EKEYCHAIN_CANCELLED' });
  assert.equal((await sessions.state()).current, 'review-oauth');
  assert.equal(sets.length, 0);
  assert.equal(current.size, 0);
});

test('custom header migration rotates headerCredentialId and failed readback keeps the file', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'daylight-header-upgrade-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const customFile = path.join(dataDir, 'custom-proxy/sources.json');
  await mkdir(path.dirname(customFile), { recursive: true });
  const original = { ...source(), hasHeaders: true };
  await writeFile(customFile, JSON.stringify([original]));
  const before = await readFile(customFile, 'utf8');
  const current = new Map(), deleted = [];
  let failHeaderReadback = true;
  const secrets = {
    get: async (id, options) => {
      if (options) { assert.notEqual(options.interactive, true); assert.ok(options.timeoutMs <= 4000); }
      if (!current.has(id) || (failHeaderReadback && String(id).includes(':headers:'))) throw denied();
      return current.get(id);
    },
    set: async (id, value, options) => { assert.notEqual(options?.interactive, true); assert.ok(!options || options.timeoutMs <= 4000); current.set(id, value); },
    delete: async id => { deleted.push(id); current.delete(id); },
  };
  const legacySecrets = { get: async (id, options) => { assert.notEqual(options?.interactive, true); assert.ok(options.timeoutMs <= 4000); return id.endsWith(':headers') ? '{"X-Test":"kept"}' : 'synthetic-key'; } };
  const custom = new CustomSources({ dataDir, secrets, legacySecrets, fetchImpl: async () => { throw new Error('migration must not use network'); } });
  assert.deepEqual(await custom.migrateCredentials(), { migrated: 0, failed: 2 });
  assert.equal(await readFile(customFile, 'utf8'), before);
  assert.equal(current.size, 0);
  assert(deleted.some(id => id.includes(':headers:')));
  assert.equal(JSON.parse(before)[0].keys[0].credentialId, 'old-one');
  failHeaderReadback = false;
  deleted.length = 0;
  assert.deepEqual(await custom.migrateCredentials(), { migrated: 2, failed: 0 });
  const stored = JSON.parse(await readFile(customFile, 'utf8'))[0];
  assert.deepEqual(stored.unknownSetting, original.unknownSetting);
  assert.deepEqual(stored.models, original.models);
  assert.deepEqual(stored.keys[0].models, original.keys[0].models);
  assert.notEqual(stored.keys[0].credentialId, 'old-one');
  assert.match(stored.headerCredentialId, /^[0-9a-f-]{36}$/);
  assert.equal((await custom.headers(stored))['X-Test'], 'kept');
  assert.equal(await custom.readKey('source'), 'synthetic-key');
  assert(!JSON.stringify(stored).includes('kept'));
  assert(!JSON.stringify(stored).includes('synthetic-key'));
  const saved = await custom.save({ id: stored.id, name: 'Renamed', baseUrl: stored.baseUrl, protocol: stored.protocol, auth: stored.auth, keys: stored.keys.map(key => ({ ...key, models: key.models.map(model => ({ ...model, reasoningEfforts: ['high'] })) })) });
  assert.equal(saved.headerCredentialId, stored.headerCredentialId);
  assert.equal((await custom.headers(saved))['X-Test'], 'kept');
});

test('custom migration does not start later sources after 15 seconds', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'daylight-header-budget-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const customFile = path.join(dataDir, 'custom-proxy/sources.json');
  await mkdir(path.dirname(customFile), { recursive: true });
  const first = source(), second = { ...source(), id: 'later', name: 'Later' };
  await writeFile(customFile, JSON.stringify([first, second]));
  let clock = 0; const seen = [];
  const current = new Map();
  const secrets = {
    get: async id => { if (!current.has(id)) throw denied(); return current.get(id); },
    set: async (id, value) => current.set(id, value),
    delete: async id => current.delete(id),
  };
  const custom = new CustomSources({
    dataDir, secrets, now: () => clock, fetchImpl: async () => { throw new Error('migration must not use network'); },
    legacySecrets: { get: async id => { seen.push(id); clock = 15000; return 'synthetic-key'; } },
  });
  assert.deepEqual(await custom.migrateCredentials(), { migrated: 1, failed: 0 });
  const stored = JSON.parse(await readFile(customFile, 'utf8'));
  assert.notEqual(stored[0].keys[0].credentialId, 'old-one');
  assert.equal(stored[1].keys[0].credentialId, 'old-one');
  assert.equal(stored[1].revision, second.revision);
  assert.deepEqual(stored[1].unknownSetting, second.unknownSetting);
  assert.deepEqual(seen, ['source:credential:old-one']);
});
