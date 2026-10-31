import { isCivilDate } from '../core/date.js';

export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export const PRIORITIES = ['low', 'medium', 'high'];

// 展示编号 DL-01…：seq 在创建时分配，之后不变；旧任务没有 seq 时按数组顺序补（change() 每次写入都会落盘）。
export function taskSeqs(tasks) {
  let top = Math.max(0, ...tasks.map(t => Number.isInteger(t.seq) ? t.seq : 0));
  return tasks.map(t => Number.isInteger(t.seq) ? t.seq : ++top);
}
export const taskCode = seq => `DL-${String(seq).padStart(2, '0')}`;

export function initialState() {
  return { schema: 1, projects: [], tasks: [], plans: {} };
}

export function validate(state) {
  const fail = () => { throw new Error('数据格式不正确，未保存'); };
  const str = (s, max, empty = false) => typeof s === 'string' && s.length <= max && (empty || s.trim().length > 0);
  if (!state || state.schema !== 1 || !Array.isArray(state.projects) || !Array.isArray(state.tasks) || !state.plans || Array.isArray(state.plans) || typeof state.plans !== 'object') fail();
  if (state.projects.length > 1000 || state.tasks.length > 10000) fail();
  const projectIds = new Set();
  for (const p of state.projects) {
    if (!str(p.id, 100) || projectIds.has(p.id) || !str(p.name, 200) || !str(p.path, 1000, true) || !['green', 'amber'].includes(p.color)) fail();
    projectIds.add(p.id);
  }
  const taskIds = new Set();
  for (const t of state.tasks) {
    if (!str(t.id, 100) || taskIds.has(t.id) || !str(t.title, 300) || !str(t.notes, 10000, true) || !(t.projectId === null || projectIds.has(t.projectId)) || !['todo', 'active', 'done'].includes(t.status)) fail();
    if (t.priority !== undefined && !PRIORITIES.includes(t.priority)) fail();
    if (t.due !== undefined && t.due !== null && !isCivilDate(t.due)) fail();
    if (t.estimate !== undefined && t.estimate !== null && !(Number.isInteger(t.estimate) && t.estimate > 0 && t.estimate <= 5760)) fail();
    if (t.seq !== undefined && !(Number.isInteger(t.seq) && t.seq > 0)) fail();
    if (t.createdAt !== undefined && !(str(t.createdAt, 40) && Number.isFinite(Date.parse(t.createdAt)))) fail();
    if (t.subtasks !== undefined) {
      if (!Array.isArray(t.subtasks) || t.subtasks.length > 50) fail();
      const subIds = new Set();
      for (const sub of t.subtasks) { if (!sub || !str(sub.id, 100) || subIds.has(sub.id) || !str(sub.title, 200) || typeof sub.done !== 'boolean') fail(); subIds.add(sub.id); }
    }
    if (t.status === 'done' ? !str(t.completedAt, 40) || !Number.isFinite(Date.parse(t.completedAt)) : t.completedAt !== null) fail();
    taskIds.add(t.id);
  }
  if (state.tasks.filter(t => t.status === 'active').length > 1) fail();
  for (const [day, ids] of Object.entries(state.plans)) {
    if (!isCivilDate(day) || !Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => !taskIds.has(id))) fail();
  }
  return state;
}

export function change(state, action, day = localDate()) {
  const next = structuredClone(state);
  const task = next.tasks.find(t => t.id === action.id);
  if (['toggle', 'start', 'plan', 'unplan', 'move', 'edit', 'task.delete', 'subtask.add', 'subtask.toggle', 'subtask.remove'].includes(action.type) && !task) throw new Error('任务不存在');
  const plan = () => next.plans[day] ||= [];
  const extras = a => Object.fromEntries(['priority', 'due', 'estimate'].filter(key => a[key] !== undefined).map(key => [key, a[key]]));
  switch (action.type) {
    case 'subtask.add': {
      const title = String(action.title ?? '').trim();
      if (!title) throw new Error('请输入子任务标题');
      (task.subtasks ||= []).push({ id: action.subId, title, done: false });
      break;
    }
    case 'subtask.toggle': {
      const sub = task.subtasks?.find(item => item.id === action.subId);
      if (!sub) throw new Error('子任务不存在');
      sub.done = !sub.done;
      break;
    }
    case 'subtask.remove':
      if (!task.subtasks?.some(item => item.id === action.subId)) throw new Error('子任务不存在');
      task.subtasks = task.subtasks.filter(item => item.id !== action.subId);
      if (!task.subtasks.length) delete task.subtasks;
      break;
    case 'task.delete':
      next.tasks = next.tasks.filter(t => t.id !== action.id);
      for (const date of Object.keys(next.plans)) next.plans[date] = next.plans[date].filter(id => id !== action.id);
      break;
    case 'project.update': {
      const project = next.projects.find(p => p.id === action.id);
      if (!project) throw new Error('项目不存在');
      if (action.name !== undefined) project.name = action.name.trim();
      if (action.path !== undefined) project.path = action.path.trim();
      break;
    }
    case 'project.delete': {
      if (!next.projects.some(p => p.id === action.id)) throw new Error('项目不存在');
      const removed = new Set(next.tasks.filter(t => t.projectId === action.id).map(t => t.id));
      next.tasks = next.tasks.filter(t => !removed.has(t.id));
      for (const date of Object.keys(next.plans)) next.plans[date] = next.plans[date].filter(id => !removed.has(id));
      next.projects = next.projects.filter(p => p.id !== action.id);
      break;
    }
    case 'add': {
      const seqs = taskSeqs(next.tasks); next.tasks.forEach((t, i) => { t.seq = seqs[i]; });   // 只在新增时落盘，避免无关写入改动旧数据
      if (action.status !== undefined && !['todo', 'active'].includes(action.status)) throw new Error('新建任务的状态只能是待办或进行中');
      if (action.status === 'active') next.tasks.forEach(t => { if (t.status === 'active') t.status = 'todo'; });
      next.tasks.push({ id: action.id, seq: Math.max(0, ...next.tasks.map(t => t.seq)) + 1, title: action.title.trim(), projectId: action.projectId, notes: action.notes || '', status: action.status || 'todo', completedAt: null, ...(action.at ? { createdAt: action.at } : {}), ...extras(action) });
      if (action.status === 'active' && action.planDay === undefined) plan().push(action.id);
      if (action.planDay !== undefined) (next.plans[action.planDay] ||= []).push(action.id);
      else if (action.today) plan().push(action.id);
      break;
    }
    case 'edit':
      Object.assign(task, { title: action.title.trim(), projectId: action.projectId, notes: action.notes }, extras(action));
      for (const key of ['due', 'estimate']) if (task[key] === null) delete task[key];
      break;
    case 'project':
      next.projects.push({ id: action.id, name: action.name.trim(), path: action.path.trim(), color: next.projects.length % 2 ? 'amber' : 'green' });
      break;
    case 'toggle':
      task.status = task.status === 'done' ? 'todo' : 'done';
      task.completedAt = task.status === 'done' ? new Date().toISOString() : null;
      break;
    case 'start':
      if (task.status === 'done') throw new Error('请先恢复已完成的任务');
      if (task.status === 'active') task.status = 'todo';
      else {
        next.tasks.forEach(t => { if (t.status === 'active') t.status = 'todo'; });
        task.status = 'active';
        if (!plan().includes(task.id)) plan().push(task.id);
      }
      break;
    case 'plan':
      if (task.status === 'done') throw new Error('请先恢复已完成的任务');
      if (!plan().includes(task.id)) plan().push(task.id);
      break;
    case 'unplan':
      next.plans[day] = plan().filter(id => id !== task.id);
      if (task.status === 'active' && !action.preserveExecution) task.status = 'todo';
      break;
    case 'move': {
      const ids = plan();
      const activeIds = ids.filter(id => next.tasks.find(t => t.id === id).status !== 'done');
      const position = activeIds.indexOf(task.id);
      const otherId = activeIds[position + action.direction];
      if (position !== -1 && otherId) {
        const a = ids.indexOf(task.id), b = ids.indexOf(otherId);
        [ids[a], ids[b]] = [ids[b], ids[a]];
      }
      break;
    }
    default: throw new Error('未知操作');
  }
  return validate(next);
}
