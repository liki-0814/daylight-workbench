import test from 'node:test';
import assert from 'node:assert/strict';
import { initialFocusRecord, applyFocusAction, reconcileFocus } from '../core/focus-model.js';
import { focusStatistics, focusTaskSummary, focusSessionQuery } from '../core/focus-statistics.js';
import { validateFocusQuery } from '../core/focus-contracts.js';
import { dayWindows } from '../focus/time-zone.mjs';
import { fixtureState } from './fixtures.mjs';

const state = fixtureState(), start = Date.parse('2026-10-05T23:50:00Z');
const ctx = now => ({ now, taskState: state, taskVersion: 0, sessionId: 'cross-midnight' });
function record() {
  let value = applyFocusAction(initialFocusRecord({ timeZone: 'UTC' }), { type: 'focus.start', phase: 'work', taskId: 'task-1' }, ctx(start)).nextRecord;
  value = applyFocusAction(value, { type: 'focus.pause', sessionId: 'cross-midnight' }, ctx(start + 10 * 60000)).nextRecord;
  value = applyFocusAction(value, { type: 'focus.resume', sessionId: 'cross-midnight' }, ctx(start + 15 * 60000)).nextRecord;
  value = reconcileFocus(value, ctx(start + 40 * 60000)).nextRecord;
  return { ...value, version: 2 };
}

test('reports clip intervals, exclude pauses and attribute rounds to end day with immutable project snapshots', () => {
  const value = record(), selection = { from: '2026-10-05', to: '2026-10-06' }, now = start + 40 * 60000;
  const report = focusStatistics(value, selection, { now, dayWindows: dayWindows(selection.from, selection.to, 'UTC') });
  assert.equal(report.summary.workElapsedMs, 25 * 60000); assert.equal(report.summary.completedRounds, 1);
  assert.equal(report.daily[0].workElapsedMs, 10 * 60000); assert.equal(report.daily[0].completedRounds, 0);
  assert.equal(report.daily[1].workElapsedMs, 15 * 60000); assert.equal(report.daily[1].completedRounds, 1);
  assert.equal(report.projects[0].projectId, 'project-a'); assert.equal(report.projects[0].name, '测试项目 A');
  assert.equal(focusTaskSummary(value, 'task-1', { now, recentLimit: 1 }).summary.workElapsedMs, 25 * 60000);
});

test('sessions select intersection or end point, paginate and invalidate old-version cursors', () => {
  const value = record(); value.sessions = [...value.sessions, { ...value.sessions[0], id: 'another-session', startedAt: start + 86400000 }];
  const page = focusSessionQuery(value, { limit: 1 }, { now: start + 2 * 86400000 });
  assert.equal(page.sessions[0].id, 'another-session'); assert.equal(page.hasNext, true);
  const second = focusSessionQuery(value, { limit: 1, cursor: page.nextCursor }, { now: start + 2 * 86400000 });
  assert.equal(second.sessions[0].id, 'cross-midnight'); assert.equal(second.hasPrevious, true);
  assert.throws(() => focusSessionQuery({ ...value, version: 3 }, { limit: 1, cursor: page.nextCursor }, { now: start }), { code: 'CURSOR_STALE' });
  assert.throws(() => focusSessionQuery(value, { limit: 1, cursor: page.nextCursor, phase: 'shortBreak' }, { now: start }));
  const oneDay = focusSessionQuery(record(), { from: '2026-10-05', to: '2026-10-05' }, { now: start + 40 * 60000, dayWindows: dayWindows('2026-10-05', '2026-10-05', 'UTC') });
  assert.equal(oneDay.sessions.length, 1);
});

test('focus queries reject unknown, duplicate, ambiguous and oversized fields', () => {
  assert.throws(() => validateFocusQuery('state', [['unknown', '1']]));
  assert.throws(() => validateFocusQuery('sessions', [['limit', '1'], ['limit', '1']]));
  assert.throws(() => validateFocusQuery('statistics', { from: '2026-01-01', to: '2027-01-02' }));
  assert.throws(() => validateFocusQuery('sessions', { from: '2026-10-06' }));
  assert.throws(() => validateFocusQuery('sessions', { projectId: 'p', unassigned: '1' }));
  assert.throws(() => validateFocusQuery('sessions', { limit: '1.5' }));
  assert.equal(validateFocusQuery('sessions', [['limit', '100']]).limit, 100);
});

test('a current break contributes only break time without marking work metrics as including current', () => {
  const value = applyFocusAction(initialFocusRecord({ timeZone: 'UTC' }), { type: 'focus.start', phase: 'shortBreak' }, ctx(start)).nextRecord;
  const selection = { from: '2026-10-05', to: '2026-10-06' };
  const report = focusStatistics(value, selection, { now: start + 60000, dayWindows: dayWindows(selection.from, selection.to, 'UTC') });
  assert.equal(report.summary.workElapsedMs, 0); assert.equal(report.summary.breakElapsedMs, 60000); assert.equal(report.summary.includesCurrent, false);
});
