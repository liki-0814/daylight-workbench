import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AIStore } from '../ai/store.mjs';
import { createFocusSubmissions, assertFocusDraftAllowed } from '../ai/focus-submissions.mjs';
import { createConversations } from '../ai/conversations.mjs';
import { httpError } from '../ai/http.mjs';
import { createWorkbench } from '../server.mjs';
import { fixtureState } from './fixtures.mjs';

const pending = () => ({ id: randomUUID(), type: 'focusChanges', requestId: randomUUID(), version: 12, taskVersion: 17, expiresAt: Date.now() + 600000, action: { type: 'focus.start', phase: 'work', taskId: 'task-1', durationSeconds: 1500 }, summary: '开始专注' });
const applied = { ok: true, version: 13, appliedVersion: 13, current: { id: 'actual-session', taskId: 'task-1' }, lastOutcome: null, actionResult: { sessionId: 'actual-session' }, replayed: false };
async function context(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'daylight-focus-ai-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new AIStore(dir), p = pending(), c = { id: randomUUID(), title: '测试会话', backend: 'codex', config: {}, status: 'waiting', messages: [], pending: p, updatedAt: new Date().toISOString() }; store.save(c);
  return { dir, store, p, c };
}

test('approval save failure never sends HTTP and leaves unapproved draft available', async t => {
  const { c, p } = await context(t); let calls = 0;
  const submissions = createFocusSubmissions({ api: async () => { calls++; }, save: () => { throw new Error('disk failure'); } });
  await assert.rejects(submissions.apply(c, p, { approve: true }), { code: 'FOCUS_APPROVAL_SAVE_FAILED' });
  assert.equal(calls, 0); assert.equal(c.focusSubmission, undefined); assert.equal(p.submitted, false); assert.equal(p.applying, false);
});

test('approved timeout survives store restart; retry freezes original body and deduplicates operation messages', async t => {
  const { dir, store, c, p } = await context(t); const requests = [];
  p.impact={current:{id:'prior-session',taskId:'task-1',taskTitleSnapshot:'批准时任务',phase:'work',targetMs:1500000,elapsedMs:300000,remainingMs:1200000}};
  const approvedImpact=structuredClone(p.impact);
  const first = createFocusSubmissions({ api: async (route, request) => { requests.push(structuredClone(request)); throw new Error('timeout'); }, save: value => store.save(value) });
  await assert.rejects(first.apply(c, p, { approve: true }), /timeout/); assert.equal(c.focusSubmission.status, 'unknown');
  p.impact.current.taskTitleSnapshot='后来变化的草稿';
  const reloaded = new AIStore(dir), recovered = reloaded.conversations.get(c.id); assert.equal(recovered.pending, null); assert.equal(recovered.focusSubmission.status, 'unknown');
  assert.deepEqual(recovered.focusSubmission.impact,approvedImpact);assert.equal(requests[0].impact,undefined);
  const retry = createFocusSubmissions({ api: async (route, request) => { requests.push(structuredClone(request)); return { ...applied, replayed: true }; }, save: value => reloaded.save(value) });
  await assert.rejects(retry.recover(recovered, { id: p.id, action: 'retry', request: { action: {} } }));
  await retry.recover(recovered, { id: p.id, action: 'retry' }); await retry.recover(recovered, { id: p.id, action: 'retry' });
  assert.deepEqual(requests[0], requests[1]); assert.equal(requests.length, 2); assert.equal(recovered.messages.filter(m => m.requestId === p.requestId).length, 1);
  assert.equal(recovered.focusSubmission.status, 'applied'); assert.equal(recovered.focusSubmission.result.replayed, true);
});

test('result save failure retains original approved request without false operation success', async t => {
  const { dir, store, c, p } = await context(t); let saves = 0;
  const submissions = createFocusSubmissions({ api: async () => applied, save: value => { saves++; if (saves === 2) throw new Error('result disk failure'); store.save(value); } });
  await assert.rejects(submissions.apply(c, p, { approve: true }), { code: 'FOCUS_SUBMISSION_SAVE_FAILED' });
  assert.equal(c.focusSubmission.status, 'unknown'); assert.equal(c.messages.length, 0);
  const disk = JSON.parse(await readFile(path.join(dir, 'ai', 'conversations', `${c.id}.json`), 'utf8')); assert.equal(disk.focusSubmission.status, 'submitted');
  const reloaded = new AIStore(dir); assert.equal(reloaded.conversations.get(c.id).focusSubmission.status, 'unknown');
});

test('known conflict enters needs_review with fresh state; explicit acknowledgement preserves uncertain execution warning', async t => {
  const { store, c, p } = await context(t); let resolved = 0;
  const submissions = createFocusSubmissions({ api: async route => { if (route === 'focus/state') return { version: 14, current: null }; throw httpError('版本已变化', 409, { code: 'FOCUS_VERSION_CHANGED', version: 14 }); }, save: value => store.save(value), onResolved: () => { resolved++; } });
  await assert.rejects(submissions.apply(c, p, { approve: true }), { status: 409 });
  assert.equal(c.focusSubmission.status, 'needs_review'); assert.equal(c.focusSubmission.error.code, 'FOCUS_VERSION_CHANGED'); assert.equal(c.focusSubmission.latestState.version, 14);
  await submissions.recover(c, { id: p.id, action: 'acknowledge' }); assert.equal(c.focusSubmission.acknowledged, true); assert.equal(resolved, 1);
  assert.match(c.messages.at(-1).text, /不能证明旧请求从未执行/);
});

test('unknown submissions forbid cancel/acknowledge/new focus/delete and applying shares one lock', async t => {
  const { store, c, p } = await context(t); let release;
  const submissions = createFocusSubmissions({ api: () => new Promise(resolve => { release = resolve; }), save: value => store.save(value) });
  const running = submissions.apply(c, p, { approve: true }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(submissions.isApplying(c), true);
  await assert.rejects(submissions.recover(c, { id: p.id, action: 'retry' }), { status: 409 });
  await assert.rejects(submissions.apply(c, p, { approve: false }), { status: 409 }); assert.throws(() => assertFocusDraftAllowed(c), { status: 409 });
  release(applied); await running; assert.equal(submissions.isApplying(c), false);
  c.focusSubmission.status = 'unknown'; c.status = 'idle'; c.pending = null;
  await assert.rejects(submissions.recover(c, { id: p.id, action: 'acknowledge' }), { status: 409 });
  const conversations = createConversations({ store, api: async () => ({ state: fixtureState() }), providers: {}, isRunning: () => false, isFocusApplying: submissions.isApplying });
  await assert.rejects(conversations.prepareAI({ type: 'ai.conversation.delete', id: c.id, expectedUpdatedAt: c.updatedAt }), { code: 'FOCUS_SUBMISSION_UNRESOLVED' });
});

test('unapproved cancellation never creates durable submission or a focus HTTP request', async t => {
  const { c, p, store } = await context(t); let calls = 0;
  const submissions = createFocusSubmissions({ api: async () => { calls++; }, save: value => store.save(value) });
  const result = await submissions.apply(c, p, { approve: false }); assert.equal(result.ok, false); assert.equal(calls, 0); assert.equal(c.focusSubmission, undefined);
});

for(const backend of ['codex','qoder']) test(`${backend}: real AI focus draft applies, resolves waiter once and permits no-run recovery after restart`, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'daylight-focus-ai-http-')); let server, finished = 0;
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ version: 0, state: fixtureState() }));
  const adapter = { discover: async () => ({ models: [{ id: 'test-model', efforts: [] }] }), run: async ({ mcp, emit, text, ask }) => {
    if (text.startsWith('只读核对')) { const answer = await ask('只读讨论的问题'); finished++; emit({ type: 'delta', text: answer }); return; }
    const response = await fetch(mcp.env.DAYLIGHT_TOOL_URL, { method: 'POST', headers: { Authorization: `Bearer ${mcp.env.DAYLIGHT_TOOL_TOKEN}` }, body: JSON.stringify({ name: 'daylight_propose_focus_changes', arguments: { summary: '开始专注', action: { type: 'focus.start', phase: 'work', taskId: 'task-1' } } }) });
    const result = await response.json(); finished++; emit({ type: 'delta', text: result.ok ? '已保存专注' : '需核对' });
  } };
  async function boot() { server = await createWorkbench({ dataDir, aiAdapters: { codex: adapter, qoder: adapter } }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); }
  async function stop() { await server.closeProxy(); await new Promise(resolve => server.close(resolve)); }
  await boot(); t.after(async () => { if (server.listening) await stop(); await rm(dataDir, { recursive: true, force: true }); });
  const api = async (route, body, origin = true) => {
    const base = `http://127.0.0.1:${server.address().port}`, token = (await (await fetch(base + '/api/state')).json()).token;
    const response = await fetch(base + '/api/ai/' + route, { method: body ? 'POST' : 'GET', headers: { 'X-Workbench-Token': token, ...(origin ? { Origin: base } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, ...await response.json() };
  };
  await api('settings', { backend, codex: { model: 'test-model', effort: '' }, qoder: { model: 'test-model', effort: '' } });
  const c = (await api('conversations', {})).conversation;
  assert.equal(c.backend,backend);
  await api(`conversations/${c.id}/message`, { text: '专注' });
  let waiting;
  for (let i = 0; i < 100; i++) { waiting = (await api(`conversations/${c.id}`)).conversation; if (waiting.pending?.type === 'focusChanges') break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(waiting.pending.type, 'focusChanges');
  assert.equal(waiting.pending.impact.target.taskTitleSnapshot,'测试任务 1');
  assert.equal(waiting.pending.impact.target.targetMs,1500000);
  const approved = await api(`conversations/${c.id}/answer`, { id: waiting.pending.id, approve: true }); assert.equal(approved.status, 200, JSON.stringify(approved));
  for (let i = 0; i < 100 && finished === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(finished, 1);
  const final = (await api(`conversations/${c.id}`)).conversation; assert.equal(final.focusSubmission.status, 'applied'); assert.equal(final.messages.filter(m => m.requestId === waiting.pending.requestId).length, 1);
  const approvedRequest=structuredClone(final.focusSubmission.request);
  assert.deepEqual(final.focusSubmission.impact,waiting.pending.impact);
  assert.deepEqual(Object.keys(approvedRequest).sort(),['action','expectedTaskVersion','expectedVersion','expiresAt','requestId']);
  await stop();
  // Exact durable approval shape at a crash after the focus write but before the AI result save.
  const interrupted = { ...final, status: 'waiting', pending: waiting.pending, messages: waiting.messages, focusSubmission: { ...final.focusSubmission, status: 'submitted', result: null } };
  await writeFile(path.join(dataDir, 'ai', 'conversations', `${c.id}.json`), JSON.stringify(interrupted));
  await boot();
  const restarted=(await api(`conversations/${c.id}`)).conversation;
  assert.equal(restarted.focusSubmission.status,'unknown');assert.equal(restarted.pending,null);
  assert.deepEqual(restarted.focusSubmission.request,approvedRequest);
  assert.deepEqual(restarted.focusSubmission.impact,waiting.pending.impact);
  assert.equal((await api(`conversations/${c.id}/focus-submission`, { id: waiting.pending.id, action: 'retry' }, false)).status, 403);
  const recovered = await api(`conversations/${c.id}/focus-submission`, { id: waiting.pending.id, action: 'retry' }); assert.equal(recovered.status, 200); assert.equal(finished, 1); assert.equal(recovered.conversation.focusSubmission.result.replayed, true);
  assert.deepEqual(recovered.conversation.focusSubmission.request,approvedRequest);
  assert.equal(recovered.conversation.messages.filter(m=>m.requestId===waiting.pending.requestId).length,1);
  await api(`conversations/${c.id}/message`, { text: '只读核对' });
  let question;
  for (let i = 0; i < 100; i++) { question = (await api(`conversations/${c.id}`)).conversation.pending; if (question?.type === 'question') break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(question.type, 'question');
  const discussing = await api(`conversations/${c.id}/focus-submission`, { id: waiting.pending.id, action: 'retry' }); assert.equal(discussing.status, 200); assert.equal(discussing.conversation.pending.id, question.id);
  const snapshot = await server.getFocusService().snapshot(); assert.equal(snapshot.version, 1); assert.equal(snapshot.current.taskId, 'task-1');
  await api(`conversations/${c.id}/focus-submission`, { id: waiting.pending.id, action: 'retry' }); assert.equal(finished, 1);
  await api(`conversations/${c.id}/answer`, { id: question.id, answer: '继续只读讨论' });
  for (let i = 0; i < 100 && finished < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(finished, 2);
});
