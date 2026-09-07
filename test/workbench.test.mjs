import { fixtureState } from './fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initialState, change, validate } from '../public/model.js';
import { createWorkbench } from '../server.mjs';

const day = '2026-09-07';

test('first launch starts with no projects, tasks or plans', () => {
  assert.deepEqual(initialState(), { schema: 1, projects: [], tasks: [], plans: {} });
});

test('a real day: select, reorder, start, switch, finish, restore, unplan without deleting', () => {
  let state = fixtureState();
  for (const id of ['task-1', 'task-2', 'task-7', 'task-1']) state = change(state, { type: 'plan', id }, day);
  assert.deepEqual(state.plans[day], ['task-1', 'task-2', 'task-7']);
  state = change(state, { type: 'move', id: 'task-7', direction: -1 }, day);
  assert.deepEqual(state.plans[day], ['task-1', 'task-7', 'task-2']);
  state = change(state, { type: 'start', id: 'task-1' }, day);
  state = change(state, { type: 'start', id: 'task-7' }, day);
  assert.deepEqual(state.tasks.filter(t => t.status === 'active').map(t => t.id), ['task-7']);
  state = change(state, { type: 'toggle', id: 'task-7' }, day);
  assert.equal(state.tasks[6].status, 'done');
  assert.ok(state.tasks[6].completedAt);
  state = change(state, { type: 'move', id: 'task-2', direction: -1 }, day);
  assert.deepEqual(state.plans[day].filter(id => id !== 'task-7'), ['task-2', 'task-1']);
  state = change(state, { type: 'toggle', id: 'task-7' }, day);
  assert.equal(state.tasks[6].status, 'todo');
  state = change(state, { type: 'unplan', id: 'task-1' }, day);
  assert.equal(state.tasks.length, 8);
  assert.equal(state.plans[day].includes('task-1'), false);
  const tomorrow = change(state, { type: 'plan', id: 'task-1' }, '2026-09-08');
  assert.deepEqual(tomorrow.plans['2026-09-08'], ['task-1']);
  assert.deepEqual(tomorrow.plans[day], state.plans[day]);
});

test('creation, editing, project assignment and validation reject broken references', () => {
  let state = change(fixtureState(), { type: 'add', id: 'custom', title: ' 临时任务 ', projectId: null, today: false }, day);
  assert.equal(state.tasks.at(-1).title, '临时任务');
  assert.equal(state.tasks.at(-1).projectId, null);
  state = change(state, { type: 'edit', id: 'custom', title: '已明确的任务', projectId: 'project-a', notes: '保留上下文' });
  assert.equal(state.tasks.at(-1).notes, '保留上下文');
  assert.throws(() => change(state, { type: 'edit', id: 'custom', title: '错误关联', projectId: 'missing', notes: '' }));
  assert.throws(() => change(state, { type: 'add', id: 'custom', title: '重复 ID', projectId: null }));
  assert.throws(() => validate({ ...state, plans: { '2026-02-30': [] } }));
  assert.throws(() => validate({ ...state, plans: { [day]: ['missing'] } }));
});

test('HTTP: durable writes, restart, conflict detection, unauthorized and invalid writes', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'daylight-test-'));
  let server;
  const boot = async () => {
    server = await createWorkbench({ dataDir });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const stop = () => new Promise(resolve => server.close(resolve));
  try {
    let url = await boot();
    const initial = await (await fetch(`${url}/api/state`)).json();
    assert.deepEqual(initial.state, initialState());
    const next = change(fixtureState(), { type: 'plan', id: 'task-1' }, day);
    const headers = { Origin: url, 'X-Workbench-Token': initial.token, 'If-Match': String(initial.version) };
    let response = await fetch(`${url}/api/state`, { method: 'PUT', headers, body: JSON.stringify(next) });
    assert.equal(response.status, 200);
    response = await fetch(`${url}/api/state`, { method: 'PUT', headers, body: JSON.stringify(initial.state) });
    assert.equal(response.status, 409);
    response = await fetch(`${url}/api/state`, { method: 'PUT', headers: { ...headers, 'If-Match': '1', Origin: 'https://example.com' }, body: JSON.stringify(next) });
    assert.equal(response.status, 403);
    response = await fetch(`${url}/api/state`, { method: 'PUT', headers: { ...headers, 'If-Match': '1' }, body: JSON.stringify({ schema: 1 }) });
    assert.equal(response.status, 400);
    assert.equal((await fetch(`${url}/server.mjs`)).status, 404);
    assert.equal((await fetch(`${url}/.local/state.json`)).status, 404);
    const backup = JSON.parse(await readFile(path.join(dataDir, 'state.previous.json'), 'utf8'));
    assert.deepEqual(backup.state.plans, {});
    await stop();
    url = await boot();
    const restored = await (await fetch(`${url}/api/state`)).json();
    assert.deepEqual(restored.state.plans[day], ['task-1']);
    assert.equal(restored.state.tasks.length, 8);
    assert.equal(restored.version, 1);
  } finally {
    if (server?.listening) await stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('corrupted data is preserved rather than replaced with sample data', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'daylight-corrupt-'));
  try {
    await writeFile(path.join(dataDir, 'state.json'), 'broken');
    await assert.rejects(createWorkbench({ dataDir }), /原文件已保留/);
    assert.equal(await readFile(path.join(dataDir, 'state.json'), 'utf8'), 'broken');
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
