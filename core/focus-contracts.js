import { validateDateRange } from './date.js';

export const focusOperations = ['focus.start', 'focus.pause', 'focus.resume', 'focus.finish', 'focus.switch', 'focus.settings', 'focus.acknowledge'];
export const focusLimits = { maxReportDays: 366, maxCalendarDays: 62, maxSessions: 100, receiptCount: 100, maxPrepareAgeMs: 600000 };
export const calendarCapability = { path: '/api/v1/calendar', maxDays: 62, weekStartsOn: 1 };
export const taskPlanningCapability = { reschedule: true, perActionDay: true, preserveExecution: true, createPlanDay: true };
export const focusCapability = { apiVersion: 1, state: '/api/v1/focus/state', prepare: '/api/v1/focus/prepare', writes: '/api/v1/focus/actions', statistics: '/api/v1/focus/statistics', sessions: '/api/v1/focus/sessions', taskSummary: '/api/v1/focus/task-summary', export: '/api/v1/focus/export', operations: focusOperations, retention: 'all sessions; last 100 successful request IDs', maxReportDays: 366, taskStateMutation: false };
export const focusError = (message, code = 'INVALID_FOCUS_INPUT', status = 400, details) => Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) });

export function validateFocusQuery(kind, input = {}) {
  const fields = { state: [], export: [], statistics: ['from', 'to', 'projectId', 'unassigned', 'taskId'], 'task-summary': ['taskId', 'recentLimit'], sessions: ['from', 'to', 'projectId', 'unassigned', 'taskId', 'phase', 'limit', 'cursor'] }[kind];
  if (!fields) throw focusError('专注查询不存在', 'NOT_FOUND', 404);
  const params = {};
  for (const [key, value] of Array.isArray(input) ? input : typeof input.entries === 'function' ? input.entries() : Object.entries(input)) {
    if (!fields.includes(key) || Object.hasOwn(params, key)) throw focusError('查询包含未知或重复参数');
    params[key] = value;
  }
  if (kind === 'statistics' || params.from !== undefined || params.to !== undefined) validateDateRange({ from: params.from, to: params.to, maxDays: 366 });
  for (const key of ['projectId', 'taskId']) if (params[key] !== undefined && (typeof params[key] !== 'string' || !params[key].trim() || params[key].length > 100)) throw focusError(`${key} 无效`);
  if (params.unassigned !== undefined && !['1', true].includes(params.unassigned)) throw focusError('unassigned 必须为 1');
  if (params.projectId !== undefined && params.unassigned !== undefined) throw focusError('项目和未归类不能同时筛选');
  if (params.phase !== undefined && !['work', 'shortBreak'].includes(params.phase)) throw focusError('phase 无效');
  if (kind === 'task-summary' && !params.taskId) throw focusError('taskId 必填');
  if (kind === 'task-summary') params.recentLimit = boundedInteger(params.recentLimit, 5, 0, 10, 'recentLimit');
  if (kind === 'sessions') params.limit = boundedInteger(params.limit, 20, 1, 100, 'limit');
  if (params.cursor !== undefined && (typeof params.cursor !== 'string' || params.cursor.length > 2000)) throw focusError('cursor 无效');
  return params;
}

function boundedInteger(value, fallback, min, max, field) {
  if (value === undefined) return fallback;
  if ((typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) || !Number.isInteger(Number(value)) || Number(value) < min || Number(value) > max) throw focusError(`${field} 无效`);
  return Number(value);
}

export function validateFocusAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action) || !focusOperations.includes(action.type)) throw focusError('专注动作无效');
  const fields = { 'focus.start': ['phase', 'taskId', 'durationSeconds'], 'focus.switch': ['sessionId', 'phase', 'taskId', 'durationSeconds'], 'focus.pause': ['sessionId'], 'focus.resume': ['sessionId'], 'focus.finish': ['sessionId'], 'focus.settings': ['settings'], 'focus.acknowledge': ['outcomeId'] }[action.type];
  if (Object.keys(action).some(key => key !== 'type' && !fields.includes(key))) throw focusError('专注动作包含未知字段');
  if (['focus.start', 'focus.switch'].includes(action.type)) {
    if (!['work', 'shortBreak'].includes(action.phase)) throw focusError('phase 必须为 work 或 shortBreak');
    if (action.phase === 'work' && (typeof action.taskId !== 'string' || !action.taskId.trim() || action.taskId.length > 100)) throw focusError('工作会话必须关联任务');
    if (action.taskId !== undefined && action.taskId !== null && (typeof action.taskId !== 'string' || !action.taskId.trim() || action.taskId.length > 100)) throw focusError('taskId 无效');
    if (action.durationSeconds !== undefined && (!Number.isInteger(action.durationSeconds) || action.durationSeconds < 60 || action.durationSeconds > (action.phase === 'work' ? 10800 : 3600))) throw focusError('计时时长超出允许范围');
  }
  if (fields.includes('sessionId') && (typeof action.sessionId !== 'string' || !action.sessionId || action.sessionId.length > 100)) throw focusError('sessionId 必填');
  if (fields.includes('outcomeId') && (typeof action.outcomeId !== 'string' || !action.outcomeId || action.outcomeId.length > 100)) throw focusError('outcomeId 必填');
  if (action.type === 'focus.settings') {
    const settings = action.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) || !Object.keys(settings).length || Object.keys(settings).some(key => !['workSeconds', 'shortBreakSeconds', 'notificationsEnabled', 'soundEnabled', 'showTrayTimer'].includes(key))) throw focusError('专注设置包含未知字段或为空');
    for (const [key, value] of Object.entries(settings)) {
      if (['workSeconds', 'shortBreakSeconds'].includes(key) ? !Number.isInteger(value) || value < 60 || value > (key === 'workSeconds' ? 10800 : 3600) : typeof value !== 'boolean') throw focusError(`设置 ${key} 无效`);
    }
  }
  return action;
}
