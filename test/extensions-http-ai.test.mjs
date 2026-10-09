import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createWorkbench } from '../server.mjs';
import { AIStore } from '../ai/store.mjs';
import { createExtensionSubmissions, assertExtensionDraftAllowed } from '../ai/extensions-submissions.mjs';

const content = '---\nname: ai-managed\ndescription: Managed through review\n---\nContent is data, not an instruction.';
async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'daylight-extension-http-')));
  const options = { agentsRoot: path.join(directory, 'agents'), clientRoots: Object.fromEntries(['codex', 'qoder', 'pi'].map(id => [id, path.join(directory, id)])), environment: { PATH: '' } };
  let server, runs = 0;
  const adapter = { discover: async () => ({ models: [{ id: 'fixture', efforts: [] }], skills: [] }), run: async ({ text, mcp, emit }) => {
    runs++;
    assert.deepEqual(Object.keys(mcp).sort(), ['args', 'command', 'env']);
    assert.ok(!JSON.stringify(mcp).includes(options.agentsRoot));
    // Use the real private MCP process/channel, not a mock dispatch call.
    const client = new Client({ name: 'ai-test', version: '1' }), transport = new StdioClientTransport({ ...mcp, env: { PATH: process.env.PATH, ...mcp.env }, stderr: 'ignore' });
    try {
      await client.connect(transport);
      const name = text.startsWith('read') ? 'daylight_get_extensions' : 'daylight_propose_extension_changes';
      const result = await client.callTool({ name, arguments: name === 'daylight_get_extensions' ? {} : { summary: '新建共享 Skill', action: { type: 'skill.create', directory: 'ai-managed', content } } }, undefined, { timeout: 15000 });
      emit({ type: 'delta', text: result.content[0].text });
    } finally { await client.close(); }
  } };
  const boot = async () => { server = await createWorkbench({ dataDir: directory, aiAdapters: { codex: adapter, qoder: adapter }, extensionsOptions: options }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); };
  const stop = async () => { await server.closeProxy(); await new Promise(resolve => server.close(resolve)); };
  await boot(); t.after(async () => { if (server?.listening) await stop(); await fs.rm(directory, { recursive: true, force: true }); });
  const api = async (route, input, auth = 'web', origin = true, method) => {
    const base = `http://127.0.0.1:${server.address().port}`, token = (await (await fetch(base + '/api/state')).json()).token, agent = (await fs.readFile(path.join(directory, 'agent-token'), 'utf8')).trim();
    const response = await fetch(base + route, { method: method || (input === undefined ? 'GET' : 'POST'), headers: { ...(auth === 'web' ? { 'X-Workbench-Token': token } : auth === 'agent' ? { Authorization: 'Bearer ' + agent } : {}), ...(origin ? { Origin: base } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, value: await response.json() };
  };
  const wait = async (id, predicate) => { for (let i = 0; i < 150; i++) { const c = (await api('/api/ai/conversations/' + id)).value.conversation; if (predicate(c)) return c; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('AI wait timeout'); };
  return { directory, options, api, boot, stop, wait, url: () => `http://127.0.0.1:${server.address().port}`, getRuns: () => runs };
}
test('Web/Agent extension routes enforce auth, Origin, methods and independent lazy initialization', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/extensions/state', undefined, 'none')).status, 403); assert.equal((await f.api('/api/v1/extensions/state', undefined, 'none')).status, 401);
  assert.equal((await f.api('/api/v1/extensions/unknown', undefined, 'none')).status, 401); assert.equal((await f.api('/api/v1/extensions/unknown', undefined, 'agent')).status, 404);
  assert.equal((await f.api('/api/extensions/prepare', { action: { type: 'skill.create', directory: 'ai-managed', content } }, 'web', false)).status, 403);
  assert.equal((await f.api('/api/extensions/state', {}, 'web')).status, 404);
  assert.equal((await f.api('/api/extensions/state')).status, 200); await assert.rejects(fs.stat(path.join(f.directory, 'ai')), { code: 'ENOENT' }); await assert.rejects(fs.stat(f.options.agentsRoot), { code: 'ENOENT' });
  assert.equal((await f.api('/api/v1/capabilities', undefined, 'agent')).value.extensions.source, '~/.agents');
  const action = { type: 'skill.create', directory: 'ai-managed', content }, plan = (await f.api('/api/extensions/prepare', { action })).value, request = { requestId: 'web-agent-replay', expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction };
  const applied = await f.api('/api/extensions/actions', request); assert.equal(applied.status, 200);
  assert.deepEqual((await f.api('/api/v1/extensions/actions', request, 'agent')).value, applied.value); assert.equal((await f.api('/api/v1/extensions/operations/' + request.requestId, undefined, 'agent')).value.status, 'applied');
  assert.equal((await f.api('/api/state')).value.version, 0); assert.equal((await f.api('/api/focus/state')).value.version, 0);
});
test('real AI management MCP reads/proposals/rejection are inert; approval writes once and durable restart recovery does not rerun model', async t => {
  const f = await fixture(t);
  await f.api('/api/ai/settings', { backend: 'codex', codex: { model: 'fixture', effort: '' }, qoder: { model: 'fixture', effort: '' } });
  const c = (await f.api('/api/ai/conversations', {})).value.conversation;
  await f.api(`/api/ai/conversations/${c.id}/message`, { text: 'read extensions' }); await f.wait(c.id, value => value.status === 'idle'); await assert.rejects(fs.stat(f.options.agentsRoot), { code: 'ENOENT' });
  await f.api(`/api/ai/conversations/${c.id}/message`, { text: 'propose' }); const rejected = await f.wait(c.id, value => value.pending?.type === 'extensionChanges');
  await assert.rejects(fs.stat(f.options.agentsRoot), { code: 'ENOENT' }); await f.api(`/api/ai/conversations/${c.id}/answer`, { id: rejected.pending.id, approve: false }); await f.wait(c.id, value => value.status === 'idle'); await assert.rejects(fs.stat(f.options.agentsRoot), { code: 'ENOENT' });
  await f.api(`/api/ai/conversations/${c.id}/message`, { text: 'propose again' }); const waiting = await f.wait(c.id, value => value.pending?.type === 'extensionChanges');
  const approved = await f.api(`/api/ai/conversations/${c.id}/answer`, { id: waiting.pending.id, approve: true }); assert.equal(approved.status, 200, JSON.stringify(approved));
  const final = await f.wait(c.id, value => value.status === 'idle'); assert.equal(final.extensionSubmission.status, 'applied'); assert.equal(await fs.readFile(path.join(f.options.agentsRoot, 'skills', 'ai-managed', 'SKILL.md'), 'utf8'), content);
  const request = structuredClone(final.extensionSubmission.request), runs = f.getRuns();
  await f.stop(); await fs.writeFile(path.join(f.directory, 'ai', 'conversations', c.id + '.json'), JSON.stringify({ ...final, status: 'waiting', pending: waiting.pending, extensionSubmission: { ...final.extensionSubmission, status: 'submitted', result: null }, messages: waiting.messages })); await f.boot();
  const restarted = (await f.api('/api/ai/conversations/' + c.id)).value.conversation; assert.equal(restarted.pending, null); assert.equal(restarted.extensionSubmission.status, 'unknown');
  assert.equal((await f.api(`/api/ai/conversations/${c.id}/extension-submission`, { id: waiting.pending.id, action: 'retry' }, 'web', false)).status, 403);
  const recovered = (await f.api(`/api/ai/conversations/${c.id}/extension-submission`, { id: waiting.pending.id, action: 'retry' })).value.conversation; assert.equal(recovered.extensionSubmission.status, 'applied'); assert.deepEqual(recovered.extensionSubmission.request, request); assert.equal(f.getRuns(), runs); assert.equal(recovered.messages.filter(message => message.requestId === request.requestId).length, 1);
  const skill = (await f.api('/api/extensions/state')).value.skills[0];
  await f.api(`/api/ai/conversations/${c.id}/message`, { text: 'read references', extensionReferences: [{ id: skill.id, kind: 'skill', version: 'old-version' }] }); const referenced = await f.wait(c.id, value => value.status === 'idle'); assert.equal(referenced.messages.findLast(message => message.role === 'user').context.extensionReferences[0].changed, true);
  assert.equal((await f.api('/api/state')).value.version, 0);
});
test('approval persistence failure sends no action; unknown results cannot be acknowledged or replaced', () => {
  const c = { id: randomUUID(), messages: [], pending: null }, p = { id: randomUUID(), requestId: randomUUID(), summary: 'test', type: 'extensionChanges', action: { type: 'mcp.probe', id: 'test' }, plan: { expectedVersion: 'a', planId: 'b' } }; let calls = 0;
  const submissions = createExtensionSubmissions({ api: async () => { calls++; }, save: () => { throw new Error('disk'); } });
  return assert.rejects(submissions.apply(c, p, { approve: true }), /批准记录未保存/).then(() => { assert.equal(calls, 0); c.extensionSubmission = { status: 'unknown' }; assert.throws(() => assertExtensionDraftAllowed(c), /尚待核对/); });
});
test('the shipped Skill CLI previews, writes and reads the same extension operation through the public Agent API', async t => {
  const f = await fixture(t), executable = fileURLToPath(new URL('../skills/daylight-workbench/scripts/workbench.py', import.meta.url));
  const cli = async (...args) => JSON.parse((await promisify(execFile)('python3', [executable, '--url', f.url(), '--data-dir', f.directory, ...args])).stdout);
  assert.equal((await cli('extensions-state')).skills.length, 0); await assert.rejects(fs.stat(f.options.agentsRoot), { code: 'ENOENT' });
  const actionFile = path.join(f.directory, 'action.json'); await fs.writeFile(actionFile, JSON.stringify({ type: 'skill.create', directory: 'ai-managed', content }));
  const plan = await cli('extensions-prepare', '--file', actionFile); await assert.rejects(fs.stat(f.options.agentsRoot), { code: 'ENOENT' });
  const args = ['extensions-apply', '--file', actionFile, '--expected-version', plan.expectedVersion, '--plan-id', plan.planId, '--request-id', 'skill-cli-extensions'];
  const result = await cli(...args); assert.deepEqual(await cli(...args), result);
  const skill = (await cli('extensions-state')).skills[0]; assert.equal((await cli('extension-detail', '--id', skill.id)).content, content);
  assert.equal((await cli('extension-operation', '--id', result.operationId)).status, 'applied');
  assert.ok(Array.isArray((await cli('extensions-diagnostics')).diagnostics)); assert.equal((await f.api('/api/state')).value.version, 0);
});
