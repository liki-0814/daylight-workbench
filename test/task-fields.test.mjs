import test from 'node:test';
import assert from 'node:assert/strict';
import { change, initialState, validate, taskSeqs, taskCode } from '../public/model.js';
import { applyAction } from '../agent-api.mjs';

const day = '2026-10-31';
const base = () => change(initialState(), { type: 'add', id: 'a', title: '旧任务', projectId: null }, day);

test('新任务可带 priority / due / estimate，并拿到稳定编号 seq', () => {
  let state = change(base(), { type: 'add', id: 'b', title: '新', projectId: null, priority: 'high', due: '2026-11-03', estimate: 45 }, day);
  const b = state.tasks.find(t => t.id === 'b');
  assert.deepEqual([b.priority, b.due, b.estimate, b.seq], ['high', '2026-11-03', 45, 2]);
  state = change(state, { type: 'task.delete', id: 'a' }, day);
  state = change(state, { type: 'add', id: 'c', title: '再新', projectId: null }, day);
  assert.equal(state.tasks.find(t => t.id === 'c').seq, 3, '删除任务后编号不回收');
  assert.equal(taskCode(3), 'DL-03');
});

test('旧任务没有 seq 时按顺序给展示编号；只有新增才把 seq 落盘', () => {
  const legacy = validate({ schema: 1, projects: [], plans: {}, tasks: ['x', 'y'].map(id => ({ id, title: id, notes: '', projectId: null, status: 'todo', completedAt: null })) });
  assert.deepEqual(taskSeqs(legacy.tasks), [1, 2]);
  const touched = change(legacy, { type: 'edit', id: 'x', title: 'x2', projectId: null, notes: '' }, day);
  assert.ok(touched.tasks.every(t => t.seq === undefined), '编辑不改旧数据形状');
  const added = change(legacy, { type: 'add', id: 'z', title: 'z', projectId: null }, day);
  assert.deepEqual(added.tasks.map(t => t.seq), [1, 2, 3]);
});

test('新建时 status=active：其他进行中任务退回待办，并加入今天', () => {
  let state = change(base(), { type: 'start', id: 'a' }, day);
  state = change(state, { type: 'add', id: 'b', title: 'b', projectId: null, status: 'active' }, day);
  assert.deepEqual(state.tasks.map(t => t.status), ['todo', 'active']);
  assert.ok(state.plans[day].includes('b'));
  assert.throws(() => change(state, { type: 'add', id: 'c', title: 'c', projectId: null, status: 'done' }, day), /状态/);
});

test('非法 priority / due / estimate 被拒绝（API 与 UI 同一套校验）', () => {
  const bad = patch => () => change(base(), { type: 'add', id: 'q', title: 'q', projectId: null, ...patch }, day);
  assert.throws(bad({ priority: 'urgent' }), /数据格式/);
  assert.throws(bad({ due: '2026-02-31' }), /数据格式/);
  assert.throws(bad({ estimate: 0 }), /数据格式/);
  assert.throws(bad({ estimate: 1.5 }), /数据格式/);
  assert.throws(bad({ estimate: 6000 }), /数据格式/);
});

test('task.create / task.update 经 agent API 透传新字段；due:null 清除', () => {
  let state = applyAction(initialState(), { type: 'task.create', id: 'a', title: 'a', priority: 'low', due: '2026-11-05', estimate: 30, status: 'active' }, day);
  assert.equal(state.tasks[0].status, 'active');
  state = applyAction(state, { type: 'task.update', id: 'a', priority: 'high', due: null }, day);
  assert.equal(state.tasks[0].priority, 'high');
  assert.equal(state.tasks[0].due, undefined);
  assert.equal(state.tasks[0].estimate, 30, '没提到的字段保持不变');
  assert.throws(() => applyAction(state, { type: 'task.create', title: 'b', planDay: day, bogus: 1 }, day), /未知字段/);
});
