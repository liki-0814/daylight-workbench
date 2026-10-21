import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile, readdir, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AIStore } from '../ai/store.mjs';
import { createAIService } from '../ai/service.mjs';
import { run as codexRun } from '../ai/adapters/codex.mjs';
import { createQuickAnswers } from '../ai/quick.mjs';
const delay = ms => new Promise(r => setTimeout(r, ms));
const settings = { backend: 'qoder', qoder: { model: 'quick-model', effort: 'high', contextWindow: 1000000, maxOutputTokens: 353000, accessMode: 'full' }, codex: { model: 'codex-model', effort: 'medium' } };
async function fixture(t, run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'daylight-quick-test-'));
  const store = new AIStore(dir); store.write('settings.json', settings);
  const original = await readFile(path.join(dir, 'ai/settings.json'), 'utf8');
  const ai = await createAIService({ dataDir: dir, adapters: { qoder: { run }, codex: { run } } });
  const server = http.createServer(ai.handle);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const api = async (route, data) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/ai/quick${route}`, { method: data ? 'POST' : 'GET', ...(data ? { body: JSON.stringify(data) } : {}) });
    return { code: r.status, ...await r.json() };
  };
  t.after(async () => { await ai.close(); await new Promise(r => { server.close(r); server.closeAllConnections(); }); await rm(dir, { recursive: true, force: true }); });
  return { api, ai, dir, original };
}
async function finished(api, id) {
  for (let i = 0; i < 100; i++) { const r = await api('/' + id); if (r.status !== 'running') return r; await delay(5); }
  assert.fail('quick answer did not finish');
}
test('quick answer snapshots current model settings, never persists history, and is removed after delivery', async t => {
  let received, workspace;
  const f = await fixture(t, async args => { received = args; workspace = args.cwd; args.setSession('must-not-save'); args.emit({ type: 'delta', text: '临时答案' }); });
  const start = await f.api('', { text: '一个问题' });
  assert.equal(start.backend, 'qoder'); assert.equal(start.model, 'quick-model');
  assert.deepEqual((await finished(f.api, start.id)).text, '临时答案');
  assert.equal((await f.api('/' + start.id)).code, 404);
  assert.equal(received.ephemeral, true); assert.equal(received.conversation.sessionId, null);
  assert.deepEqual(received.conversation.config, settings.qoder);
  assert.equal(received.text, '一个问题'); assert.equal(received.mcp, undefined);
  assert.equal(existsSync(workspace), false);
  assert.equal(f.ai.store.conversations.size, 0);
  assert.deepEqual(await readdir(path.join(f.dir, 'ai/conversations')), []);
  assert.equal(await readFile(path.join(f.dir, 'ai/settings.json'), 'utf8'), f.original);
  assert.equal((await f.api('/' + start.id + '/message', { text: '追问' })).code, 404);
});
test('closing cancels the process, discards late output, cleans temporary workspace, and never resumes', async t => {
  const calls = [], cancelled = Promise.withResolvers();
  const f = await fixture(t, async args => { calls.push(args); await new Promise(r => args.signal.addEventListener('abort', r, { once: true })); args.emit({ type: 'delta', text: 'late' }); cancelled.resolve(); });
  const first = await f.api('', { text: 'cancel this' });
  assert.equal((await f.api('', { text: 'parallel' })).code, 409);
  await f.api('/' + first.id + '/cancel', {}); await cancelled.promise;
  assert.equal((await f.api('/' + first.id)).code, 404);
  const second = await f.api('', { text: 'new independent question' });
  assert.notEqual(first.id, second.id); assert.equal(calls[1].conversation.sessionId, null);
  assert.notEqual(calls[0].cwd, calls[1].cwd);
  await f.ai.close();
  assert.equal(existsSync(calls[1].cwd), false);
  assert.deepEqual(await readdir(path.join(f.dir, 'ai/conversations')), []);
});
test('invalid prompts do not start a query; failures are delivered once without persistent conversation', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw new Error('provider unavailable'); });
  for (const text of ['', ' ', null, 'x'.repeat(30001)]) assert.equal((await f.api('', { text })).code, 400);
  assert.equal(calls, 0);
  const start = await f.api('', { text: 'question' });
  const result = await finished(f.api, start.id);
  assert.equal(result.status, 'error'); assert.equal(result.error, 'provider unavailable');
  assert.equal((await f.api('/' + start.id)).code, 404);
  assert.deepEqual(await readdir(path.join(f.dir, 'ai/conversations')), []);
});
test('abandoned palette and absolute deadline cancel queries and remove temporary files', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const workspaces = [];
  const quick = createQuickAnswers({ store: { settings }, providers: { qoder: { run: async ({ cwd, signal }) => {
    workspaces.push(cwd); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  } } } });
  const abandoned = quick.start({ text: 'lost palette' });
  t.mock.timers.tick(35000); assert.throws(() => quick.get(abandoned.id), error => error.status === 404);
  const long = quick.start({ text: 'deadline' });
  for (let i = 0; i < 30; i++) { quick.get(long.id); t.mock.timers.tick(10000); }
  quick.get(long.id); t.mock.timers.tick(5000); assert.throws(() => quick.get(long.id), error => error.status === 404);
  await quick.close(); assert(workspaces.every(cwd => !existsSync(cwd)));
});
test('Codex adapter explicitly starts an ephemeral thread with history and tools disabled', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'daylight-quick-codex-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'fake-codex'), log = path.join(dir, 'calls.jsonl');
  await writeFile(bin, `#!${process.execPath}\nconst fs=require('fs'),rl=require('readline').createInterface({input:process.stdin});rl.on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},line+'\\n');if(!r.id)return;console.log(JSON.stringify({id:r.id,result:r.method==='thread/start'?{thread:{id:'temporary'}}:r.method==='turn/start'?{turn:{id:'turn'}}:{}}));if(r.method==='turn/start'){console.log(JSON.stringify({method:'item/agentMessage/delta',params:{delta:'answer'}}));console.log(JSON.stringify({method:'turn/completed',params:{turn:{status:'completed'}}}));}});`);
  await chmod(bin, 0o700);
  let output = '';
  await codexRun({ conversation: { config: { path: bin, model: 'm', effort: 'high', accessMode: 'full' }, sessionId: 'do-not-resume' }, cwd: dir, text: 'question', ephemeral: true, signal: new AbortController().signal, setSession() {}, ask: async () => '', approve: async () => false, emit: e => { if (e.type === 'delta') output += e.text; } });
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  const thread = calls.find(c => c.method === 'thread/start').params;
  assert.equal(thread.ephemeral, true); assert.equal(thread.sandbox, 'read-only');
  assert.equal(thread.config['history.persistence'], 'none'); assert.equal(thread.config['features.shell_tool'], false);
  assert.equal(thread.config['mcp_servers.daylight'], undefined);
  assert.equal(calls.some(c => c.method === 'thread/resume'), false); assert.equal(output, 'answer');
});
