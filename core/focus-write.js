import { applyFocusAction, focusSnapshot } from './focus-model.js';
import { focusError, focusLimits, validateFocusAction } from './focus-contracts.js';

export function prepareFocusWrite(record, request, fingerprint, context = {}) {
  const reject = error => ({ code: error.status || 400, value: { error: error.message, code: error.code || 'INVALID_FOCUS_INPUT', version: record.version, ...(error.details ? { details: error.details } : {}) } });
  try {
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !['requestId', 'expectedVersion', 'expectedTaskVersion', 'expiresAt', 'action'].includes(key)) || typeof request.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(request.requestId) || !Number.isInteger(request.expectedVersion) || request.expectedVersion < 0) throw focusError('需要合法的 requestId 和 expectedVersion');
    const receipt = record.receipts.find(value => value.requestId === request.requestId);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw focusError('requestId 已用于不同请求', 'REQUEST_ID_REUSED', 409);
      return { code: 200, value: { ok: true, ...focusSnapshot(record, context), replayed: true, appliedVersion: receipt.appliedVersion, actionResult: receipt.actionResult } };
    }
    if (context.busy || request.expectedVersion !== record.version) throw focusError('专注版本已变化，请核对后重试', 'FOCUS_VERSION_CHANGED', 409);
    validateFocusAction(request.action);
    if (request.expectedTaskVersion !== undefined && (!Number.isInteger(request.expectedTaskVersion) || request.expectedTaskVersion < 0)) throw focusError('expectedTaskVersion 无效');
    if (['focus.start', 'focus.switch'].includes(request.action.type) && request.expectedTaskVersion !== context.taskVersion) throw focusError('任务版本已变化，请重新核对', 'TASK_VERSION_CHANGED', 409, { taskVersion: context.taskVersion });
    if (request.expiresAt !== undefined) {
      if (!Number.isSafeInteger(request.expiresAt) || request.expiresAt > context.now + focusLimits.maxPrepareAgeMs) throw focusError('expiresAt 无效');
      if (request.expiresAt <= context.now) throw focusError('专注草稿已过期，请重新准备', 'FOCUS_DRAFT_EXPIRED', 409);
    }
    const transition = applyFocusAction(record, request.action, context);
    const version = record.version + 1;
    const nextRecord = { ...transition.nextRecord, version, receipts: [...record.receipts, { requestId: request.requestId, fingerprint, appliedVersion: version, actionResult: transition.actionResult }].slice(-100) };
    return { code: 200, nextRecord, events: transition.events, value: { ok: true, ...focusSnapshot(nextRecord, context), appliedVersion: version, replayed: false, actionResult: transition.actionResult } };
  } catch (error) { return reject(error); }
}

export function prepareFocusAction(record, request, context = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => key !== 'action')) throw focusError('prepare 只接受 action');
  const action = validateFocusAction(request.action);
  // The dry run checks matching sessions and task validity; its next record is discarded.
  const transition = applyFocusAction(record, action, { ...context, sessionId: 'preview-session' });
  const normalizedAction = { ...action };
  if (['focus.start', 'focus.switch'].includes(action.type)) normalizedAction.durationSeconds ??= record.settings[action.phase === 'work' ? 'workSeconds' : 'shortBreakSeconds'];
  const reviewSession = session => session ? { id: session.id, taskId: session.taskId, taskTitleSnapshot: session.taskTitleSnapshot, projectNameSnapshot: session.projectNameSnapshot, phase: session.phase, targetMs: session.targetMs, elapsedMs: session.elapsedMs, remainingMs: session.remainingMs } : null;
  const current = reviewSession(focusSnapshot(record, context).current);
  const target = ['focus.start', 'focus.switch'].includes(action.type) ? reviewSession(focusSnapshot(transition.nextRecord, context).current) : null;
  return { focusVersion: record.version, taskVersion: context.taskVersion, normalizedAction, impact: { current, ...(target ? { target } : {}), result: transition.actionResult, endsCurrent: ['focus.finish', 'focus.switch'].includes(action.type), taskStateMutation: false }, preparedAt: context.now, ...(!['focus.settings', 'focus.acknowledge'].includes(action.type) ? { expiresAt: context.now + focusLimits.maxPrepareAgeMs } : {}) };
}
