export function buildTaskIndex(state) {
  return { state, tasks: new Map(state.tasks.map(task => [task.id, task])), projects: new Map(state.projects.map(project => [project.id, project])) };
}

export function selectIndexedTasks(index, orderedTasks, input = {}) {
  const status = input.status || 'all', projectId = input.projectId ?? null;
  const unassigned = input.unassigned === true || input.unassigned === '1', query = String(input.query || '').trim();
  const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
  if (!['all', 'open', 'done'].includes(status) || query.length > 300) fail('任务筛选条件无效');
  if (projectId !== null && unassigned) fail('项目与未归类条件不能同时使用');
  if (projectId !== null && !index.projects.has(projectId)) fail('项目不存在', 404);
  const needle = query.toLowerCase();
  const matched = orderedTasks.filter(task => task && (projectId === null || task.projectId === projectId) && (!unassigned || task.projectId === null) && (!needle || `${task.title} ${task.notes} ${index.projects.get(task.projectId)?.name || ''}`.toLowerCase().includes(needle)));
  const open = matched.filter(task => task.status !== 'done').length;
  return { selection: { status, projectId, unassigned, query }, counts: { open, done: matched.length - open, total: matched.length }, tasks: matched.filter(task => status === 'all' || (status === 'done' ? task.status === 'done' : task.status !== 'done')) };
}
