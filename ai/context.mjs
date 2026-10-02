import { selectTasks } from '../public/task-view.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export function normalizeScope(input = { kind: 'workspace' }, state, requireExists = true) {
  if (!input || !['workspace', 'project', 'task'].includes(input.kind)) fail('会话关联类型无效');
  if (input.kind === 'workspace') return { kind: 'workspace' };
  if (typeof input.id !== 'string' || !input.id || input.id.length > 100) fail('关联对象 ID 无效');
  if (requireExists && !state[input.kind === 'project' ? 'projects' : 'tasks'].some(o => o.id === input.id)) fail('关联对象不存在或已删除', 404);
  return { kind: input.kind, id: input.id };
}

export function scopeInfo(scope = { kind: 'workspace' }, state) {
  const object = scope.kind === 'workspace' ? null : state[scope.kind === 'project' ? 'projects' : 'tasks'].find(o => o.id === scope.id);
  return { ...scope, exists: scope.kind === 'workspace' || Boolean(object), label: scope.kind === 'workspace' ? '工作台' : object?.name || object?.title || '关联对象已删除', ...(scope.kind === 'task' && object ? { projectId: object.projectId, projectName: state.projects.find(p => p.id === object.projectId)?.name || '未归类' } : {}) };
}

function snapshot(scope, state, day) {
  const info = scopeInfo(scope, state);
  if (!info.exists) return info;
  if (scope.kind === 'task') {
    const task = state.tasks.find(t => t.id === scope.id);
    return { ...info, task: structuredClone(task), today: (state.plans[day] || []).includes(task.id) };
  }
  const selected = selectTasks(state, { scope: scope.kind === 'workspace' ? 'today' : 'all', ...(scope.kind === 'project' ? { projectId: scope.id } : {}), status: 'open', day });
  return { ...info, ...(scope.kind === 'project' ? { project: structuredClone(state.projects.find(p => p.id === scope.id)) } : {}), counts: selected.counts, total: selected.tasks.length, truncated: selected.tasks.length > 20, tasks: selected.tasks.slice(0, 20).map(({ id, title, projectId, status }) => ({ id, title, projectId, status })) };
}

export function buildContext(conversation, input, workspace) {
  const { state, version, localDate: day } = workspace;
  const scope = normalizeScope(conversation.scope, state, false);
  const refs = input.objectReferences || [];
  if (!Array.isArray(refs) || refs.length > 5) fail('一次最多引用 5 个项目或任务');
  const unique = new Map();
  for (const ref of refs) {
    if (!ref || !['task', 'project'].includes(ref.kind)) fail('只能引用项目或任务');
    const normalized = normalizeScope(ref, state);
    unique.set(`${normalized.kind}:${normalized.id}`, normalized);
  }
  const objectReferences = [...unique.values()].map(ref => snapshot(ref, state, day));
  if (JSON.stringify(objectReferences).length > 60000) fail('对象引用超过 60000 字符，请减少引用');
  let viewContext;
  if (input.viewContext !== undefined) {
    const v = input.viewContext;
    if (!v || typeof v !== 'object' || !['all', 'today'].includes(v.scope)) fail('视图上下文无效');
    const selection = selectTasks(state, { scope: v.scope, status: v.status || 'all', day: v.day || day, ...(v.projectId ? { projectId: v.projectId } : {}), unassigned: v.unassigned, query: v.query }).selection;
    const result = selectTasks(state, selection);
    viewContext = { ...selection, counts: result.counts, total: result.tasks.length, truncated: result.tasks.length > 20, taskIds: result.tasks.slice(0, 20).map(t => t.id) };
  }
  return { scope, stateVersion: version, localDate: day, capturedAt: new Date().toISOString(), primary: snapshot(scope, state, day), objectReferences, ...(viewContext ? { viewContext } : {}) };
}

export function relatedReasons(c, target, state) {
  const exact = ref => ref?.kind === target.kind && ref?.id === target.id;
  const belongs = ref => target.kind === 'project' && ref?.kind === 'task' && state.tasks.some(t => t.id === ref.id && t.projectId === target.id);
  const reasons = [];
  if (exact(c.scope) || belongs(c.scope) || (target.kind === 'workspace' && (!c.scope || c.scope.kind === 'workspace'))) reasons.push('直接关联');
  if (c.messages.some(m => m.context?.objectReferences?.some(ref => exact(ref) || belongs(ref)))) reasons.push('曾引用');
  if (c.messages.some(m => m.role === 'operation' && m.action && (m.action.type === 'batch' ? m.action.actions : [m.action]).some(a => {
    const ref = { kind: a.type.startsWith('project.') ? 'project' : 'task', id: a.id };
    return exact(ref) || belongs(ref) || (target.kind === 'project' && a.projectId === target.id);
  }))) reasons.push('曾更新');
  return reasons;
}
