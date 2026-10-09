import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureState } from './fixtures.mjs';
import { calendarQuery } from '../core/calendar-query.js';
import { applyAction } from '../agent-api.mjs';
import { prepareTaskWrite } from '../core/task-write.js';

test('calendar query shares counts before status, ordered snapshot previews, and strict params', () => {
  const state = fixtureState(); state.plans['2026-10-06'] = ['task-2', 'task-1']; state.tasks[0].status = 'done';
  const result = calendarQuery(state, 17, { from: '2026-10-06', to: '2026-10-07', status: 'open', previewLimit: '1' });
  assert.deepEqual(result.days[0].counts, { open: 1, done: 1, total: 2 });
  assert.equal(result.days[0].preview[0].id, 'task-2'); assert.equal(result.days[0].preview[0].projectName, '测试项目 A');
  assert.deepEqual(result.days[1].counts, { open: 0, done: 0, total: 0 });
  assert.throws(() => calendarQuery(state, 1, [['from', '2026-10-06'], ['from', '2026-10-06'], ['to', '2026-10-07']]));
  assert.throws(() => calendarQuery(state, 1, { from: '2026-10-06', to: '2026-10-07', unassigned: '0' }));
});

test('reschedule merges target references preserving active/done, other plans and atomic errors', () => {
  const state = fixtureState(); state.tasks[0].status = 'active'; state.plans = { '2026-10-05': ['task-2', 'task-1'], '2026-10-06': ['task-1', 'task-3'], '2026-10-07': ['task-1'] };
  const moved = applyAction(state, { type: 'plan.reschedule', id: 'task-1', fromDay: '2026-10-05', toDay: '2026-10-06' }, '2026-10-06');
  assert.deepEqual(moved.plans, { '2026-10-05': ['task-2'], '2026-10-06': ['task-1', 'task-3'], '2026-10-07': ['task-1'] });
  assert.equal(moved.tasks[0].status, 'active');
  const preserved = applyAction(state, { type: 'plan.remove', id: 'task-1', preserveExecution: true }, '2026-10-05');
  assert.equal(preserved.tasks[0].status, 'active');
  assert.equal(applyAction(state, { type: 'plan.remove', id: 'task-1' }, '2026-10-05').tasks[0].status, 'todo');
  const record = { version: 1, state }, request = { requestId: 'calendar-move-1', expectedVersion: 1, action: { type: 'plan.reschedule', id: 'task-1', fromDay: '2026-10-04', toDay: '2026-10-06' } };
  const decision = prepareTaskWrite(record, request, 'fingerprint');
  assert.equal(decision.code, 409); assert.equal(decision.value.code, 'PLAN_REFERENCE_CHANGED'); assert.equal(decision.receipt, undefined);
  assert.throws(() => applyAction(state, { type: 'plan.reschedule', id: 'task-1', fromDay: '2026-10-05', toDay: '2026-10-05' }, '2026-10-06'), { code: 'SAME_DAY' });
});

test('new task planDay and per-action batch days commit once or fail wholly', () => {
  const state = fixtureState();
  const next = applyAction(state, { type: 'batch', actions: [{ type: 'task.create', id: 'new', title: '新任务', planDay: '2026-10-06' }, { type: 'plan.add', id: 'task-1', day: '2026-10-07' }] }, '2026-10-05');
  assert.deepEqual(next.plans, { '2026-10-06': ['new'], '2026-10-07': ['task-1'] });
  assert.throws(() => applyAction(state, { type: 'task.create', title: 'bad', planDay: '2026-10-06', today: true }, '2026-10-06'));
  assert.throws(() => applyAction(state, { type: 'task.delete', id: 'task-1', day: '2026-10-06' }, '2026-10-06'));
  assert.deepEqual(state.plans, {});
});
