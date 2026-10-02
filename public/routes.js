export const projectView = id => 'project:' + id;
export const viewProjectId = view => view.startsWith('project:') ? view.slice(8) : null;

export function parseRoute(hash, state) {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
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
