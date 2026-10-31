// 任务页（0.8）：只用 ui/ 组件拼装，不含组件 CSS / 一次性标记。
//   tasksPage(model) → SafeHtml；mountTasks(root, model) 用 morph() 增量更新，不丢焦点 / 输入法组合态。
import { html, esc, trusted, slot } from '../ui/core/html.js';
import { morph } from '../ui/core/morph.js';
import { toolbar } from '../ui/components/toolbar/toolbar.js';
import { segmented } from '../ui/components/segmented/segmented.js';
import { select } from '../ui/components/select/select.js';
import { menu } from '../ui/components/menu/menu.js';
import { input } from '../ui/components/input/input.js';
import { button } from '../ui/components/button/button.js';
import { checkbox } from '../ui/components/checkbox/checkbox.js';
import { iconButton } from '../ui/components/icon-button/icon-button.js';
import { pageLayout } from '../ui/patterns/shell/shell.js';
import { groupHeader, rowList, taskRow, rowEmpty } from '../ui/patterns/data-row/data-row.js';
import { inspector } from '../ui/patterns/inspector/inspector.js';

const STATUS = { todo: '待办', active: '进行中', done: '已完成' };
const PRIORITY = { high: '高', medium: '中', low: '低' };
const pad = n => String(n).padStart(2, '0');
const civil = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const addDays = (day, n) => { const [y, m, d] = day.split('-').map(Number); return civil(new Date(y, m - 1, d + n)); };

export function dueLabel(due, today) {
  if (!due) return { text: '—' };
  if (due === today) return { text: '今天', tone: 'today' };
  if (due === addDays(today, 1)) return { text: '明天' };
  const [, m, d] = due.split('-').map(Number);
  return { text: `${m}月${d}日`, tone: due < today ? 'overdue' : undefined };
}
export const estimateLabel = minutes => !minutes ? '—' : minutes % 60 === 0 ? `${minutes / 60} 小时` : minutes > 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes} 分钟`;

const md = day => { const [, m, d] = day.slice(0, 10).split('-').map(Number); return `${m}月${d}日`; };
const clock = iso => { const date = new Date(iso); return `${md(civil(date))} ${pad(date.getHours())}:${pad(date.getMinutes())}`; };
// 动态只来自任务自身的真实记录：创建时间、加入哪些日期的计划、完成时间。
export function activityOf(task, plans) {
  const events = [];
  if (task.createdAt) events.push({ sort: task.createdAt, when: clock(task.createdAt), text: '创建任务' });
  for (const day of Object.keys(plans).sort()) if (plans[day].includes(task.id)) events.push({ sort: `${day}T00:00`, when: md(day), text: `加入 ${md(day)} 的计划` });
  if (task.status === 'done' && task.completedAt) events.push({ sort: task.completedAt, when: clock(task.completedAt), text: '标记完成' });
  return events.sort((x, y) => (x.sort < y.sort ? 1 : x.sort > y.sort ? -1 : 0));
}

function subtaskList(task) {
  const list = task.subtasks || [];
  const rows = list.map(sub => html`<li class="${`dl-sub${sub.done ? ' is-done' : ''}`}" data-sub="${sub.id}" data-key="sub-${sub.id}">${checkbox({ name: 'subdone', checked: sub.done, label: `${sub.done ? '取消完成' : '标记完成'}：${sub.title}` })}<span class="dl-sub__title">${sub.title}</span>${iconButton({ label: `删除子任务：${sub.title}`, icon: 'close', size: 'sm', attrs: { 'data-action': 'remove-subtask', 'data-id': task.id, 'data-sub': sub.id } })}</li>`);
  return html`${list.length ? html`<ul class="dl-insp__list" data-key="subs">${rows}</ul>` : ''}${input({ name: 'subtask', value: '', label: '添加子任务', placeholder: '添加子任务，回车确认', id: 'subtask-input', attrs: { 'data-task': task.id, autocomplete: 'off' } })}`;
}

function taskInspector({ task, code, project, planned, today, currentProject, state }) {
  if (task) {
    const due = dueLabel(task.due, today), subs = task.subtasks || [], log = activityOf(task, state.plans);
    const done = task.status === 'done';
    return inspector({
      label: '任务详情', kicker: `${code} · ${project?.name || '未归类'}`, title: task.title,
      primary: html`${done ? button({ label: '恢复为待办', attrs: { 'data-action': 'toggle', 'data-id': task.id } }) : html`${button({ label: '开始专注', attrs: { 'data-action': 'focus-task', 'data-id': task.id } })}${button({ label: '完成', variant: 'primary', attrs: { 'data-action': 'toggle', 'data-id': task.id } })}`}${menu({ name: 'more', placement: 'end', label: '更多操作', trigger: { text: '更多' }, options: [
        ...(done ? [] : [{ value: planned ? 'unplan' : 'plan', label: planned ? '移出今天' : '加入今天' }]),
        { value: 'edit', label: '编辑' }, { value: 'discuss', label: '讨论' }, { value: 'related', label: '相关对话' }, { divider: true }, { value: 'delete-task', label: '删除…', icon: 'trash', danger: true }] })}`,
      props: [
        { label: '状态', value: STATUS[task.status] || task.status },
        { label: '优先级', value: PRIORITY[task.priority || 'medium'] },
        { label: '截止', value: due.text, tone: due.tone === 'overdue' ? 'error' : due.tone === 'today' ? 'warning' : '' },
        { label: '预估时长', value: estimateLabel(task.estimate) },
        { label: '今天', value: planned ? '已加入' : '未加入' },
      ],
      sections: [
        { key: 'notes', title: '备注', body: task.notes ? html`<p class="dl-insp__text">${task.notes}</p>` : '', empty: '还没有备注，点“编辑”添加。' },
        { key: 'subtasks', title: '子任务', count: subs.length ? `${subs.filter(sub => sub.done).length}/${subs.length}` : undefined, body: subtaskList(task) },
        { key: 'activity', title: '动态', body: log.length ? html`<ul class="dl-insp__list">${log.map((event, i) => html`<li class="dl-log" data-key="log-${i}"><time>${event.when}</time><span>${event.text}</span></li>`)}</ul>` : '', empty: '暂无动态。' },
      ],
    });
  }
  if (currentProject) {
    const count = state.tasks.filter(t => t.projectId === currentProject.id).length;
    return inspector({
      label: '项目详情', kicker: '项目', title: currentProject.name,
      props: [{ label: '本地目录', value: currentProject.path || '未关联' }, { label: '任务数', value: String(count) }],
      note: '选择一项任务查看详情。',
      actions: html`${button({ label: '编辑项目', attrs: { 'data-action': 'edit-project', 'data-id': currentProject.id } })}${currentProject.path ? button({ label: '复制路径', icon: 'copy', attrs: { 'data-action': 'copy', 'data-id': currentProject.id } }) : ''}${button({ label: '新建项目对话', attrs: { 'data-action': 'discuss', 'data-kind': 'project', 'data-id': currentProject.id } })}${button({ label: '相关对话', attrs: { 'data-action': 'related', 'data-kind': 'project', 'data-id': currentProject.id } })}${button({ label: '删除项目', variant: 'danger', icon: 'trash', attrs: { 'data-action': 'delete-project', 'data-id': currentProject.id } })}`,
    });
  }
  return inspector({ label: '任务详情', empty: '选择一项任务查看详情' });
}

// model: { state, view, tab, query, selectedId, tasks, counts, today, currentProject, codes: Map<id, 'DL-01'> }
export function tasksPage({ state, view, tab, query, selectedId, tasks, counts, today, currentProject, codes }) {
  const planned = new Set(state.plans[today] || []);
  const rowOf = task => taskRow({
    id: task.id, code: codes.get(task.id), title: task.title, done: task.status === 'done',
    priority: task.priority || 'medium', due: dueLabel(task.due, today), selected: task.id === selectedId,
    action: task.status === 'done' ? undefined : { label: '专注', icon: 'timer', attrs: { 'data-action': 'focus-task', 'data-id': task.id } },
  });
  const groups = view === 'all'
    ? [...state.projects.map(p => ({ key: p.id, label: p.name, dot: p.color, tasks: tasks.filter(t => t.projectId === p.id) })), { key: 'inbox', label: '未归类', dot: 'neutral', tasks: tasks.filter(t => t.projectId === null) }].filter(g => g.tasks.length)
    : [{ key: view, tasks }];
  const scope = currentProject?.name || (view === 'inbox' ? '未归类' : '全部项目');
  const body = tasks.length
    ? groups.map(g => html`${g.label ? groupHeader({ key: g.key, label: g.label, dot: g.dot, count: g.tasks.length }) : ''}${rowList({ label: g.label || scope, key: `list-${g.key}`, children: g.tasks.map(rowOf) })}`)
    : rowEmpty({
      title: query ? `没有匹配“${query}”的任务` : tab === 'done' ? '还没有已完成的任务' : '这里还没有待办任务',
      hint: query ? '换个关键词，或在全部任务里搜索。' : tab === 'done' ? '完成的任务会出现在这里。' : '按 ⌘K 新建一项任务。',
      action: query && view !== 'all' ? { label: '搜索全部任务', attrs: { 'data-action': 'search-all' } } : tab === 'open' ? { label: '新建任务', attrs: { 'data-action': 'new' } } : undefined,
    });
  const selected = tasks.find(t => t.id === selectedId) || null;
  return pageLayout({
    id: 'task-page', label: currentProject?.name || '任务',
    toolbar: toolbar({
      title: currentProject?.name || (view === 'inbox' ? '未归类' : '任务'),
      start: html`${segmented({ name: 'tab', value: tab, label: '任务状态', options: [{ value: 'open', label: '待办', count: counts.open }, { value: 'done', label: '已完成', count: counts.done }] })}${select({
        name: 'scope', variant: 'chip', label: '项目筛选', value: view === 'all' ? '' : view === 'inbox' ? 'unassigned' : view, placeholder: '全部项目',
        options: [{ value: '', label: '全部项目' }, { value: 'unassigned', label: '未归类' }, ...state.projects.map(p => ({ value: `project:${p.id}`, label: p.name, dot: p.color })), { divider: true }, { value: '__new__', label: '新建项目…', icon: 'plus', action: true }],
      })}`,
      end: html`${input({ name: 'search', value: query, label: `搜索${scope}中的${tab === 'done' ? '已完成' : '待办'}任务`, placeholder: `搜索${scope}…`, variant: 'pill', icon: 'search', kbd: '/', live: true, id: 'search', attrs: { autocomplete: 'off' } })}${button({ label: '新建任务', icon: 'plus', variant: 'primary', kbd: '⌘K', attrs: { 'data-action': 'new' } })}`,
    }),
    body, inspector: taskInspector({ task: selected, code: selected ? codes.get(selected.id) : '', project: selected && state.projects.find(p => p.id === selected.projectId), planned: selected && planned.has(selected.id), today, currentProject, state }),
    footer: html`<span>本地任务管理</span><span>${state.projects.length} 个项目 · ${state.tasks.length} 项任务</span>`,
  });
}

export function mountTasks(root, model) { morph(root, tasksPage(model)); }
