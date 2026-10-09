import { randomUUID } from 'node:crypto';
import { change, validate } from './public/model.js';
import { isCivilDate } from './core/date.js';

export const operations = {
  'project.create': 'name, path?, id?',
  'project.update': 'id, name?, path?',
  'project.delete': 'id (deletes project, all its tasks including completed tasks, and their plan references; local files are untouched)',
  'task.create': 'title, projectId? (null = 未归类（旧称收件箱）), notes?, today?, planDay?, id?',
  'task.update': 'id, title?, projectId?, notes?',
  'task.status': 'id, status (todo | active | done)',
  'task.delete': 'id (also removes plan references)',
  'plan.add': 'id',
  'plan.remove': 'id, preserveExecution? (default false)',
  'plan.reschedule': 'id, fromDay, toDay (atomic, preserves execution status)',
  'plan.move': 'id, direction (-1 | 1)',
  'plan.set': 'ids (ordered, unique, existing, unfinished task IDs)',
  batch: 'actions (1–100 actions, atomic; no nested batch or undo)',
  undo: 'restores the immediately previous successful write; expectedVersion required',
};

export function applyAction(state, action, day) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('action 必须是对象');
  if (!Object.hasOwn(operations, action.type) || action.type === 'undo') throw new Error('不支持的 action.type');
  if (action.day !== undefined) {
    if (!['plan.add', 'plan.remove', 'plan.move', 'plan.set'].includes(action.type) || !isCivilDate(action.day)) throw new Error('子项 day 仅适用于计划操作且必须为有效日期');
    day = action.day;
  }
  if (action.type === 'task.create' && action.planDay !== undefined && (!isCivilDate(action.planDay) || action.today === true)) throw new Error('planDay 必须为有效日期且不能同时指定 today:true');
  if (action.type === 'task.create' && action.planDay !== undefined && Object.keys(action).some(key => !['type', 'title', 'projectId', 'notes', 'today', 'planDay', 'id'].includes(key))) throw new Error('日期任务创建包含未知字段');
  if (action.type === 'plan.remove' && action.preserveExecution !== undefined && typeof action.preserveExecution !== 'boolean') throw new Error('preserveExecution 必须为布尔值');
  if (action.type === 'plan.remove' && action.preserveExecution !== undefined && Object.keys(action).some(key => !['type', 'id', 'preserveExecution', 'day'].includes(key))) throw new Error('日期移除包含未知字段');
  if (action.type === 'plan.reschedule' && Object.keys(action).some(key => !['type', 'id', 'fromDay', 'toDay'].includes(key))) throw new Error('改期包含未知字段');
  if (action.type === 'batch') {
    if (!Array.isArray(action.actions) || !action.actions.length || action.actions.length > 100 || action.actions.some(a => !a || ['batch', 'undo'].includes(a.type))) throw new Error('batch 需要 1–100 条非嵌套操作');
    return action.actions.reduce((current, item) => applyAction(current, item, day), state);
  }
  const next = structuredClone(state);
  const task = next.tasks.find(t => t.id === action.id);
  const project = next.projects.find(p => p.id === action.id);
  const needsTask = ['task.update', 'task.status', 'task.delete', 'plan.add', 'plan.remove', 'plan.move'];
  if (needsTask.includes(action.type) && !task) throw new Error('任务不存在');
  if (['project.update', 'project.delete'].includes(action.type) && !project) throw new Error('项目不存在');
  switch (action.type) {
    case 'project.create': return change(next, { type: 'project', id: action.id ?? randomUUID(), name: action.name, path: action.path ?? '' }, day);
    case 'project.update': return change(next, action, day);
    case 'project.delete': return change(next, action, day);
    case 'task.create': return change(next, { type: 'add', id: action.id ?? randomUUID(), title: action.title, projectId: action.projectId ?? null, notes: action.notes ?? '', today: action.today === true, planDay: action.planDay }, day);
    case 'task.update': return change(next, { type: 'edit', id: action.id, title: action.title ?? task.title, notes: action.notes ?? task.notes, projectId: action.projectId === undefined ? task.projectId : action.projectId }, day);
    case 'task.status':
      if (!['todo', 'active', 'done'].includes(action.status)) throw new Error('status 必须为 todo、active 或 done');
      if (action.status === 'active') {
        next.tasks.forEach(t => { if (t.status === 'active') t.status = 'todo'; });
        next.plans[day] ||= [];
        if (!next.plans[day].includes(task.id)) next.plans[day].push(task.id);
      }
      task.completedAt = action.status === 'done' ? task.completedAt || new Date().toISOString() : null;
      task.status = action.status;
      break;
    case 'task.delete': return change(next, action, day);
    case 'plan.add': return change(next, { type: 'plan', id: action.id }, day);
    case 'plan.remove': return change(next, { type: 'unplan', id: action.id, preserveExecution: action.preserveExecution }, day);
    case 'plan.reschedule': {
      const fail = (message, status, code) => { throw Object.assign(new Error(message), { status, code }); };
      if (!task) fail('任务不存在', 404, 'TASK_NOT_FOUND');
      if (!isCivilDate(action.fromDay) || !isCivilDate(action.toDay)) fail('改期日期无效', 400, 'INVALID_DATE');
      if (action.fromDay === action.toDay) fail('源日期和目标日期相同', 400, 'SAME_DAY');
      if (!next.plans[action.fromDay]?.includes(task.id)) fail('源日期安排已变化', 409, 'PLAN_REFERENCE_CHANGED');
      next.plans[action.fromDay] = next.plans[action.fromDay].filter(id => id !== task.id);
      if (!next.plans[action.fromDay].length) delete next.plans[action.fromDay];
      const target = next.plans[action.toDay] ||= [];
      if (!target.includes(task.id)) target.push(task.id);
      break;
    }
    case 'plan.move':
      if (![-1, 1].includes(action.direction)) throw new Error('direction 必须为 -1 或 1');
      return change(next, { type: 'move', id: action.id, direction: action.direction }, day);
    case 'plan.set':
      if (!Array.isArray(action.ids) || action.ids.some(id => !next.tasks.some(t => t.id === id && t.status !== 'done'))) throw new Error('ids 必须引用未完成任务');
      for (const t of next.tasks) if (t.status === 'active' && next.plans[day]?.includes(t.id) && !action.ids.includes(t.id)) t.status = 'todo';
      next.plans[day] = action.ids;
      break;
  }
  return validate(next);
}
