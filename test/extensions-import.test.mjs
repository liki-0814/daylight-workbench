import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createExtensionsService } from '../extensions/service.mjs';
import { skillId } from '../extensions/skill-files.mjs';
import { parseMcpJson } from '../extensions/mcp-import.mjs';

const skillText = (name = 'example') => '---\nname: ' + name + '\ndescription: demo\n---\nbody\n';
async function fixture(t) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'daylight-ext-import-')));
  const agentsRoot = path.join(temp, 'agents'), clientRoots = Object.fromEntries(['codex', 'qoder', 'pi'].map(id => [id, path.join(temp, id)]));
  await fs.mkdir(path.join(agentsRoot, 'daylight'), { recursive: true });
  await fs.writeFile(path.join(agentsRoot, 'daylight/clients.json'), JSON.stringify({ schemaVersion: 1, clients: [], selectedClients: ['codex', 'qoder', 'pi'] }));
  const service = await createExtensionsService({ agentsRoot, clientRoots, environment: { PATH: '' }, cacheMs: 0 });
  const server = http.createServer((req, res) => { void service.handle(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.close(); await service.close(); await fs.rm(temp, { recursive: true, force: true }); });
  const call = async (route, input) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/extensions' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    return { status: response.status, value: await response.json() };
  };
  const apply = async (action, requestId = randomUUID()) => { const plan = await service.prepare(action); return service.apply({ requestId, expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction }); };
  const folder = async (name, files = { 'SKILL.md': skillText(name) }) => {
    const dir = path.join(temp, 'src', name);
    for (const [relative, content] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true }); await fs.writeFile(path.join(dir, relative), content); }
    return dir;
  };
  return { temp, agentsRoot, clientRoots, service, call, apply, folder, state: () => service.state(true) };
}
const code = (status, extra = {}) => failure => failure.status === status && Object.entries(extra).every(([key, value]) => failure[key] === value);

test('skill.import copies a local folder into the shared source without touching the original', async t => {
  const f = await fixture(t);
  const dir = await f.folder('imported', { 'SKILL.md': skillText('imported'), 'scripts/run.sh': '#!/bin/sh\necho hi\n', 'references/a.md': 'ref', '.git/config': 'secret', 'node_modules/x/index.js': 'x' });
  await fs.chmod(path.join(dir, 'scripts/run.sh'), 0o755);
  const plan = await f.service.prepare({ type: 'skill.import', sourcePath: dir, scope: 'shared' });
  assert.deepEqual(plan.changedIds, [skillId('imported')]); assert.equal(plan.conflicts.length, 0);
  assert.ok(plan.impact.some(line => /复制 3 个文件/.test(line))); assert.ok(plan.impact.some(line => /已忽略/.test(line)));
  assert.equal(plan.files.length, 1); assert.equal(plan.files[0].afterKind, 'directory');
  await f.service.apply({ requestId: randomUUID(), expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction });
  const target = path.join(f.agentsRoot, 'skills/imported');
  assert.equal(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8'), skillText('imported'));
  assert.equal(await fs.readFile(path.join(target, 'references/a.md'), 'utf8'), 'ref');
  assert.equal((await fs.stat(path.join(target, 'scripts/run.sh'))).mode & 0o111, 0o111);
  assert.equal(await fs.lstat(path.join(target, '.git')).catch(() => null), null); assert.equal(await fs.lstat(path.join(target, 'node_modules')).catch(() => null), null);
  assert.equal(await fs.readFile(path.join(dir, '.git/config'), 'utf8'), 'secret');
  const skill = (await f.state()).skills.find(item => item.id === skillId('imported'));
  assert.equal(skill.valid, true); assert.equal(skill.enabled, true);
  // The same folder again is a conflict, never an overwrite.
  const again = await f.service.prepare({ type: 'skill.import', sourcePath: dir, scope: 'shared' });
  assert.equal(again.conflicts.length, 1);
  await assert.rejects(f.service.apply({ requestId: randomUUID(), expectedVersion: again.expectedVersion, planId: again.planId, action: again.normalizedAction }), code(409, { code: 'EXTENSIONS_CONFLICT' }));
});

test('skill.import into a client uses that client and the target directory is the SKILL.md name', async t => {
  const f = await fixture(t);
  const dir = await f.folder('Some Folder');  // folder name differs from the Skill name
  await fs.writeFile(path.join(dir, 'SKILL.md'), skillText('real-name'));
  await f.apply({ type: 'skill.import', sourcePath: dir, scope: 'client', clientId: 'pi' });
  const local = (await f.state()).skills.find(item => item.scope === 'client' && item.clientId === 'pi');
  assert.equal(local.name, 'real-name'); assert.equal(path.basename(local.sourcePath), 'real-name');
  await assert.rejects(f.service.prepare({ type: 'skill.import', sourcePath: dir, scope: 'client' }), code(400, { field: 'clientId' }));
  await assert.rejects(f.service.prepare({ type: 'skill.import', sourcePath: dir, scope: 'shared', clientId: 'pi' }), code(400, { field: 'clientId' }));
  await assert.rejects(f.service.prepare({ type: 'skill.import', sourcePath: dir, scope: 'everywhere' }), code(400, { field: 'scope' }));
});

test('skill.import rejects unsafe or invalid sources with a reason and a field', async t => {
  const f = await fixture(t);
  const ok = await f.folder('ok'), noSkill = await f.folder('empty', { 'readme.md': 'x' }), badMeta = await f.folder('bad', { 'SKILL.md': 'no frontmatter' });
  const file = path.join(f.temp, 'a-file.txt'); await fs.writeFile(file, 'x');
  const reject = (sourcePath, expected) => assert.rejects(f.service.prepare({ type: 'skill.import', sourcePath, scope: 'shared' }), failure => failure.status === 400 && failure.field === 'sourcePath' && (!expected || (typeof expected === 'string' ? failure.code === expected : expected.test(failure.message))));
  await reject('relative/path', /绝对路径/); await reject('/tmp/../etc', /绝对路径/); await reject('', /绝对路径/); await reject(path.join(f.temp, 'missing'), /找不到/);
  await reject(file, /不是文件夹/); await reject(noSkill, 'EXTENSIONS_IMPORT_NO_SKILL'); await reject(badMeta, /SKILL.md 无效/);
  // symlinked root, symlinked SKILL.md and symlinks inside the tree are refused, never followed
  const linked = path.join(f.temp, 'linked'); await fs.symlink(ok, linked); await reject(linked, 'EXTENSIONS_IMPORT_SYMLINK');
  const outside = path.join(f.temp, 'outside.txt'); await fs.writeFile(outside, 'private');
  const inner = await f.folder('inner'); await fs.symlink(outside, path.join(inner, 'leak.txt')); await reject(inner, 'EXTENSIONS_IMPORT_SYMLINK');
  const doc = await f.folder('doc', { 'other.md': 'x' }); await fs.symlink(path.join(ok, 'SKILL.md'), path.join(doc, 'SKILL.md')); await reject(doc, 'EXTENSIONS_IMPORT_SYMLINK');
  // limits
  const deep = await f.folder('deep'); await fs.mkdir(path.join(deep, 'a/b/c/d/e/f/g/h'), { recursive: true }); await fs.writeFile(path.join(deep, 'a/b/c/d/e/f/g/h/x'), 'x'); await reject(deep, 'EXTENSIONS_IMPORT_LIMIT');
  const big = await f.folder('big'); await fs.writeFile(path.join(big, 'blob.bin'), Buffer.alloc(5_100_000)); await reject(big, 'EXTENSIONS_IMPORT_LIMIT');
  const many = await f.folder('many'); await Promise.all(Array.from({ length: 501 }, (_, index) => fs.writeFile(path.join(many, 'f' + index), 'x'))); await reject(many, 'EXTENSIONS_IMPORT_LIMIT');
  // internal records and the managed root cannot be an import source
  await fs.mkdir(path.join(f.agentsRoot, 'daylight/operations'), { recursive: true }); await fs.writeFile(path.join(f.agentsRoot, 'daylight/operations/SKILL.md'), skillText('internal'));
  await reject(path.join(f.agentsRoot, 'daylight/operations'));
  await fs.writeFile(path.join(f.temp, 'SKILL.md'), skillText('everything'));
  await reject(f.temp);
  assert.equal(await fs.lstat(path.join(f.agentsRoot, 'skills/ok')).catch(() => null), null);
});

test('skill.import over HTTP reports 400 with the field and rejects unknown keys', async t => {
  const f = await fixture(t);
  const bad = await f.call('/prepare', { action: { type: 'skill.import', sourcePath: 'nope', scope: 'shared' } });
  assert.equal(bad.status, 400); assert.equal(bad.value.field, 'sourcePath');
  const extra = await f.call('/prepare', { action: { type: 'skill.import', sourcePath: '/x', scope: 'shared', url: 'https://github.com/a/b' } });
  assert.equal(extra.status, 400);
});

test('mcp.importJson adds new servers, treats an existing ID as a conflict and never overwrites it', async t => {
  const f = await fixture(t);
  await f.apply({ type: 'mcp.save', create: true, server: { id: 'keep', name: 'original', transport: 'stdio', command: 'node', args: [] } });
  const json = JSON.stringify({ mcpServers: {
    keep: { command: 'npx', args: ['-y', 'other'] },
    fresh: { command: 'npx', args: ['-y', 'pkg'], env: { API_KEY: '${MY_API_KEY}', PLAIN_REF: '$OTHER' } },
    remote: { url: 'https://mcp.example.com/mcp', headers: { Authorization: '${MCP_AUTH}' }, disabled: true },
  } });
  const plan = await f.service.prepare({ type: 'mcp.importJson', json, scope: 'shared' });
  assert.equal(plan.conflicts.length, 1); assert.match(plan.conflicts[0], /keep/); assert.deepEqual(plan.changedIds.sort(), ['fresh', 'remote']);
  await assert.rejects(f.service.apply({ requestId: randomUUID(), expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction }), code(409, { code: 'EXTENSIONS_CONFLICT' }));
  assert.equal((await f.state()).servers.find(item => item.id === 'keep').name, 'original'); assert.equal((await f.state()).servers.some(item => item.id === 'fresh'), false);
  // Without the conflicting entry everything imports.
  const clean = JSON.stringify({ mcpServers: JSON.parse(json).mcpServers && { fresh: JSON.parse(json).mcpServers.fresh, remote: JSON.parse(json).mcpServers.remote } });
  await f.apply({ type: 'mcp.importJson', json: clean, scope: 'shared' });
  const state = await f.state(), fresh = state.servers.find(item => item.id === 'fresh'), remote = state.servers.find(item => item.id === 'remote');
  assert.deepEqual(fresh.envRefs, { API_KEY: 'MY_API_KEY', PLAIN_REF: 'OTHER' }); assert.equal(fresh.enabled, true);
  assert.equal(remote.transport, 'http'); assert.deepEqual(remote.headerRefs, { Authorization: 'MCP_AUTH' }); assert.equal(remote.enabled, false);
});

test('mcp.importJson accepts a single server object and imports into a client configuration', async t => {
  const f = await fixture(t);
  await f.apply({ type: 'mcp.importJson', scope: 'shared', json: JSON.stringify({ name: 'solo', command: 'node', args: ['server.mjs'] }) });
  assert.ok((await f.state()).servers.some(item => item.id === 'solo'));
  await f.apply({ type: 'mcp.importJson', scope: 'client', clientId: 'codex', json: JSON.stringify({ mcpServers: { alpha: { command: 'node', args: ['a.mjs'] }, beta: { url: 'https://x.test/mcp' } } }) });
  const keys = (await f.state()).servers.filter(item => item.clientId === 'codex').map(item => item.serverKey).sort();
  assert.deepEqual(keys, ['alpha', 'beta']);
  const dup = await f.service.prepare({ type: 'mcp.importJson', scope: 'client', clientId: 'codex', json: JSON.stringify({ mcpServers: { alpha: { command: 'node' } } }) });
  assert.equal(dup.conflicts.length, 1);
  await assert.rejects(f.service.prepare({ type: 'mcp.importJson', scope: 'client', json: '{}' }), code(400, { field: 'clientId' }));
});

test('mcp.importJson errors: syntax position, plaintext secrets are refused and never echoed, unsupported fields', async t => {
  const f = await fixture(t);
  const syntax = await f.call('/prepare', { action: { type: 'mcp.importJson', scope: 'shared', json: '{\n  "mcpServers": {\n    "a": { "command": "node", }\n  }\n}' } });
  assert.equal(syntax.status, 400); assert.equal(syntax.value.field, 'json'); assert.equal(syntax.value.line, 3); assert.ok(syntax.value.column > 1);
  const secret = 'sk-live-0123456789';
  const plain = await f.call('/prepare', { action: { type: 'mcp.importJson', scope: 'shared', json: JSON.stringify({ mcpServers: { a: { command: 'node', env: { API_KEY: secret } } } }) } });
  assert.equal(plain.status, 400); assert.equal(plain.value.field, 'mcpServers.a.env.API_KEY'); assert.equal(JSON.stringify(plain.value).includes(secret), false);
  const header = await f.call('/prepare', { action: { type: 'mcp.importJson', scope: 'shared', json: JSON.stringify({ mcpServers: { r: { url: 'https://x.test', headers: { Authorization: 'Bearer ' + secret } } } }) } });
  assert.equal(header.status, 400); assert.equal(header.value.field, 'mcpServers.r.headers.Authorization'); assert.equal(JSON.stringify(header.value).includes(secret), false);
  const cases = [
    ['{"mcpServers":{"a":{"command":"node","timeout":5}}}', 'mcpServers.a.timeout'], ['{"mcpServers":{"a":{"type":"sse","url":"https://x.test"}}}', 'mcpServers.a.type'],
    ['{"mcpServers":{"bad id":{"command":"node"}}}', 'mcpServers.bad id.id'], ['{"mcpServers":{"a":{}}}', 'mcpServers.a'], ['{"mcpServers":{}}', 'mcpServers'],
    ['{"command":"node"}', 'json'], ['[]', 'json'], ['', 'json'], ['{"mcpServers":{"a":{"command":"node"},"a":{"command":"x"}}}', 'json'],
    ['{"mcpServers":{"a":{"url":"https://x.test/?token=1"}}}', 'mcpServers.a.url'],
  ];
  for (const [json, field] of cases) await assert.rejects(f.service.prepare({ type: 'mcp.importJson', scope: 'shared', json }), failure => failure.status === 400 && failure.field === field, json + ' -> ' + field);
  assert.equal(parseMcpJson('{"mcpServers":{"ok":{"command":"node"}}}')[0].id, 'ok');
  assert.equal((await f.state()).servers.length, 0);
});

test('mcp.importJson warns about plain http to a remote host', async t => {
  const f = await fixture(t);
  const plan = await f.service.prepare({ type: 'mcp.importJson', scope: 'shared', json: JSON.stringify({ mcpServers: { r: { url: 'http://remote.example.com/mcp' } } }) });
  assert.equal(plan.warnings[0].code, 'INSECURE_HTTP'); assert.match(plan.warnings[0].message, /r/);
});
