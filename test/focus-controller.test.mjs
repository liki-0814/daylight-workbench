import test from 'node:test';
import assert from 'node:assert/strict';
import { createFocusController } from '../public/focus/controller.js';
const state = (version, current = null) => ({ version, taskVersion: 5, serverNow: 1000, settings: {}, current, lastOutcome: null });
test('controller estimates remaining with monotonic time and performs no ticker writes', async () => {
  let now = 0, reads = 0;
  const page = new EventTarget(); page.hidden = false;
  const controller = createFocusController({ client: { state: async () => { reads++; return state(1, { id: 'session-1', status: 'running', deadlineAt: 61000, remainingMs: 60000 }); } }, document: page, window: new EventTarget(), monotonic: () => now, pollMs: 100000, tickMs: 100000 });
  await controller.refresh(); now = 5000; assert.equal(controller.getSnapshot().current.remainingMs, 55000); assert.equal(reads, 1); controller.dispose();
});
test('late state responses cannot revive a session after a newer action', async () => {
  let resolveRead, read = 0;
  const page = new EventTarget(); page.hidden = true;
  const controller = createFocusController({ client: { state: async () => { read++; return read === 1 ? state(1, { id: 'session-1', status: 'running', deadlineAt: 61000 }) : new Promise(resolve => resolveRead = resolve); }, act: async () => state(2) }, document: page, window: new EventTarget(), uuid: () => 'request-1' });
  await controller.refresh(); const refresh = controller.refresh(); const action = controller.act({ type: 'focus.finish', sessionId: 'session-1' }); await action; resolveRead(state(1, { id: 'session-1', status: 'running', deadlineAt: 61000 })); await refresh;
  assert.equal(controller.getSnapshot().version, 2); assert.equal(controller.getSnapshot().current, null); controller.dispose();
});
test('unknown focus action permits only exact original request retry', async () => {
  const page = new EventTarget(); page.hidden = true; const bodies = []; let attempt = 0;
  const controller = createFocusController({ client: { state: async () => state(1), act: async body => { bodies.push(body); if (!attempt++) throw new Error('dropped'); return state(2); } }, document: page, window: new EventTarget(), uuid: () => 'request-1' });
  await controller.refresh(); await assert.rejects(controller.act({ type: 'focus.start', phase: 'work', taskId: 't1' }, { taskVersion: 8 }), /待核对/);
  await assert.rejects(controller.act({ type: 'focus.start', phase: 'work', taskId: 't1' }), /先重试原请求/); await controller.retry();
  assert.equal(bodies[0], bodies[1]); assert.equal(JSON.parse(bodies[0]).expectedTaskVersion, 8); controller.dispose();
});
test('focus/visibility refresh shares one in-flight read and hidden pages stop polling', async () => {
  const page = new EventTarget(); page.hidden = true; const host = new EventTarget(); let reads = 0, resolveRead;
  const controller = createFocusController({ client: { state: () => { reads++; return new Promise(resolve => resolveRead = resolve); } }, document: page, window: host, pollMs: 5, tickMs: 5 });
  assert.equal(reads, 0); page.hidden = false; page.dispatchEvent(new Event('visibilitychange')); host.dispatchEvent(new Event('focus')); host.dispatchEvent(new Event('focus'));
  assert.equal(reads, 1); page.hidden = true; page.dispatchEvent(new Event('visibilitychange')); resolveRead(state(1)); await controller.refresh();
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(reads, 1);
  controller.dispose(); host.dispatchEvent(new Event('focus')); assert.equal(reads, 1);
});
test('ticker reaching zero requests readback once and never writes a finish action', async () => {
  const page = new EventTarget(); page.hidden = false; let now = 0, reads = 0;
  const controller = createFocusController({ client: { state: async () => { reads++; return state(1, { id: 'session-1', status: 'running', deadlineAt: 2000, remainingMs: 1000 }); }, act: () => { throw new Error('ticker must not write'); } }, document: page, window: new EventTarget(), monotonic: () => now, pollMs: 100000, tickMs: 1 });
  await controller.refresh(); now = 2000; await new Promise(resolve => setTimeout(resolve, 12)); assert.equal(reads, 2); controller.dispose();
});
test('service restart refreshes only the credential before retrying a read', async () => {
  const page = new EventTarget(); page.hidden = true; let reads = 0, tokens = 0;
  const controller = createFocusController({ client: { state: async () => { if (!reads++) throw Object.assign(new Error('token rotated'), { status: 403 }); return state(1); }, act: () => { throw new Error('authentication readback must never write'); } }, getToken: async options => { assert.deepEqual(options, { refresh: true }); tokens++; }, document: page, window: new EventTarget() });
  await controller.refresh(); assert.equal(reads, 2); assert.equal(tokens, 1); assert.equal(controller.getSnapshot().degraded, false); controller.dispose();
});
