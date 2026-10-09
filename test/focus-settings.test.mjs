import test from 'node:test';
import assert from 'node:assert/strict';
import { createFocusPermissionRefresh, focusPermissionError } from '../public/focus/settings.js';
test('permission visibility lifecycle only reads status on visible settings and cleans up', () => {
  const page = new EventTarget(); page.hidden = false; const host = new EventTarget(); let visible = false; const operations = [];
  const lifecycle = createFocusPermissionRefresh({ document: page, window: host, isVisible: () => visible, readPermission: op => operations.push(op) });
  host.dispatchEvent(new Event('focus')); page.dispatchEvent(new Event('visibilitychange')); assert.equal(operations.length, 0);
  visible = true; page.hidden = true; host.dispatchEvent(new Event('focus')); assert.equal(operations.length, 0);
  page.hidden = false; page.dispatchEvent(new Event('visibilitychange')); host.dispatchEvent(new Event('focus')); assert.deepEqual(operations, ['getStatus', 'getStatus']);
  lifecycle.dispose(); page.dispatchEvent(new Event('visibilitychange')); host.dispatchEvent(new Event('focus')); assert.equal(operations.length, 2);
});

test('system notification failures give a localized next step without guessing the cause', () => {
  assert.equal(focusPermissionError(new Error('Notifications are not allowed for this application'), 'authorize'), '系统暂不允许此应用发送通知。请检查系统通知设置，再刷新权限状态。');
  assert.equal(focusPermissionError(Object.assign(new Error('timeout'), { unknown: true }), 'authorize'), '授权结果待核对，请刷新权限状态。');
  assert.equal(focusPermissionError(new Error('unknown OS failure'), 'getStatus'), '暂时无法读取系统通知状态，请稍后刷新。');
  assert.equal(focusPermissionError(new Error('unknown OS failure'), 'openSettings'), '暂时无法打开系统通知设置，请稍后重试。');
});
