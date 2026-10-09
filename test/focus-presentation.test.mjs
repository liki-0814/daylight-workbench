import test from 'node:test';
import assert from 'node:assert/strict';
import { durationText, timerText, statisticsToday, canResumeFocus, focusNotificationFeedback } from '../public/focus/presentation.js';
test('duration preserves positive subsecond records while zero stays zero', () => {
  assert.equal(durationText(0), '0 秒'); assert.equal(durationText(1), '不到 1 秒'); assert.equal(durationText(999), '不到 1 秒'); assert.equal(durationText(1000), '1 秒'); assert.equal(durationText(60000), '1 分钟'); assert.equal(durationText(3720000), '1 小时 2 分钟');
});
test('timer rounds remaining seconds up and statistics today follows its fixed time zone', () => {
  assert.equal(timerText(1), '00:01'); assert.equal(timerText(60001), '01:01'); assert.equal(timerText(-1), '00:00');
  assert.equal(statisticsToday({ serverNow: Date.parse('2026-10-05T17:00:00Z'), settings: { statisticsTimeZone: 'Asia/Shanghai' } }), '2026-10-06');
});

test('frozen sessions become resumable at the trusted boundary only with remaining work', () => {
  const snapshot = { current: { status: 'paused', remainingMs: 60000, clockIssue: { frozenAt: 100000 } }, displayNow: 99999 };
  assert.equal(canResumeFocus(snapshot), false);
  assert.equal(canResumeFocus({ ...snapshot, displayNow: 100000 }), true);
  assert.equal(canResumeFocus({ ...snapshot, displayNow: 100001, current: { ...snapshot.current, remainingMs: 0 } }), false);
  assert.equal(canResumeFocus({ current: { status: 'paused', remainingMs: 1 } }), true);
  assert.equal(canResumeFocus({ current: { status: 'running', remainingMs: 1 } }), false);
});

test('delivery failures remain separate from authorization and never claim a scheduled reminder was received', () => {
  const failed = { lastOutcome: { notification: { state: 'failed' } }, runtime: { notificationPermission: 'granted' } };
  assert.match(focusNotificationFeedback(failed).message, /记录已保存.*发送失败/);
  assert.equal(focusNotificationFeedback(failed).details, '');
  const error = '<img src=x onerror=alert(1)> OS failure';
  assert.equal(focusNotificationFeedback({ ...failed, runtime: { notificationError: error } }).details, error);
  assert.equal(focusNotificationFeedback({ lastOutcome: { notification: { state: 'scheduled' } }, runtime: { notificationPermission: 'granted' } }), null);
  assert.equal(focusNotificationFeedback({ runtime: { notificationPermission: 'denied' } }), null);
  for (const state of ['none', 'pending', 'scheduled']) assert.equal(focusNotificationFeedback({ lastOutcome: { notification: { state } }, runtime: { notificationError: error } }), null);
  assert.equal(focusNotificationFeedback({ runtime: { notificationError: error } }), null);
  assert.equal(focusNotificationFeedback({}), null);
});
