import test from 'node:test';
import assert from 'node:assert/strict';
import { initialFocusRecord, validateFocusRecord, focusSnapshot, applyFocusAction, reconcileFocus, consumeFocusNotification } from '../core/focus-model.js';
import { prepareFocusWrite, prepareFocusAction } from '../core/focus-write.js';
import { fixtureState } from './fixtures.mjs';

const base = Date.parse('2026-10-06T10:00:00Z');
const state = fixtureState();
const context = (minutes = 0, extra = {}) => ({ now: base + minutes * 60000, taskState: state, taskVersion: 7, sessionId: 'session-one', ...extra });
const start = () => applyFocusAction(initialFocusRecord({ timeZone: 'UTC' }), { type: 'focus.start', phase: 'work', taskId: 'task-1' }, context()).nextRecord;

test('pause excludes idle time, resume uses remainder and expiry caps one round', () => {
  let record = start();
  record = applyFocusAction(record, { type: 'focus.pause', sessionId: 'session-one' }, context(5)).nextRecord;
  assert.equal(record.current.remainingMs, 20 * 60000);
  record = applyFocusAction(record, { type: 'focus.resume', sessionId: 'session-one' }, context(60)).nextRecord;
  assert.equal(record.current.deadlineAt, base + 80 * 60000);
  record = reconcileFocus(record, context(180)).nextRecord;
  assert.equal(record.current, null); assert.equal(record.sessions.length, 1); assert.equal(record.sessions[0].endedAt, base + 80 * 60000);
  assert.equal(record.sessions[0].segments.reduce((v, s) => v + s.endAt - s.startAt, 0), 25 * 60000);
  assert.equal(record.lastOutcome.notification.state, 'pending'); validateFocusRecord(record);
});

test('task completion and recovery use earliest valid termination, unknown deletion keeps only closed work', () => {
  const done = structuredClone(state); done.tasks[0].status = 'done'; done.tasks[0].completedAt = new Date(base + 5 * 60000).toISOString();
  const completed = reconcileFocus(start(), context(30, { taskState: done, recovering: true })).nextRecord.sessions[0];
  assert.equal(completed.endReason, 'task_completed'); assert.equal(completed.endedAt - base, 5 * 60000);
  done.tasks[0].completedAt = new Date(base + 30 * 60000).toISOString();
  assert.equal(reconcileFocus(start(), context(30, { taskState: done, recovering: true })).nextRecord.sessions[0].endReason, 'completed');
  const deleted = { ...state, tasks: state.tasks.slice(1) };
  let record = applyFocusAction(start(), { type: 'focus.pause', sessionId: 'session-one' }, context(5)).nextRecord;
  record = applyFocusAction(record, { type: 'focus.resume', sessionId: 'session-one' }, context(10)).nextRecord;
  const recovered = reconcileFocus(record, context(60, { taskState: deleted, recovering: true })).nextRecord.sessions[0];
  assert.equal(recovered.endReason, 'recovery_task_invalid'); assert.equal(recovered.timeQuality, 'recovery_uncertain'); assert.equal(recovered.endedAt, base + 5 * 60000);
  assert.equal(recovered.segments.reduce((v, s) => v + s.endAt - s.startAt, 0), 5 * 60000);
});

test('rollback freezes trusted boundary, allows finish and prevents bypass by start', () => {
  const record = reconcileFocus(start(), context(-5, { clockCheck: { changed: true, lastTrustedAt: base + 10 * 60000 } })).nextRecord;
  assert.equal(record.current.status, 'paused'); assert.equal(record.current.clockIssue.frozenAt, base + 10 * 60000); assert.equal(record.current.remainingMs, 15 * 60000);
  assert.throws(() => applyFocusAction(record, { type: 'focus.resume', sessionId: 'session-one' }, context(-5)), { code: 'CLOCK_CHANGED' });
  const ended = applyFocusAction(record, { type: 'focus.finish', sessionId: 'session-one' }, context(-5)).nextRecord;
  assert.equal(ended.sessions[0].endedAt, base + 10 * 60000); validateFocusRecord(ended);
  assert.throws(() => applyFocusAction(ended, { type: 'focus.start', phase: 'work', taskId: 'task-1' }, context(-5)), { code: 'CLOCK_CHANGED' });
  const resumed = applyFocusAction(record, { type: 'focus.resume', sessionId: 'session-one' }, context(10)).nextRecord;
  assert.equal(resumed.current.clockIssue, null); assert.equal(resumed.current.timeQuality, 'clock_changed');
});

test('trusted task event before freeze survives rollback-now and clips at original completion', () => {
  const done = structuredClone(state); done.tasks[0].status = 'done'; done.tasks[0].completedAt = new Date(base + 5 * 60000).toISOString();
  const record = reconcileFocus(start(), context(-5, { taskState: done, taskCommittedAt: base + 5 * 60000, clockCheck: { changed: true, lastTrustedAt: base + 10 * 60000 } })).nextRecord;
  assert.equal(record.sessions[0].endedAt, base + 5 * 60000); assert.equal(record.sessions[0].timeQuality, 'clock_changed');
  assert.equal(record.sessions[0].segments[0].endAt, base + 5 * 60000); validateFocusRecord(record);
});

test('reboot rollback closes unknown open interval without inventing elapsed work', () => {
  const record = reconcileFocus(start(), context(-5, { recovering: true })).nextRecord;
  assert.equal(record.current.remainingMs, 1500000); assert.equal(record.current.segments[0].startAt, record.current.segments[0].endAt);
  validateFocusRecord(record);
});

test('receipts replay original operation before stale version, expiry and clock conflicts', () => {
  const request = { requestId: 'focus-request-one', expectedVersion: 0, expectedTaskVersion: 7, expiresAt: base + 60000, action: { type: 'focus.start', phase: 'work', taskId: 'task-1' } };
  const first = prepareFocusWrite(initialFocusRecord({ timeZone: 'UTC' }), request, 'sha', context());
  assert.equal(first.code, 200); validateFocusRecord(first.nextRecord);
  const expired = prepareFocusWrite(first.nextRecord, request, 'sha', context(120));
  assert.equal(expired.code, 200); assert.equal(expired.value.replayed, true); assert.equal(expired.value.appliedVersion, 1);
  assert.equal(prepareFocusWrite(first.nextRecord, request, 'different', context()).value.code, 'REQUEST_ID_REUSED');
  const modified = { ...request, requestId: 'new-request-id', expectedVersion: 1, expectedTaskVersion: 8 };
  assert.equal(prepareFocusWrite(first.nextRecord, modified, 'new', context()).value.code, 'TASK_VERSION_CHANGED');
});

test('prepare is side effect free; settings omit expiry; notification consumption is durable intent only', () => {
  const record = start(), before = JSON.stringify(record);
  const preview = prepareFocusAction(record, { action: { type: 'focus.pause', sessionId: 'session-one' } }, context(5));
  assert.equal(preview.expiresAt, base + 15 * 60000); assert.equal(JSON.stringify(record), before);
  assert.equal(prepareFocusAction(record, { action: { type: 'focus.settings', settings: { workSeconds: 3000 } } }, context()).expiresAt, undefined);
  const archived = reconcileFocus(record, context(30)).nextRecord;
  const consumed = consumeFocusNotification(archived, 'session-one', context(30));
  assert.equal(consumed.nextRecord.lastOutcome.notification.state, 'attempted'); assert.equal(consumeFocusNotification(consumed.nextRecord, 'session-one', context(30)).changed, false);
  const disabled = applyFocusAction(archived, { type: 'focus.settings', settings: { notificationsEnabled: false } }, context(30)).nextRecord;
  assert.equal(disabled.lastOutcome.notification.state, 'none'); assert.equal(disabled.sessions[0].targetMs, 1500000);
});

test('schema validation rejects invalid open/history intervals and unsupported actions', () => {
  const invalid = start(); invalid.current.segments[0].endAt = base - 1;
  assert.throws(() => validateFocusRecord(invalid), { code: 'FOCUS_UNAVAILABLE' });
  assert.throws(() => applyFocusAction(start(), { type: 'focus.start', phase: 'work', taskId: 'task-1', elapsedMs: 1000 }, context()));
  const snapshot = focusSnapshot(start(), context(5)); assert.equal(snapshot.current.segments, undefined); assert.equal(snapshot.sessions, undefined); assert.equal(snapshot.receipts, undefined);
});
