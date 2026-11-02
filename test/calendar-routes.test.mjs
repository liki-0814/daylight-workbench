import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarRoute, focusRoute, parseRoute } from '../public/routes.js';
import { shiftCalendarMonth, shiftCalendarDay } from '../public/components/calendar-grid.js';
import { taskRangeTabs } from '../public/components/task-range-tabs.js';
const state = { projects: [{ id: 'calendar' }], tasks: [{ id: 't1' }] };
test('calendar links open the task list instead of a calendar page', () => {
  const route = parseRoute(calendarRoute({ month: '2026-10', selectedDay: '2026-10-06', status: 'all', projectId: 'calendar', query: '任务 & API' }), state);
  assert.equal(route.page, 'task');
  assert.equal(route.view, 'all');
  assert.equal(route.query, '任务 & API');
  assert.equal(parseRoute('#project=calendar', state).view, 'project:calendar');
  assert.equal(parseRoute('#calendar&month=2026-02&date=2026-02-30', state).view, 'all');
  const tabs = taskRangeTabs({ view: 'calendar' });
  assert.equal((tabs.match(/data-view=/g) || []).length, 2);
  assert.match(tabs, /data-view="all"[^>]*aria-current="page"/);
  assert.match(tabs, /data-view="today"/);
  assert.doesNotMatch(tabs, /data-view="calendar"|日历/);
});
test('calendar month navigation clamps month ends including leap year', () => {
  assert.equal(shiftCalendarMonth('2026-01-31', 1), '2026-02-28');
  assert.equal(shiftCalendarMonth('2024-01-31', 1), '2024-02-29');
  assert.equal(shiftCalendarMonth('2026-12-31', 1), '2027-01-31');
});
test('calendar month and keyboard navigation clamp valid civil boundaries without looping', () => {
  assert.equal(shiftCalendarMonth('0001-01-31', -1), '0001-01-31');
  assert.equal(shiftCalendarMonth('9999-12-31', 1), '9999-12-31');
  assert.equal(shiftCalendarMonth('9999-11-30', 1), '9999-12-30');
  assert.equal(shiftCalendarMonth('2026-10-07', 1000000), '9999-12-07');
  assert.equal(shiftCalendarMonth('2026-10-07', -1000000), '0001-01-07');
  assert.equal(shiftCalendarDay('0001-01-01', -7), '0001-01-01');
  assert.equal(shiftCalendarDay('9999-12-31', 7), '9999-12-31');
  assert.equal(parseRoute('#calendar&month=9999-12', state).view, 'all');
  for (const delta of [NaN, Infinity, 1.5]) assert.throws(() => shiftCalendarMonth('2026-10-07', delta));
  assert.throws(() => shiftCalendarMonth('0000-01-01', 1));
});
test('focus route preserves task and statistics filters', () => {
  const result = parseRoute(focusRoute({ from: '2026-10-01', to: '2026-10-06', taskId: 't1', unassigned: true }), state);
  assert.equal(result.page, 'focus'); assert.equal(result.taskId, 't1'); assert.equal(result.unassigned, true);
});
