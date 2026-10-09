import { addCivilDays, validateDateRange } from './date.js';
import { buildTaskIndex, selectIndexedTasks } from './task-selection.js';

export function calendarQuery(state, version, input = {}) {
  const allowed = ['from', 'to', 'status', 'projectId', 'unassigned', 'query', 'previewLimit'];
  const params = {};
  for (const [key, value] of Array.isArray(input) ? input : typeof input.entries === 'function' ? input.entries() : Object.entries(input)) {
    if (!allowed.includes(key) || Object.hasOwn(params, key)) throw Object.assign(new Error('日历参数未知或重复'), { status: 400 });
    params[key] = value;
  }
  const { from, to, days } = validateDateRange({ ...params, maxDays: 62 });
  const previewLimit = params.previewLimit === undefined ? 3 : Number(params.previewLimit);
  if (!Number.isInteger(previewLimit) || previewLimit < 0 || previewLimit > 5 || (params.unassigned !== undefined && !['1', true].includes(params.unassigned))) throw Object.assign(new Error('日历参数无效'), { status: 400 });
  const index = buildTaskIndex(state);
  const selection = { from, to, ...selectIndexedTasks(index, [], params).selection };
  return { version, selection, days: Array.from({ length: days }, (_, offset) => {
    const day = addCivilDays(from, offset), result = selectIndexedTasks(index, (state.plans[day] || []).map(id => index.tasks.get(id)), params);
    const preview = result.tasks.slice(0, previewLimit).map(task => { const project = index.projects.get(task.projectId); return { id: task.id, title: task.title, status: task.status, projectId: task.projectId, projectName: project?.name ?? null, projectColor: project?.color ?? null }; });
    return { day, counts: result.counts, matchedCount: result.tasks.length, preview, hasMore: result.tasks.length > preview.length };
  }) };
}
