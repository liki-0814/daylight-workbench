export const projectView = id => 'project:' + id;
export const viewProjectId = view => view.startsWith('project:') ? view.slice(8) : null;

export function parseRoute(hash, state) {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  if (p.has('extensions')) return { page: 'extensions', tab: ['skills', 'mcp', 'clients'].includes(p.get('tab')) ? p.get('tab') : 'skills', id: p.get('id'), client: p.get('client'), query: p.get('q') || '', problems: p.get('problems') === '1', operation: p.get('operation') };
  const page = ['ai', 'proxy', 'cli', 'settings', 'update'].find(k => p.has(k));
  if (page) return { page, check: page === 'update' && p.get('check') === '1', conversation: p.get('conversation') };
  let view = p.has('inbox') || p.get('unassigned') === '1' ? 'inbox' : p.has('project') ? projectView(p.get('project')) : 'all';
  if (['today','calendar','focus'].some(key=>p.has(key))) view = 'all';
  let status = p.has('done') || p.get('status') === 'done' ? 'done' : p.get('status') === 'open' ? 'open' : 'all';
  const taskId = p.get('task'), task = state?.tasks.find(t => t.id === taskId);
  if (task) { view = task.projectId === null ? 'inbox' : projectView(task.projectId); status = task.status === 'done' ? 'done' : 'open'; }
  let missing = null;
  if (!['all', 'inbox'].includes(view) && !state?.projects.some(p => p.id === viewProjectId(view))) { missing = '项目不存在或已删除'; view = 'all'; }
  if (taskId && !task) missing = '任务不存在或已删除';
  return { page: 'task', view, status, query: p.get('q') || '', taskId: task?.id, newTask: p.has('new'), newProject: p.has('new-project'), missing, explicit: p.has('calendar') || p.has('focus') || p.has('today') || p.has('tasks') || p.has('all') || p.has('inbox') || p.has('done') || p.has('project') || Boolean(taskId) };
}

export function taskRoute(view, status = 'all', query = '') {
  const p = new URLSearchParams();
  p.set('tasks', '');
  if (view === 'inbox') p.set('unassigned', '1');
  else if (!['today', 'calendar', 'focus', 'all'].includes(view)) p.set('project', viewProjectId(view) ?? view);
  if (status === 'done') p.set('status', status);
  if (query) p.set('q', query);
  return '#' + p.toString().replace(/^(today|tasks)=&/, '$1&');
}

export function extensionsRoute({ tab = 'skills', id, client, query, problems, operation } = {}) {
  const params = new URLSearchParams({ extensions: '', tab });
  for (const [key, value] of Object.entries({ id, client, q: query, problems: problems ? '1' : null, operation })) if (value) params.set(key, value);
  return '#' + params.toString().replace(/^extensions=&/, 'extensions&');
}
