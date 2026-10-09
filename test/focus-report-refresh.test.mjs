import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportRefresh } from '../public/focus/report-refresh.js';

test('reports stop periodic reads on hidden pages, paused work, breaks and disposal', async () => {
  const page = new EventTarget(); page.hidden = false;
  let snapshot = { version: 1, current: { phase: 'work', status: 'running' } }, reads = 0, hides = 0, serial = 0;
  const subscribers = new Set(), timers = new Map();
  const controller = { getSnapshot: () => snapshot, subscribe(callback) { subscribers.add(callback); callback({ snapshot }); return () => subscribers.delete(callback); } };
  const emit = (patch, tick = false) => { snapshot = { ...snapshot, ...patch }; for (const callback of subscribers) callback({ snapshot, tick }); };
  const lifecycle = createReportRefresh({ controller, visible: false, document: page, refresh: async () => { reads++; }, onHide: () => { hides++; }, setTimeout(callback, milliseconds) { assert.equal(milliseconds, 15000); const id = ++serial; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id) });
  assert.equal(reads, 0); assert.equal(timers.size, 0);
  lifecycle.setVisible(true); assert.equal(reads, 1); assert.equal(timers.size, 1);
  for (let i = 0; i < 20; i++) emit({}, true);
  assert.equal(reads, 1); assert.equal(timers.size, 1);
  const [id, callback] = [...timers][0]; timers.delete(id); await callback(); assert.equal(reads, 2); assert.equal(timers.size, 1);
  page.hidden = true; page.dispatchEvent(new Event('visibilitychange')); assert.equal(timers.size, 0); assert.equal(hides, 1);
  emit({ version: 2 }); assert.equal(reads, 2);
  page.hidden = false; page.dispatchEvent(new Event('visibilitychange')); assert.equal(reads, 3); assert.equal(timers.size, 1);
  emit({ version: 3, current: { phase: 'work', status: 'paused' } }); assert.equal(reads, 4); assert.equal(timers.size, 0);
  emit({ current: { phase: 'shortBreak', status: 'running' } }); assert.equal(timers.size, 0);
  emit({ current: { phase: 'work', status: 'running' }, degraded: true }); assert.equal(timers.size, 0);
  emit({ degraded: false }); assert.equal(timers.size, 1);
  lifecycle.setVisible(false); assert.equal(timers.size, 0); assert.equal(hides, 2);
  page.dispatchEvent(new Event('visibilitychange')); assert.equal(reads, 4);
  lifecycle.setVisible(true); assert.equal(reads, 5); assert.equal(timers.size, 1);
  lifecycle.dispose(); assert.equal(timers.size, 0); assert.equal(subscribers.size, 0);
  page.dispatchEvent(new Event('visibilitychange')); emit({ version: 4 }); assert.equal(reads, 5);
});

test('report selection keys refresh at midnight without creating a ticker request loop', () => {
  const page = new EventTarget(); page.hidden = false;
  let snapshot = { version: 1, day: '2026-10-06', current: null }, reads = 0, listener;
  const changes = [], controller = { getSnapshot: () => snapshot, subscribe(callback) { listener = callback; callback({ snapshot }); return () => { listener = null; }; } };
  const lifecycle = createReportRefresh({ controller, document: page, refresh: () => { reads++; }, getKey: value => `${value.version}:${value.day}`, onChange(value, previousKey) { changes.push([value.day, previousKey]); } });
  snapshot = { ...snapshot, day: '2026-10-07' }; listener({ snapshot, tick: true }); assert.equal(reads, 1);
  listener({ snapshot, tick: false }); assert.equal(reads, 2); assert.deepEqual(changes.at(-1), ['2026-10-07', '1:2026-10-06']);
  listener({ snapshot, tick: false }); assert.equal(reads, 2); lifecycle.dispose();
});
