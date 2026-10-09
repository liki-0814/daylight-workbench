import { focusError, validateFocusAction } from './focus-contracts.js';

const finite = value => Number.isSafeInteger(value) && value >= 0;
const elapsed = session => session.segments.reduce((total, segment) => total + (segment.endAt === null ? 0 : segment.endAt - segment.startAt), 0);
const result = (record, nextRecord = record, actionResult = {}, events = []) => ({ nextRecord, changed: nextRecord !== record, actionResult, events });
const copyCurrent = current => ({ ...current, segments: current.segments.map(segment => ({ ...segment })) });

export function initialFocusRecord({ timeZone = 'UTC' } = {}) {
  return { schema: 1, version: 0, settings: { workSeconds: 1500, shortBreakSeconds: 300, notificationsEnabled: true, soundEnabled: true, showTrayTimer: true, statisticsTimeZone: timeZone }, current: null, sessions: [], lastOutcome: null, receipts: [] };
}

export function validateFocusRecord(record) {
  const fail = () => { throw focusError('专注数据格式无效，原文件已保留', 'FOCUS_UNAVAILABLE', 503); };
  if (!record || record.schema !== 1 || !Number.isInteger(record.version) || record.version < 0 || !Array.isArray(record.sessions) || !Array.isArray(record.receipts) || record.receipts.length > 100 || !record.settings) fail();
  const { statisticsTimeZone, ...settings } = record.settings;
  if (typeof statisticsTimeZone !== 'string' || !statisticsTimeZone.trim() || statisticsTimeZone.length > 100 || Object.keys(settings).length !== 5) fail();
  try { validateFocusAction({ type: 'focus.settings', settings }); } catch { fail(); }
  const ids = new Set();
  let lastEnd = 0;
  const checkSession = (session, current) => {
    if (!session || typeof session.id !== 'string' || !session.id || session.id.length > 100 || ids.has(session.id) || !['work', 'shortBreak'].includes(session.phase) || !['wall_clock', 'clock_changed', 'recovery_uncertain'].includes(session.timeQuality) || !finite(session.startedAt) || session.startedAt < lastEnd || !finite(session.targetMs) || session.targetMs < 60000 || session.targetMs > (session.phase === 'work' ? 10800000 : 3600000) || !Array.isArray(session.segments) || !Number.isInteger(session.pauseCount) || session.pauseCount < 0) fail();
    ids.add(session.id);
    if (!(session.taskId === null || typeof session.taskId === 'string' && session.taskId.length > 0 && session.taskId.length <= 100) || session.phase === 'work' && session.taskId === null) fail();
    for (const key of ['taskTitleSnapshot', 'projectIdSnapshot', 'projectNameSnapshot']) if (!(session[key] === null || typeof session[key] === 'string' && session[key].length <= (key === 'taskTitleSnapshot' ? 300 : 200))) fail();
    let boundary = session.startedAt, total = 0, open = 0;
    for (let i = 0; i < session.segments.length; i++) {
      const segment = session.segments[i];
      if (!segment || !finite(segment.startAt) || segment.startAt < boundary) fail();
      if (segment.endAt === null) { if (!current || session.status !== 'running' || i !== session.segments.length - 1) fail(); open++; boundary = segment.startAt; }
      else { if (!finite(segment.endAt) || segment.endAt < segment.startAt) fail(); total += segment.endAt - segment.startAt; boundary = segment.endAt; }
    }
    if (total > session.targetMs) fail();
    if (current) {
      if (!['running', 'paused'].includes(session.status)) fail();
      if (session.status === 'running') {
        if (open !== 1 || !finite(session.deadlineAt) || session.deadlineAt < boundary || session.deadlineAt - boundary !== session.targetMs - total || session.remainingMs !== null || session.clockIssue !== null) fail();
      } else if (open || session.deadlineAt !== null || !finite(session.remainingMs) || session.remainingMs !== session.targetMs - total) fail();
      if (session.clockIssue !== null && (session.status !== 'paused' || session.timeQuality !== 'clock_changed' || session.clockIssue?.code !== 'CLOCK_CHANGED' || !finite(session.clockIssue.frozenAt) || session.clockIssue.frozenAt !== boundary || !finite(session.clockIssue.detectedAt))) fail();
    } else {
      if (session.status !== 'ended' || open || session.deadlineAt !== null || session.remainingMs !== null || session.clockIssue !== null || !finite(session.endedAt) || session.endedAt < boundary || !finite(session.observedAt) || session.observedAt < session.endedAt && session.timeQuality !== 'clock_changed' || !['completed', 'stopped', 'task_completed', 'task_deleted', 'recovery_task_invalid'].includes(session.endReason) || session.endReason === 'completed' && total !== session.targetMs) fail();
      lastEnd = session.endedAt;
    }
  };
  for (const session of record.sessions) checkSession(session, false);
  if (record.current !== null) checkSession(record.current, true);
  if (record.lastOutcome !== null) {
    const outcome = record.lastOutcome;
    if (typeof outcome.id !== 'string' || !ids.has(outcome.id) || typeof outcome.acknowledged !== 'boolean' || !outcome.notification || !['none', 'pending', 'attempted', 'scheduled', 'failed'].includes(outcome.notification.state) || typeof outcome.notification.requestId !== 'string') fail();
  }
  const requests = new Set();
  for (const receipt of record.receipts) {
    if (!receipt || !/^[a-zA-Z0-9_-]{8,100}$/.test(receipt.requestId) || requests.has(receipt.requestId) || typeof receipt.fingerprint !== 'string' || !receipt.fingerprint || !Number.isInteger(receipt.appliedVersion) || receipt.appliedVersion < 1 || receipt.appliedVersion > record.version || !receipt.actionResult || typeof receipt.actionResult !== 'object') fail();
    requests.add(receipt.requestId);
  }
  return record;
}

export function focusSnapshot(record, { now, taskVersion = 0, runtime = {} } = {}) {
  const current = record.current ? (({ segments, ...value }) => ({ ...value, remainingMs: value.status === 'running' ? Math.max(0, value.deadlineAt - now) : value.remainingMs, elapsedMs: value.targetMs - (value.status === 'running' ? Math.max(0, value.deadlineAt - now) : value.remainingMs) }))(record.current) : null;
  return { version: record.version, taskVersion, serverNow: now, settings: { ...record.settings }, current, lastOutcome: record.lastOutcome, runtime };
}

function clipSegments(current, cutoff) {
  let remaining = current.targetMs;
  const segments = [];
  for (const segment of current.segments) {
    if (segment.startAt > cutoff || remaining <= 0) break;
    const endAt = Math.min(segment.endAt ?? cutoff, cutoff, segment.startAt + remaining);
    if (endAt < segment.startAt) continue;
    segments.push({ startAt: segment.startAt, endAt });
    remaining -= endAt - segment.startAt;
  }
  return segments;
}

function archive(record, { endAt, endReason, timeQuality }, now) {
  const current = record.current;
  const session = { ...current, status: 'ended', clockIssue: null, timeQuality: timeQuality || current.timeQuality, deadlineAt: null, remainingMs: null, segments: clipSegments(current, endAt), endedAt: endAt, observedAt: now, endReason };
  const outcome = { id: session.id, sessionId: session.id, phase: session.phase, taskId: session.taskId, taskTitleSnapshot: session.taskTitleSnapshot, targetMs: session.targetMs, elapsedMs: elapsed(session), endedAt: session.endedAt, observedAt: now, endReason, timeQuality: session.timeQuality, acknowledged: false, notification: { requestId: `focus-${session.id}`, state: endReason === 'completed' && record.settings.notificationsEnabled ? 'pending' : 'none' } };
  return result(record, { ...record, current: null, sessions: [...record.sessions, session], lastOutcome: outcome }, { sessionId: session.id, endReason }, [{ type: 'session-ended', outcomeId: outcome.id }]);
}

export function resolveFocusTermination(current, { now, taskState, taskCommittedAt, recovering = false } = {}) {
  if (!current) return null;
  const candidates = [];
  if (current.status === 'running' && current.deadlineAt <= now) candidates.push({ endAt: current.deadlineAt, endReason: 'completed', rank: 0 });
  if (current.phase === 'work') {
    const task = taskState?.tasks.find(value => value.id === current.taskId);
    if (!task || task.status === 'done') {
      const completedAt = task?.status === 'done' ? Date.parse(task.completedAt) : NaN;
      let endAt, endReason = task ? 'task_completed' : 'task_deleted', timeQuality;
      if (current.clockIssue && finite(taskCommittedAt) && taskCommittedAt >= current.startedAt && taskCommittedAt < current.clockIssue.frozenAt) {
        endAt = Number.isFinite(completedAt) && completedAt >= current.startedAt && completedAt <= taskCommittedAt ? completedAt : taskCommittedAt;
      }
      else if (current.clockIssue) endAt = current.clockIssue.frozenAt;
      else if (Number.isFinite(completedAt) && completedAt <= now) { endAt = Math.max(current.startedAt, completedAt); if (completedAt < current.startedAt) timeQuality = 'clock_changed'; }
      else if (finite(taskCommittedAt) && taskCommittedAt <= now) endAt = Math.max(current.startedAt, taskCommittedAt);
      else {
        endAt = current.segments.filter(segment => segment.endAt !== null).at(-1)?.endAt ?? current.startedAt;
        endReason = 'recovery_task_invalid'; timeQuality = 'recovery_uncertain';
      }
      candidates.push({ endAt, endReason, timeQuality, rank: endReason === 'recovery_task_invalid' ? 2 : 1 });
    }
  }
  candidates.sort((a, b) => a.endAt - b.endAt || a.rank - b.rank);
  return candidates[0] || null;
}

export function reconcileFocus(record, context) {
  const current = record.current;
  if (!current) return result(record);
  const { now, clockCheck, recovering } = context;
  const boundary = current.segments.at(-1)?.endAt ?? current.segments.at(-1)?.startAt ?? current.startedAt;
  const changedClock = !current.clockIssue && (clockCheck?.changed || now < boundary);
  // Freeze before considering a rollback-time task event, retaining only trusted work.
  if (changedClock) {
    const next = copyCurrent(current);
    if (next.status === 'running') {
      const open = next.segments.at(-1);
      const trusted = recovering ? open.startAt : clockCheck?.lastTrustedAt ?? open.startAt;
      open.endAt = Math.max(open.startAt, Math.min(trusted, next.deadlineAt));
    }
    const frozenAt = next.segments.at(-1)?.endAt ?? next.startedAt;
    Object.assign(next, { status: 'paused', deadlineAt: null, remainingMs: next.targetMs - elapsed(next), clockIssue: { code: 'CLOCK_CHANGED', detectedAt: now, frozenAt }, timeQuality: 'clock_changed' });
    const frozen = { ...record, current: next };
    const terminal = resolveFocusTermination(next, context);
    return terminal ? archive(frozen, terminal, now) : result(record, frozen, {}, [{ type: 'clock-frozen', sessionId: next.id }]);
  }
  const terminal = resolveFocusTermination(current, context);
  return terminal ? archive(record, terminal, now) : result(record);
}

export function applyFocusAction(record, action, { now, sessionId, taskState } = {}) {
  validateFocusAction(action);
  if (!finite(now)) throw focusError('服务时间无效');
  const current = record.current;
  const conflict = (message, code = 'FOCUS_SESSION_CHANGED', details) => { throw focusError(message, code, 409, details); };
  if (['focus.pause', 'focus.resume', 'focus.finish', 'focus.switch'].includes(action.type) && (!current || current.id !== action.sessionId)) conflict('当前会话已变化');
  if (current && ['focus.pause', 'focus.finish', 'focus.switch'].includes(action.type) && !current.clockIssue) {
    const boundary = current.segments.at(-1)?.endAt ?? current.segments.at(-1)?.startAt ?? current.startedAt;
    if (now < boundary) conflict('系统时间回拨，请先核对计时状态', 'CLOCK_CHANGED', { recoverableAt: boundary });
    if (current.status === 'running' && now >= current.deadlineAt) conflict('本轮已到期，请先读取最新计时状态');
  }
  if (action.type === 'focus.settings') {
    let lastOutcome = record.lastOutcome;
    if (action.settings.notificationsEnabled === false && lastOutcome?.notification.state === 'pending') lastOutcome = { ...lastOutcome, notification: { ...lastOutcome.notification, state: 'none' } };
    return result(record, { ...record, settings: { ...record.settings, ...action.settings }, lastOutcome }, { settings: { ...record.settings, ...action.settings } });
  }
  if (action.type === 'focus.acknowledge') {
    if (record.lastOutcome?.id !== action.outcomeId) conflict('结果已变化', 'FOCUS_OUTCOME_CHANGED');
    return result(record, { ...record, lastOutcome: { ...record.lastOutcome, acknowledged: true } }, { outcomeId: action.outcomeId });
  }
  if (action.type === 'focus.start' || action.type === 'focus.switch') {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 100) throw focusError('服务会话 ID 无效');
    if (action.type === 'focus.start' && current) conflict('已有正在计时的会话', 'FOCUS_ALREADY_ACTIVE');
    const minimumTime = current?.clockIssue?.frozenAt ?? record.sessions.at(-1)?.endedAt ?? 0;
    if (now < minimumTime) conflict('系统时间尚未恢复', 'CLOCK_CHANGED', { recoverableAt: minimumTime });
    const task = action.taskId ? taskState?.tasks.find(value => value.id === action.taskId) : null;
    if (action.phase === 'work' && (!task || task.status === 'done')) conflict('工作任务已完成或不存在', 'FOCUS_TASK_INVALID');
    if (action.taskId && !task) throw focusError('任务不存在', 'TASK_NOT_FOUND', 404);
    const seconds = action.durationSeconds ?? record.settings[action.phase === 'work' ? 'workSeconds' : 'shortBreakSeconds'];
    const project = task?.projectId ? taskState.projects.find(value => value.id === task.projectId) : null;
    const base = action.type === 'focus.switch' ? archive(record, { endAt: current.clockIssue?.frozenAt ?? now, endReason: 'stopped' }, now).nextRecord : record;
    const next = { id: sessionId, phase: action.phase, status: 'running', clockIssue: null, timeQuality: 'wall_clock', taskId: task?.id ?? null, taskTitleSnapshot: task?.title ?? null, projectIdSnapshot: task?.projectId ?? null, projectNameSnapshot: project?.name ?? null, targetMs: seconds * 1000, startedAt: now, deadlineAt: now + seconds * 1000, remainingMs: null, segments: [{ startAt: now, endAt: null }], pauseCount: 0 };
    return result(record, { ...base, current: next }, { sessionId, phase: action.phase, taskId: next.taskId }, [{ type: 'session-started', sessionId }]);
  }
  if (action.type === 'focus.finish') return archive(record, { endAt: current.clockIssue?.frozenAt ?? now, endReason: 'stopped' }, now);
  if (action.type === 'focus.pause') {
    if (current.status !== 'running') conflict('会话已暂停', 'FOCUS_NOT_RUNNING');
    const next = copyCurrent(current); next.segments.at(-1).endAt = now;
    Object.assign(next, { status: 'paused', deadlineAt: null, remainingMs: current.deadlineAt - now, pauseCount: current.pauseCount + 1 });
    return result(record, { ...record, current: next }, { sessionId: current.id });
  }
  if (action.type === 'focus.resume') {
    if (current.status !== 'paused') conflict('会话未暂停', 'FOCUS_NOT_PAUSED');
    const boundary = current.clockIssue?.frozenAt ?? current.segments.at(-1)?.endAt ?? current.startedAt;
    if (now < boundary || current.remainingMs <= 0) conflict('系统时间或剩余时长不允许继续', 'CLOCK_CHANGED', { recoverableAt: boundary });
    const task = taskState?.tasks.find(value => value.id === current.taskId);
    if (current.phase === 'work' && (!task || task.status === 'done')) conflict('工作任务已完成或不存在', 'FOCUS_TASK_INVALID');
    const next = { ...current, status: 'running', clockIssue: null, deadlineAt: now + current.remainingMs, remainingMs: null, segments: [...current.segments, { startAt: now, endAt: null }] };
    return result(record, { ...record, current: next }, { sessionId: current.id });
  }
  throw focusError('专注动作无效');
}

export function consumeFocusNotification(record, outcomeId, { now } = {}) {
  if (record.lastOutcome?.id !== outcomeId || record.lastOutcome.notification.state !== 'pending') return result(record);
  const outcome = { ...record.lastOutcome, notification: { ...record.lastOutcome.notification, state: 'attempted', attemptedAt: now } };
  return result(record, { ...record, lastOutcome: outcome }, { outcome });
}

export function focusExport(record) {
  const { receipts, ...value } = record;
  return value;
}
