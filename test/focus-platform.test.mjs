import test from 'node:test';
import assert from 'node:assert/strict';
import { createFocusPlatform } from '../public/focus/platform.js';
function host() { const value = new EventTarget(), messages = []; value.webkit = { messageHandlers: { focusNotifications: { postMessage(data) { messages.push(data); } } } }; return { value, messages, reply(detail) { const event = new Event('daylight-focus-notification-reply'); event.detail = detail; value.dispatchEvent(event); } }; }
const granted = requestId => ({ requestId, ok: true, permission: 'granted', alertEnabled: true, soundEnabled: false });
test('native bridge correlates replies and ignores malformed or unrelated responses', async () => {
  const f = host(), platform = createFocusPlatform({ window: f.value, uuid: () => 'request-1' });
  const result = platform.getStatus(); assert.deepEqual(f.messages, [{ requestId: 'request-1', op: 'getStatus' }]);
  f.reply(granted('not-pending')); f.reply({ requestId: 'request-1', ok: true, permission: 'unexpected' }); f.reply(granted('request-1'));
  assert.equal((await result).permission, 'granted'); platform.dispose();
});
test('authorization requires a trusted click and settings reads never authorize', async () => {
  const f = host(), platform = createFocusPlatform({ window: f.value, uuid: () => 'request-2' });
  await assert.rejects(platform.authorize({ isTrusted: false }), /点击/); assert.equal(f.messages.length, 0);
  const result = platform.authorize({ isTrusted: true }); assert.equal(f.messages[0].op, 'authorize'); f.reply(granted('request-2')); await result; platform.dispose();
});
test('authorization timeout preserves uncertainty and dispose rejects pending calls', async () => {
  const f = host(), platform = createFocusPlatform({ window: f.value, uuid: () => 'request-3', timeouts: { authorize: 5, getStatus: 100, openSettings: 100 } });
  await assert.rejects(platform.authorize({ isTrusted: true }), /待核对/);
  const pending = platform.getStatus(); platform.dispose(); await assert.rejects(pending, /已关闭/);
});
test('ordinary browser has an explicit page-only fallback', async () => {
  const platform = createFocusPlatform({ window: new EventTarget() }); assert.equal(platform.isNative, false); assert.deepEqual(await platform.getStatus(), { permission: 'unavailable', alertEnabled: null, soundEnabled: null, mode: 'page-only' }); platform.dispose();
});
