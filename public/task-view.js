import { localDate } from './model.js';
import { isCivilDate } from '../core/date.js';
import { buildTaskIndex, selectIndexedTasks } from '../core/task-selection.js';

export function selectTasks(state, input = {}) {
  const scope = input.scope || 'all', status = input.status || 'all', day = input.day || localDate();
  const projectId = input.projectId ?? null, unassigned = input.unassigned === true || input.unassigned === '1';
  const query = String(input.query || '').trim();
  const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
  if (!['all', 'tasks', 'today'].includes(scope) || !['all', 'open', 'done'].includes(status)) fail('任务筛选条件无效');
  if (!isCivilDate(day)) fail('日期无效');
  if (projectId !== null && unassigned) fail('项目与未归类条件不能同时使用');
  if (projectId !== null && !state.projects.some(p => p.id === projectId)) fail('项目不存在', 404);
  const index = buildTaskIndex(state);
  const ordered = scope === 'today' ? (state.plans[day] || []).map(id => index.tasks.get(id)) : state.tasks;
  const result = selectIndexedTasks(index, ordered, { status, projectId, unassigned, query });
  return { ...result, selection: { scope: scope === 'tasks' ? 'all' : scope, ...result.selection, day } };
}

export function taskQuery(state, version, params = {}) {
  if (params.scope !== undefined && !['all','today'].includes(params.scope)) throw Object.assign(new Error('scope 必须为 all 或 today'), { status: 400 });
  if (params.unassigned !== undefined && !['1', true].includes(params.unassigned)) throw Object.assign(new Error('unassigned 必须为 1'), { status: 400 });
  return { version, localDate: localDate(), ...selectTasks(state, params) };
}

export const taskQueryCapability = { path: '/api/v1/tasks', scope: ['all', 'today'], status: ['all', 'open', 'done'], parameters: ['projectId', 'unassigned', 'query', 'day'], counts: 'before status filtering' };
