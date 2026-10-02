import { localDate } from './model.js';

export function selectTasks(state, input = {}) {
  const scope = input.scope || 'all', status = input.status || 'all', day = input.day || localDate();
  const projectId = input.projectId ?? null, unassigned = input.unassigned === true || input.unassigned === '1';
  const query = String(input.query || '').trim();
  const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
  if (!['all', 'tasks', 'today'].includes(scope) || !['all', 'open', 'done'].includes(status)) fail('任务筛选条件无效');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) fail('日期无效');
  if (projectId !== null && unassigned) fail('项目与未归类条件不能同时使用');
  if (projectId !== null && !state.projects.some(p => p.id === projectId)) fail('项目不存在', 404);
  const byId = new Map(state.tasks.map(t => [t.id, t]));
  let tasks = scope === 'today' ? (state.plans[day] || []).map(id => byId.get(id)).filter(Boolean) : state.tasks;
  const projects = new Map(state.projects.map(p => [p.id, p]));
  tasks = tasks.filter(t => (projectId === null || t.projectId === projectId) && (!unassigned || t.projectId === null) && (!query || `${t.title} ${t.notes} ${projects.get(t.projectId)?.name || ''}`.toLowerCase().includes(query.toLowerCase())));
  const open = tasks.filter(t => t.status !== 'done').length;
  const counts = { open, done: tasks.length - open, total: tasks.length };
  return { selection: { scope: scope === 'tasks' ? 'all' : scope, status, projectId, unassigned, query, day }, counts, tasks: tasks.filter(t => status === 'all' || (status === 'done' ? t.status === 'done' : t.status !== 'done')) };
}

export function taskQuery(state, version, params = {}) {
  if (params.scope !== undefined && !['all','today'].includes(params.scope)) throw Object.assign(new Error('scope 必须为 all 或 today'), { status: 400 });
  if (params.unassigned !== undefined && !['1', true].includes(params.unassigned)) throw Object.assign(new Error('unassigned 必须为 1'), { status: 400 });
  return { version, localDate: localDate(), ...selectTasks(state, params) };
}

export const taskQueryCapability = { path: '/api/v1/tasks', scope: ['all', 'today'], status: ['all', 'open', 'done'], parameters: ['projectId', 'unassigned', 'query', 'day'], counts: 'before status filtering' };
