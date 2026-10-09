import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkbench } from '../server.mjs';
import { fixtureState } from './fixtures.mjs';

test('real HTTP focus/calendar Web and Agent auth, receipts, task hook and undo contracts', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'daylight-focus-http-'));
  const state = fixtureState(); state.plans['2026-10-06'] = ['task-1'];
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ version: 0, state }));
  const server = await createWorkbench({ dataDir });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`, initial = await (await fetch(`${base}/api/state`)).json(), agent = (await readFile(path.join(dataDir, 'agent-token'), 'utf8')).trim();
    const webHeaders = { 'X-Workbench-Token': initial.token, Origin: base }, agentHeaders = { Authorization: `Bearer ${agent}` };
    const get = async (route, headers = agentHeaders) => { const response = await fetch(`${base}${route}`, { headers }); return { code: response.status, value: await response.json() }; };
    const post = async (route, body, headers = agentHeaders) => { const response = await fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body) }); return { code: response.status, value: await response.json() }; };
    assert.equal((await get('/api/focus/state', {})).code, 403); assert.equal((await get('/api/v1/focus/state', {})).code, 401);
    const request = { requestId: 'http-focus-original', expectedVersion: 0, expectedTaskVersion: 0, action: { type: 'focus.start', phase: 'work', taskId: 'task-1' } };
    assert.equal((await post('/api/focus/actions', request, { 'X-Workbench-Token': initial.token })).code, 403);
    const started = await post('/api/focus/actions', request, webHeaders); assert.equal(started.code, 200); assert.equal(started.value.current.taskId, 'task-1');
    const replay = await post('/api/v1/focus/actions', request); assert.equal(replay.value.replayed, true); assert.equal(replay.value.current.id, started.value.current.id);
    const calendar = await get('/api/v1/calendar?from=2026-10-06&to=2026-10-07'); assert.equal(calendar.code, 200); assert.equal(calendar.value.days[0].preview[0].id, 'task-1');
    assert.equal((await get('/api/calendar?from=2026-10-06&from=2026-10-06&to=2026-10-07', webHeaders)).code, 400);
    const moved = await post('/api/task-actions', { requestId: 'http-calendar-move', expectedVersion: 0, action: { type: 'plan.reschedule', id: 'task-1', fromDay: '2026-10-06', toDay: '2026-10-07' } }, webHeaders);
    assert.equal(moved.code, 200); assert.equal(moved.value.appliedVersion, 1); assert.equal((await get('/api/v1/focus/state')).value.current.id, started.value.current.id);
    const done = await post('/api/v1/actions', { requestId: 'http-task-completed', expectedVersion: 1, action: { type: 'task.status', id: 'task-1', status: 'done' } }); assert.equal(done.code, 200);
    const ended = await get('/api/v1/focus/state'); assert.equal(ended.value.current, null); assert.equal(ended.value.lastOutcome.endReason, 'task_completed');
    const undo = await post('/api/task-actions', { requestId: 'http-task-undo-now', expectedVersion: 2, action: { type: 'undo' } }, webHeaders); assert.equal(undo.code, 200); assert.equal(undo.value.state.tasks[0].status, 'todo');
    assert.equal((await get('/api/v1/focus/state')).value.current, null);
    const capabilities = (await get('/api/v1/capabilities')).value; assert.equal(capabilities.taskPlanning.reschedule, true); assert.equal(capabilities.focus.taskStateMutation, false);
    assert.equal((await get('/api/v1/focus/sessions?limit=1&limit=2')).code, 400);
    assert.equal((await get('/api/v1/focus/export')).value.receipts, undefined);
  } finally { await server.closeProxy(); if (server.listening) await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); }
});
