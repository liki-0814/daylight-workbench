import { isCivilDate, isCivilMonth } from '../core/date.js';
import { localDate } from './model.js';

export const projectView = id => 'project:' + id;
export const viewProjectId = view => view.startsWith('project:') ? view.slice(8) : null;

export function parseRoute(hash, state) {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  if (p.has('calendar')) {
    const today = localDate(), validDay = isCivilDate(p.get('date')), validMonth = isCivilMonth(p.get('month'));
    const selectedDay = validDay ? p.get('date') : validMonth ? p.get('month') + (p.get('month') === today.slice(0, 7) ? today.slice(7) : '-01') : today;
    const projectId = p.get('project');
    const missingProject = projectId && !state?.projects.some(project => project.id === projectId);
    return { page: 'task', view: 'calendar', month: selectedDay.slice(0, 7), selectedDay, status: ['open', 'done', 'all'].includes(p.get('status')) ? p.get('status') : 'open', query: p.get('q') || '', projectId: missingProject ? null : projectId, unassigned: !projectId && p.get('unassigned') === '1', newTask: p.has('new'), taskId: state?.tasks.some(task => task.id === p.get('task')) ? p.get('task') : undefined, explicit: true, missing: missingProject ? '项目不存在或已删除，已清除筛选' : p.has('date') && !validDay || p.has('month') && !validMonth ? '日历日期无效，已恢复有效日期' : null };
  }
  if (p.has('focus')) return { page: 'focus', from: p.get('from'), to: p.get('to'), projectId: p.get('project'), taskId: p.get('task'), unassigned: p.get('unassigned') === '1' };
  const page = ['ai', 'proxy', 'cli', 'settings'].find(k => p.has(k));
  if (page) return { page, conversation: p.get('conversation'), scope: p.has('scope') ? { kind: p.get('scope'), ...(p.get('scopeId') ? { id: p.get('scopeId') } : {}) } : null };
  let view = p.has('today') ? 'today' : p.has('inbox') || p.get('unassigned') === '1' ? 'inbox' : p.has('project') ? projectView(p.get('project')) : 'all';
  let status = p.has('done') || p.get('status') === 'done' ? 'done' : 'open';
  const taskId = p.get('task'), task = state?.tasks.find(t => t.id === taskId);
  if (task) { view = task.projectId === null ? 'inbox' : projectView(task.projectId); status = task.status === 'done' ? 'done' : 'open'; }
  let missing = null;
  if (!['today', 'all', 'inbox'].includes(view) && !state?.projects.some(p => p.id === viewProjectId(view))) { missing = '项目不存在或已删除'; view = 'all'; }
  if (taskId && !task) missing = '任务不存在或已删除';
  return { page: 'task', view, status, query: p.get('q') || '', taskId: task?.id, newTask: p.has('new'), newProject: p.has('new-project'), missing, explicit: p.has('today') || p.has('tasks') || p.has('all') || p.has('inbox') || p.has('done') || p.has('project') || Boolean(taskId) };
}

export function taskRoute(view, status = 'open', query = '') {
  const p = new URLSearchParams();
  p.set(view === 'today' ? 'today' : 'tasks', '');
  if (view === 'inbox') p.set('unassigned', '1');
  else if (!['today', 'all'].includes(view)) p.set('project', viewProjectId(view) ?? view);
  p.set('status', status);
  if (query) p.set('q', query);
  return '#' + p.toString().replace(/^(today|tasks)=&/, '$1&');
}

export function conversationRoute(scope) {
  const p = new URLSearchParams({ ai: '', scope: scope.kind });
  if (scope.id) p.set('scopeId', scope.id);
  return '#' + p.toString().replace(/^ai=&/, 'ai&');
}

export function calendarRoute({ month, selectedDay, status = 'open', projectId, unassigned, query = '' }) {
  const p = new URLSearchParams({ calendar: '', month: month || selectedDay?.slice(0, 7), date: selectedDay, status });
  if (projectId) p.set('project', projectId); else if (unassigned) p.set('unassigned', '1');
  if (query) p.set('q', query);
  return '#' + p.toString().replace(/^calendar=&/, 'calendar&');
}
export function focusRoute({ from, to, projectId, unassigned, taskId } = {}) {
  const p = new URLSearchParams({ focus: '' });
  for (const [key, value] of Object.entries({ from, to, project: projectId, task: taskId, unassigned: unassigned ? '1' : null })) if (value) p.set(key, value);
  return '#' + p.toString().replace(/^focus=(?:&|$)/, 'focus' + (p.size > 1 ? '&' : ''));
}
