import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, writeFile, rm, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createFocusService } from '../focus/service.mjs';
import { createFocusStore } from '../focus/store.mjs';
import { fixtureState } from './fixtures.mjs';

async function invoke(service, route, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]); req.method = body === undefined ? 'GET' : 'POST'; req.url = `/api/focus/${route}`;
  let code, value; const headers = {};
  await service.handle(req, { setHeader(key, data) { headers[key] = data; }, writeHead(status) { code = status; }, end(data) { value = JSON.parse(data); } });
  return { code, value, headers };
}
const base = Date.parse('2026-10-06T10:00:00Z');
async function fixture(options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'daylight-focus-service-'));
  let time = base, mono = 0, tasks = { version: 7, state: fixtureState() }, taskWriting = false;
  const settings = { dataDir, getTaskSnapshot: () => tasks, isTaskWriting: () => taskWriting, clock: { now: () => time, monotonic: () => mono }, ...options };
  let service = await createFocusService(settings);
  return { dataDir, get service() { return service; }, async restart() { await service.close(); service = await createFocusService(settings); }, move(ms) { time += ms; mono += ms; }, rollback(wallDelta, monotonicDelta) { time += wallDelta; mono += monotonicDelta; }, set tasks(value) { tasks = value; }, get tasks() { return tasks; }, set writing(value) { taskWriting = value; }, async close() { await service.close(); await rm(dataDir, { recursive: true, force: true }); } };
}
const request = (expectedVersion = 0) => ({ requestId: 'focus-original-request', expectedVersion, expectedTaskVersion: 7, action: { type: 'focus.start', phase: 'work', taskId: 'task-1', durationSeconds: 60 } });

test('real focus file persists receipts across restart and stays independent of task state', async () => {
  const f = await fixture();
  try {
    const first = await invoke(f.service, 'actions', request()); assert.equal(first.code, 200); assert.equal(first.value.current.taskId, 'task-1');
    assert.ok(first.value.runtime.historyBytes > 0); assert.equal(first.value.runtime.largeHistory, false);
    assert.equal((await stat(path.join(f.dataDir, 'focus.json'))).mode & 0o777, 0o600);
    assert.equal((await invoke(f.service, 'state')).value.sessions, undefined);
    await f.restart();
    const replay = await invoke(f.service, 'actions', request()); assert.equal(replay.code, 200); assert.equal(replay.value.replayed, true); assert.equal(replay.value.current.id, first.value.current.id);
    const exported = await invoke(f.service, 'export'); assert.equal(exported.value.receipts, undefined); assert.equal(exported.value.current.id, first.value.current.id);
    assert.equal(f.tasks.state.tasks[0].status, 'todo');
  } finally { await f.close(); }
});

test('read reconciliation durably archives once; stale action rejects after committed system transition', async () => {
  const f = await fixture();
  try {
    const started = await invoke(f.service, 'actions', request()); f.move(120000);
    const stale = await invoke(f.service, 'actions', { requestId: 'pause-after-deadline', expectedVersion: 1, action: { type: 'focus.pause', sessionId: started.value.current.id } });
    assert.equal(stale.code, 409); assert.equal(stale.value.version, 2);
    const snapshot = await f.service.snapshot(); assert.equal(snapshot.current, null); assert.equal(snapshot.lastOutcome.endReason, 'completed');
    await f.restart(); assert.equal(f.service.record.sessions.length, 1);
    assert.equal((await f.service.consumeNotification(snapshot.lastOutcome.id)).notification.state, 'attempted');
    assert.equal(await f.service.consumeNotification(snapshot.lastOutcome.id), null);
  } finally { await f.close(); }
});

test('task hook failures retain captured termination context; task undo never revives focus', async () => {
  let fail = false;
  const f = await fixture({ storeFactory: async opts => { const store = await createFocusStore(opts); return { get record() { return store.record; }, async save(next) { if (fail) throw new Error('injected-save-failure'); return store.save(next); } }; } });
  try {
    await invoke(f.service, 'actions', { ...request(), action: { ...request().action, durationSeconds: 1500 } }); f.move(300000);
    const done = structuredClone(f.tasks.state); done.tasks[0].status = 'done'; done.tasks[0].completedAt = new Date(base + 300000).toISOString();
    fail = true; f.tasks = { version: 8, state: done };
    const warnings = await f.service.reconcileTasks({ ...f.tasks, committedAt: base + 300000 }); assert.equal(warnings[0].code, 'FOCUS_RECONCILE_PENDING');
    // A later undo restores the task while the original captured event still must be honored.
    f.tasks = { version: 9, state: fixtureState() }; fail = false;
    await f.service.reconcileTasks({ ...f.tasks, committedAt: base + 360000 });
    assert.equal(f.service.record.current, null); assert.equal(f.service.record.sessions[0].endedAt, base + 300000); assert.equal(f.service.record.sessions[0].endReason, 'task_completed');
  } finally { await f.close(); }
});

test('failed expiry save exposes pending state without notification and retries same archive', async () => {
  let fail = false;
  const f = await fixture({ storeFactory: async opts => { const store = await createFocusStore(opts); return { get record() { return store.record; }, async save(next) { if (fail) throw new Error('injected-save-failure'); return store.save(next); } }; } });
  try {
    await invoke(f.service, 'actions', request()); f.move(120000); fail = true;
    const pending = await invoke(f.service, 'state'); assert.equal(pending.code, 200); assert.equal(pending.value.current.remainingMs, 0); assert.equal(pending.value.lastOutcome, null); assert.equal(pending.value.warnings[0].code, 'FOCUS_RECONCILE_PENDING');
    fail = false; const ended = await invoke(f.service, 'state'); assert.equal(ended.value.current, null); assert.equal(f.service.record.sessions.length, 1);
  } finally { await f.close(); }
});

test('durable IO failure returns the shared business error and keeps the original request retryable', async () => {
  const f = await fixture();
  try {
    const previous = path.join(f.dataDir, 'focus.previous.json');
    await mkdir(previous);
    const failed = await invoke(f.service, 'actions', request());
    assert.equal(failed.code, 503);
    assert.equal(failed.value.code, 'FOCUS_SAVE_FAILED');
    assert.equal(failed.value.version, 0);
    assert.doesNotMatch(failed.value.error, /EISDIR|focus\.previous|daylight-focus-service|\//);
    assert.equal(f.service.record.current, null);
    assert.equal(f.service.record.receipts.length, 0);
    await rm(previous, { recursive: true });
    const applied = await invoke(f.service, 'actions', request());
    assert.equal(applied.code, 200);
    assert.equal(applied.value.replayed, false);
    assert.equal((await invoke(f.service, 'actions', request())).value.replayed, true);
    assert.equal(f.service.record.version, 1);
  } finally { await f.close(); }
});

test('monotonic drift detects rollback despite wall time still increasing; strict query and task locks', async () => {
  const f = await fixture();
  try {
    f.writing = true; assert.equal((await invoke(f.service, 'actions', request())).value.code, 'TASK_WRITE_IN_PROGRESS'); f.writing = false;
    await invoke(f.service, 'actions', { ...request(), action: { ...request().action, durationSeconds: 1500 } });
    f.rollback(30000, 60000); const frozen = await invoke(f.service, 'state'); assert.equal(frozen.value.current.clockIssue.code, 'CLOCK_CHANGED');
    assert.equal((await invoke(f.service, 'state?x=1')).code, 400); assert.equal((await invoke(f.service, 'sessions?limit=1&limit=1')).code, 400);
  } finally { await f.close(); }
});

test('damaged focus file is not overwritten and only focus APIs degrade', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.dataDir, 'focus.json'), '{corrupt'); await f.restart();
    const response = await invoke(f.service, 'state'); assert.equal(response.code, 503); assert.equal(response.value.code, 'FOCUS_UNAVAILABLE');
    assert.equal(await readFile(path.join(f.dataDir, 'focus.json'), 'utf8'), '{corrupt'); assert.equal(f.tasks.state.tasks.length, 8);
  } finally { await f.close(); }
});

test('unknown persisted statistics zone disables focus without replacing file', async () => {
  const f = await fixture();
  try {
    const record = f.service.record; await writeFile(path.join(f.dataDir, 'focus.json'), JSON.stringify({ ...record, settings: { ...record.settings, statisticsTimeZone: 'Bogus' } })); await f.restart();
    assert.equal((await invoke(f.service, 'state')).code, 503);
    assert.equal(JSON.parse(await readFile(path.join(f.dataDir, 'focus.json'), 'utf8')).settings.statisticsTimeZone, 'Bogus');
  } finally { await f.close(); }
});

test('HTTP and programmatic notification diagnostics include contiguous store CPU work', async () => {
  const diagnostics = [];
  const f = await fixture({ diagnostics: value => diagnostics.push(value), storeFactory: async options => {
    const store = await createFocusStore(options);
    return {
      get record() { return store.record; },
      // A previous save timing must never substitute for this operation's CPU.
      get lastTimings() { return { encodeMs: 99999 }; },
      async save(next) { options.onSynchronousWork(300); options.onSynchronousWork(300); return store.save(next); },
    };
  } });
  try {
    const started = await invoke(f.service, 'actions', request());
    assert.ok(Number(started.headers['X-Daylight-Queue-Ms']) >= 600);
    assert.ok(Number(started.headers['X-Daylight-Queue-Ms']) < 99999);
    f.move(120000);
    const ended = await invoke(f.service, 'state');
    await new Promise(resolve => setImmediate(resolve));
    await f.service.consumeNotification(ended.value.lastOutcome.id);
    const consumed = diagnostics.find(value => value.operation === 'notification');
    assert.equal(consumed.focusDiagnostics, true);
    assert.ok(consumed.queueMs >= 600);
    assert.ok(consumed.queueMs < 99999);
  } finally { await f.close(); }
});
