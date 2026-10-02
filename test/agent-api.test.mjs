import { fixtureState } from './fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWorkbench } from '../server.mjs';
import { applyAction } from '../agent-api.mjs';

const run = promisify(execFile);
const client = fileURLToPath(new URL('../skills/daylight-workbench/scripts/workbench.py', import.meta.url));

test('agent operations cover explicit states, project updates, plans, deletion and atomic batches', () => {
  const day = '2026-09-07';
  let state = fixtureState();
  const apply = action => { state = applyAction(state, action, day); };
  apply({ type: 'project.create', id: 'new-project', name: '测试项目', path: '/tmp/example' });
  apply({ type: 'project.update', id: 'new-project', name: '更名项目', path: '/tmp/changed' });
  apply({ type: 'task.create', id: 'new-task', title: '明确任务', projectId: 'new-project' });
  apply({ type: 'task.update', id: 'new-task', notes: '备注', title: '修改任务' });
  assert.equal(state.tasks.at(-1).projectId, 'new-project');
  apply({ type: 'task.status', id: 'new-task', status: 'active' });
  apply({ type: 'task.status', id: 'new-task', status: 'active' });
  assert.equal(state.tasks.at(-1).status, 'active');
  apply({ type: 'task.status', id: 'task-1', status: 'active' });
  assert.equal(state.tasks.at(-1).status, 'todo');
  apply({ type: 'task.status', id: 'task-1', status: 'done' });
  const completedAt = state.tasks[0].completedAt;
  apply({ type: 'task.status', id: 'task-1', status: 'done' });
  assert.equal(state.tasks[0].completedAt, completedAt);
  apply({ type: 'task.status', id: 'task-1', status: 'todo' });
  apply({ type: 'plan.set', ids: ['new-task', 'task-1'] });
  apply({ type: 'plan.move', id: 'task-1', direction: -1 });
  assert.deepEqual(state.plans[day], ['task-1', 'new-task']);
  apply({ type: 'plan.remove', id: 'task-1' });
  assert.throws(() => apply({ type: 'plan.set', ids: ['new-task', 'new-task'] }));
  const before = structuredClone(state);
  assert.throws(() => apply({ type: 'batch', actions: [{ type: 'task.delete', id: 'new-task' }, { type: 'task.status', id: 'missing', status: 'done' }] }));
  assert.deepEqual(state, before);
  apply({ type: 'task.delete', id: 'new-task' });
  assert.deepEqual(state.plans[day], []);
  apply({ type: 'project.delete', id: 'new-project' });
  assert.equal(state.projects.length, 2);
});

test('agent API auth, idempotency across restart, conflicts, atomic failure and undo', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'daylight-agent-'));
  let server, url, token;
  async function boot() {
    server = await createWorkbench({ dataDir });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
    token = await readFile(path.join(dataDir, 'agent-token'), 'utf8');
  }
  const stop = () => new Promise(resolve => server.close(resolve));
  const post = (body, headers = {}) => fetch(`${url}/api/v1/actions`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });
  try {
    await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ version: 0, state: fixtureState() }));
    await boot();
    assert.equal((await stat(path.join(dataDir, 'agent-token'))).mode & 0o777, 0o600);
    assert.equal((await fetch(`${url}/api/v1/state`)).status, 401);
    const body = { expectedVersion: 0, requestId: randomUUID(), action: { type: 'task.create', title: '只创建一次', projectId: 'project-a' } };
    assert.equal((await post(body, { Origin: 'https://example.com' })).status, 401);
    let response = await post(body);
    assert.equal(response.status, 200);
    const first = await response.json();
    assert.equal(first.state.tasks.length, 9);
    assert.equal(first.version, 1);
    assert.equal(JSON.stringify(first).includes(token), false);
    response = await post(body);
    assert.equal((await response.json()).replayed, true);
    assert.equal((await post({ ...body, action: { type: 'task.create', title: '不同操作' } })).status, 409);
    assert.equal((await post({ ...body, requestId: randomUUID() })).status, 409);
    await stop();
    await boot();
    const replay = await (await post(body)).json();
    assert.equal(replay.replayed, true);
    assert.equal(replay.state.tasks.length, 9);
    const fail = { expectedVersion: 1, requestId: randomUUID(), action: { type: 'batch', actions: [{ type: 'task.create', title: '不应保存' }, { type: 'plan.add', id: 'missing' }] } };
    assert.equal((await post(fail)).status, 400);
    const undo = await (await post({ expectedVersion: 1, requestId: randomUUID(), action: { type: 'undo' } })).json();
    assert.equal(undo.version, 2);
    assert.equal(undo.state.tasks.length, 8);
    assert.equal((await (await post(body)).json()).replayed, true);
    assert.equal((await fetch(`${url}/.local/agent-token`)).status, 404);
  } finally {
    if (server?.listening) await stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('installed-format Python skill client performs real reads, writes, filtering and export', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'daylight-cli-'));
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ version: 0, state: fixtureState() }));
  const server = await createWorkbench({ dataDir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const cli = async (...args) => JSON.parse((await run('python3', [client, '--url', url, '--data-dir', dataDir, ...args])).stdout);
  try {
    assert.equal((await cli('capabilities')).apiVersion, 1);
    const state = await cli('state');
    const actionFile = path.join(dataDir, 'action.json');
    await writeFile(actionFile, JSON.stringify({ type: 'batch', actions: [{ type: 'task.create', id: 'cli-task', title: '来自外部 AI 的任务', projectId: 'project-b' }, { type: 'plan.add', id: 'cli-task' }] }));
    const requestId = randomUUID();
    const result = await cli('apply', '--expected-version', String(state.version), '--request-id', requestId, '--file', actionFile, '--date', '2026-09-07');
    assert.equal(result.state.tasks.at(-1).title, '来自外部 AI 的任务');
    assert.equal((await cli('apply', '--expected-version', String(state.version), '--request-id', requestId, '--file', actionFile, '--date', '2026-09-07')).replayed, true);
    const today = await cli('state', '--view', 'today', '--date', '2026-09-07', '--query', '外部 AI');
    assert.equal(today.matchingTasks.length, 1);
    const outfile = path.join(dataDir, 'export.json');
    await cli('export', '--out', outfile);
    assert.equal(JSON.parse(await readFile(outfile, 'utf8')).tasks.length, 9);
    await assert.rejects(cli('export', '--out', outfile));
    await assert.rejects(run('python3', [client, '--url', 'https://example.com', 'state']), /仅允许/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('UI and API deletion share cascading rules and preserve unrelated data', async () => {
  const { change } = await import('../public/model.js');
  const state = fixtureState();
  state.tasks[0].status = 'active';
  state.tasks[1].status = 'done'; state.tasks[1].completedAt = new Date().toISOString();
  state.plans['2026-09-07'] = ['task-1', 'task-2'];
  state.plans['2026-09-08'] = ['task-1'];
  for (const id of ['task-1', 'task-2']) {
    const action = { type: 'task.delete', id };
    const after = change(state, action);
    assert.deepEqual(after, applyAction(state, action, '2026-09-07'));
    assert.ok(!after.tasks.some(t => t.id === id));
    assert.ok(Object.values(after.plans).every(ids => !ids.includes(id)));
    assert.equal(state.tasks.length, 8);
  }
  const projectAction = { type: 'project.delete', id: 'project-a' };
  const cascaded = change(state, projectAction);
  assert.deepEqual(cascaded, applyAction(state, projectAction));
  assert.equal(cascaded.tasks.length, 2);
  assert.equal(cascaded.projects.length, 1);
  assert.deepEqual(cascaded.plans, { '2026-09-07': [], '2026-09-08': [] });
  assert.deepEqual(cascaded.tasks, state.tasks.filter(t => t.projectId === 'project-b'));
  const empty = { ...state, tasks: [], plans: {} };
  assert.deepEqual(change(empty, { type: 'project.delete', id: 'project-a' }), applyAction(empty, { type: 'project.delete', id: 'project-a' }));
  assert.throws(() => change(state, { type: 'task.delete', id: 'missing' }), /任务不存在/);
});

test('project editing shares UI/API behavior without changing tasks or plans', async () => {
  const { change } = await import('../public/model.js');
  const state = fixtureState();
  state.plans['2026-09-07'] = ['task-1'];
  const action = { type: 'project.update', id: 'project-a', name: ' 更名项目 ', path: ' /tmp/renamed ' };
  const result = change(state, action);
  assert.deepEqual(result, applyAction(state, action));
  assert.equal(result.projects[0].name, '更名项目');
  assert.equal(result.projects[0].path, '/tmp/renamed');
  assert.deepEqual(result.tasks, state.tasks);
  assert.deepEqual(result.plans, state.plans);
  assert.throws(() => change(state, { ...action, name: '  ' }));
});


test('unified task API and new CLI query preserve legacy state views and read-only versions', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'daylight-task-query-'));
  const state=fixtureState(); state.tasks[0].status='done';state.tasks[0].completedAt='2026-10-01T00:00:00Z';state.tasks[7].projectId=null;state.plans['2026-10-01']=['task-2','task-1'];
  await writeFile(path.join(dir,'state.json'),JSON.stringify({version:0,state}));
  const server=await createWorkbench({dataDir:dir});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await server.closeProxy();await new Promise(r=>{server.close(r);server.closeAllConnections();});await rm(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}`, token=(await readFile(path.join(dir,'agent-token'),'utf8')).trim();
  const get=async route=>{const r=await fetch(url+route,{headers:{Authorization:'Bearer '+token}});return {status:r.status,...await r.json()};};
  assert.equal((await fetch(url+'/api/v1/tasks')).status,401);
  const today=await get('/api/v1/tasks?scope=today&status=open&day=2026-10-01');
  assert.deepEqual(today.counts,{open:1,done:1,total:2}); assert.deepEqual(today.tasks.map(t=>t.id),['task-2']);
  assert.equal((await get('/api/v1/tasks?projectId=missing')).status,404);
  assert.equal((await get('/api/v1/tasks?day=2026-02-30')).status,400);
  assert.equal((await get('/api/v1/tasks?status=invalid')).status,400);
  assert.equal((await get('/api/v1/capabilities')).taskQuery.path,'/api/v1/tasks');
  const cli=async(...args)=>JSON.parse((await run('python3',[client,'--url',url,'--data-dir',dir,...args])).stdout);
  assert.equal((await cli('tasks','--unassigned','--status','open')).tasks[0].id,'task-8');
  assert.equal((await cli('state','--view','all')).matchingTasks.length,8);
  assert.deepEqual((await cli('state','--view','today','--date','2026-10-01')).matchingTasks.map(t=>t.id),['task-2','task-1']);
  assert.equal((await get('/api/v1/state')).version,0);
});
