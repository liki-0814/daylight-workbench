import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createFocusStore } from './store.mjs';
import { createTimeZoneAdapter } from './time-zone.mjs';
import { createSynchronousWorkMeter } from './synchronous-work.mjs';
import { focusSnapshot, focusExport, reconcileFocus, consumeFocusNotification } from '../core/focus-model.js';
import { prepareFocusWrite, prepareFocusAction } from '../core/focus-write.js';
import { focusStatistics, focusTaskSummary, focusSessionQuery } from '../core/focus-statistics.js';
import { focusError, validateFocusQuery } from '../core/focus-contracts.js';

export async function createFocusService({ dataDir, getTaskSnapshot, isTaskWriting = () => false, clock = {}, timeZoneAdapter = createTimeZoneAdapter(), diagnostics, storeFactory = createFocusStore } = {}) {
  const now = typeof clock === 'function' ? clock : clock.now || Date.now;
  const monotonic = typeof clock === 'object' && clock.monotonic ? clock.monotonic : () => performance.now();
  const runtime = { mode: 'node', notifications: 'page-only', notificationPermission: 'unknown' };
  const listeners = new Set();
  let store, unavailable, closed = false, timer, queue = Promise.resolve(), pendingTaskContexts = [], lastTrustedAt = now(), lastWall = lastTrustedAt, lastMonotonic = monotonic(), retry = 0, pendingSave = null;
  const diagnostic = diagnostics || (process.env.WORKBENCH_FOCUS_DIAGNOSTICS === '1' ? value => process.stderr.write(`${JSON.stringify(value)}\n`) : undefined);
  const meter = diagnostic ? createSynchronousWorkMeter({ onBlock: queueMs => diagnostic({ focusDiagnostics: true, operation: 'synchronous-work', queueMs }) }) : null;
  const measured = fn => meter ? meter.measure(fn) : fn();
  const profiled = async (operation, fn) => {
    const scope = meter?.startScope();
    try { return await fn(); }
    finally { if (scope) diagnostic({ focusDiagnostics: true, operation, queueMs: scope.finish() }); }
  };
  try { store = await storeFactory({ dataDir, timeZone: timeZoneAdapter.systemTimeZone(), diagnostics: diagnostic, onSynchronousWork: meter ? duration => meter.add(duration) : undefined }); timeZoneAdapter.validateTimeZone?.(store.record.settings.statisticsTimeZone); }
  catch (error) { unavailable = error.message; store = null; }
  const serial = fn => { const operation = queue.then(fn); queue = operation.catch(() => {}); return operation; };
  const ensure = () => { if (!store) throw focusError(unavailable || '专注存储不可用', 'FOCUS_UNAVAILABLE', 503); };
  const saveRecord = async nextRecord => {
    try { await store.save(nextRecord); }
    catch { throw focusError('专注结果未能保存，请稍后核对并重试原请求', 'FOCUS_SAVE_FAILED', 503); }
  };
  const context = (tasks = getTaskSnapshot(), recovering = false) => {
    const wall = now(), mono = monotonic(), changed = wall - lastWall - (mono - lastMonotonic) < -5000;
    const value = { now: wall, taskVersion: tasks.version, taskState: tasks.state, taskCommittedAt: tasks.committedAt, recovering, runtime, clockCheck: { changed, lastTrustedAt } };
    if (!changed) lastTrustedAt = Math.max(lastTrustedAt, wall);
    lastWall = wall; lastMonotonic = mono;
    return value;
  };
  const snapshotValue = () => measured(() => { ensure(); return { ...focusSnapshot(store.record, { now: now(), taskVersion: getTaskSnapshot().version, runtime: { ...runtime, historyBytes: store.historyBytes ?? 0, largeHistory: (store.historyBytes ?? 0) > 10 * 1024 * 1024 } }), ...(pendingSave ? { warnings: [{ code: 'FOCUS_RECONCILE_PENDING', error: pendingSave }] } : {}) }; });
  const publish = reason => measured(() => { const snapshot = snapshotValue(); for (const listener of listeners) { try { listener({ snapshot, reason }); } catch {} } });
  const schedule = () => {
    clearTimeout(timer);
    if (closed || !store) return;
    const deadline = store.record.current?.status === 'running' ? store.record.current.deadlineAt : null;
    if (!pendingSave && deadline === null) return;
    const delay = pendingSave ? Math.min(30000, 1000 * 2 ** Math.min(retry, 5)) : Math.max(0, Math.min(2147483647, deadline - now()));
    timer = setTimeout(() => { void serial(() => profiled('deadline', async () => { try { await reconcile(); } catch {} finally { schedule(); } })); }, delay);
    timer.unref?.();
  };
  const saveTransition = async (transition, reason) => {
    if (!transition.changed) return false;
    await saveRecord({ ...transition.nextRecord, version: store.record.version + 1 });
    pendingSave = null; retry = 0; publish(reason); return true;
  };
  const reconcile = async (recovering = false) => {
    ensure();
    try {
      while (pendingTaskContexts.length) {
        const tasks = pendingTaskContexts[0];
        await saveTransition(measured(() => reconcileFocus(store.record, context(tasks, recovering))), 'terminal');
        pendingTaskContexts.shift();
      }
      await saveTransition(measured(() => reconcileFocus(store.record, context(getTaskSnapshot(), recovering))), 'terminal');
      pendingSave = null; retry = 0;
    } catch (error) { pendingSave = error.message; retry++; throw error; }
    finally { schedule(); }
  };
  if (store) { try { await reconcile(true); } catch {} }
  const service = {
    get lastTimings() { return store?.lastTimings; },
    get record() { return store?.record; },
    snapshot() { return serial(() => profiled('state', async () => { try { await reconcile(); } catch { ensure(); } return snapshotValue(); })); },
    reconcileTasks(tasks) {
      if (!store) return Promise.resolve([]);
      pendingTaskContexts.push({ ...tasks });
      return serial(() => profiled('task-reconcile', async () => { try { await reconcile(); return []; } catch { return [{ code: 'FOCUS_RECONCILE_PENDING' }]; } }));
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    consumeNotification(outcomeId) { return serial(() => profiled('notification', async () => { ensure(); const transition = measured(() => consumeFocusNotification(store.record, outcomeId, { now: now() })); await saveTransition(transition, 'notification'); return transition.actionResult.outcome ?? null; })); },
    async handle(req, res) {
      const scope = meter?.startScope();
      const send = (code, value) => { const body = measured(() => JSON.stringify(value)); if (scope) res.setHeader('X-Daylight-Queue-Ms', String(scope.maxMs)); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(body); };
      try {
        const url = new URL(req.url, 'http://127.0.0.1'), kind = url.pathname.split('/').at(-1);
        let request;
        if (req.method === 'POST') {
          const chunks = []; let bytes = 0;
          for await (const chunk of req) { bytes += chunk.length; if (bytes > 100000) throw focusError('专注请求过大'); chunks.push(chunk); }
          try { request = measured(() => JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { throw focusError('需要合法 JSON'); }
          if ([...url.searchParams].length) throw focusError('写入不接受查询参数');
        }
        const response = await serial(async () => {
          ensure();
          if (kind === 'actions') {
            const fingerprint = measured(() => createHash('sha256').update(JSON.stringify(request)).digest('hex'));
            // Replay comes before task locks, reconciliation, version and expiry checks.
            if (store.record.receipts.some(receipt => receipt.requestId === request?.requestId)) {
              const replay = measured(() => prepareFocusWrite(store.record, request, fingerprint, context()));
              if (replay.code === 200) replay.value.runtime = snapshotValue().runtime;
              return replay;
            }
            if (isTaskWriting()) return { code: 409, value: { error: '任务正在保存，请稍后核对', code: 'TASK_WRITE_IN_PROGRESS', version: store.record.version } };
            await reconcile();
            const decision = measured(() => prepareFocusWrite(store.record, request, fingerprint, { ...context(), sessionId: randomUUID() }));
            if (decision.nextRecord) { await saveRecord(decision.nextRecord); pendingSave = null; decision.value.runtime = snapshotValue().runtime; publish('action'); schedule(); }
            return decision;
          }
          if (kind === 'prepare') {
            // A prepare request never persists reconciliation or any other state.
            return { code: 200, value: measured(() => prepareFocusAction(store.record, request, context())) };
          }
          const selection = measured(() => validateFocusQuery(kind, url.searchParams));
          try { await reconcile(); } catch (error) { if (kind !== 'state') throw error; }
          if (kind === 'state') return { code: 200, value: snapshotValue() };
          if (kind === 'export') return { code: 200, value: measured(() => focusExport(store.record)) };
          const queryContext = { now: now(), dayWindows: selection.from ? measured(() => timeZoneAdapter.windows(selection.from, selection.to, store.record.settings.statisticsTimeZone)) : [] };
          const value = measured(() => kind === 'statistics' ? focusStatistics(store.record, selection, queryContext) : kind === 'task-summary' ? focusTaskSummary(store.record, selection.taskId, { ...queryContext, recentLimit: selection.recentLimit }) : focusSessionQuery(store.record, selection, queryContext));
          return { code: 200, value };
        });
        send(response.code, response.value);
      } catch (error) { send(error.status || 503, { error: error.message, code: error.code || 'FOCUS_UNAVAILABLE', ...(store ? { version: store.record.version } : {}), ...(error.details ? { details: error.details } : {}) }); }
      finally { if (scope) diagnostic({ focusDiagnostics: true, operation: 'http', queueMs: scope.finish() }); }
    },
    async close() { closed = true; clearTimeout(timer); listeners.clear(); await queue; meter?.close(); },
  };
  return service;
}
