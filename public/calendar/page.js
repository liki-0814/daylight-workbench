import { monthGrid } from '../../core/date.js';
import { calendarQuery } from '../../core/calendar-query.js';
import { localDate } from '../model.js';
import { selectTasks } from '../task-view.js';
import { calendarRoute } from '../routes.js';
import { createCalendarGrid, shiftCalendarMonth } from '../components/calendar-grid.js';
import { actionButton, escapeButtonText as esc } from '../components/button.js';
import { segmentedControl, mountSegmentedControl } from '../components/segmented-control.js';
import { selectField } from '../components/select.js';
import { dateField } from '../components/date-field.js';
import { taskRow } from '../components/task-row.js';
import { taskRangeTabs } from '../components/task-range-tabs.js';
import { createDialogShell } from '../components/dialog-shell.js';

export function createCalendarPage({ getTaskSnapshot, taskClient, openTask, openPicker, onRoute, notify, confirmTaskCompletion = () => true }) {
  const element = document.createElement('main'); element.id = 'calendar-page'; element.className = 'calendar-page';
  const abort = new AbortController(); let route = { month: localDate().slice(0, 7), selectedDay: localDate(), status: 'open', query: '', projectId: null, unassigned: false }, visible = false, statusDispose, reschedule;
  const grid = createCalendarGrid({ onSelect(day, options) { navigate({ selectedDay: day, month: day.slice(0, 7) }, options.replace); }, onMonthChange(delta) { changeMonth(delta); } });
  element.innerHTML = `<header class="topbar"><span>我的工作空间 <span class="slash">/</span> 日历</span><label class="search"><input data-calendar-search aria-label="搜索日历任务" placeholder="搜索任务…"></label></header><div class="workspace task-workspace"><section class="page-heading"><div><h1>任务</h1><p>按日期安排，保留任务当前状态</p></div>${actionButton({ label: '新建任务', symbol: 'plus', variant: 'primary', attrs: { 'data-calendar-action': 'new' } })}</section><div class="task-view-controls">${taskRangeTabs({ view: 'calendar' })}</div><div class="calendar-filters"></div><div class="calendar-navigation">${actionButton({ label: '上一月', symbol: 'up', iconOnly: true, variant: 'icon', attrs: { 'data-calendar-action': 'previous' } })}<h2 data-calendar-month></h2>${actionButton({ label: '下一月', symbol: 'down', iconOnly: true, variant: 'icon', attrs: { 'data-calendar-action': 'next' } })}${actionButton({ label: '回到今天', variant: 'text', attrs: { 'data-calendar-action': 'today' } })}</div><div class="calendar-layout"><section class="calendar-month"></section><section class="calendar-detail" aria-label="日期详情"></section></div><p class="quiet-note">日期安排反映任务当前状态；移出当天和改期保留任务执行状态。</p></div>`;
  element.querySelector('.calendar-month').append(grid.element);
  function navigate(patch, replace = false) { route = { ...route, ...patch }; render(); onRoute(calendarRoute(route), { replace, route }); }
  function changeMonth(delta) { const selectedDay = shiftCalendarMonth(route.selectedDay, delta); if (selectedDay !== route.selectedDay) navigate({ selectedDay, month: selectedDay.slice(0, 7) }); }
  async function write(action, message, day) { try { await taskClient.act(action, { day }); notify(message, true); render(); return true; } catch (error) { notify(error.message); render(); return false; } }
  function render() {
    const { state, version } = getTaskSnapshot(); if (!state) return;
    if (route.projectId && !state.projects.some(project => project.id === route.projectId)) route.projectId = null;
    const cells = monthGrid(route.month), selection = { status: route.status, query: route.query, ...(route.projectId ? { projectId: route.projectId } : route.unassigned ? { unassigned: true } : {}) };
    const validCells = cells.filter(cell => cell.day), result = calendarQuery(state, version, { ...selection, from: validCells[0].day, to: validCells.at(-1).day });
    const detail = selectTasks(state, { ...selection, scope: 'today', day: route.selectedDay });
    const summaries = new Map(result.days.map(day => [day.day, day]));
    grid.update({ days: cells.map(cell => ({ ...cell, ...summaries.get(cell.day) })), selectedDay: route.selectedDay, today: localDate() });
    element.querySelector('[data-calendar-action=previous]').disabled = route.month === '0001-01';
    element.querySelector('[data-calendar-action=next]').disabled = route.month === '9999-12';
    element.querySelector('[data-calendar-month]').textContent = route.month.replace('-', ' 年 ') + ' 月';
    const search = element.querySelector('[data-calendar-search]'); if (search.value !== route.query) search.value = route.query;
    statusDispose?.();
    element.querySelector('.calendar-filters').innerHTML = selectField({ name: 'calendar-project', label: '项目筛选', value: route.projectId ? 'project:' + route.projectId : route.unassigned ? 'unassigned' : '', compact: true, options: [{ value: '', label: '全部项目' }, { value: 'unassigned', label: '未归类' }, ...state.projects.map(project => ({ value: 'project:' + project.id, label: project.name }))] }) + segmentedControl({ id: 'calendar-status', label: '任务状态', value: route.status, showLabel: true, options: [{ value: 'open', label: '待办' }, { value: 'done', label: '已完成' }, { value: 'all', label: '全部' }] });
    statusDispose = mountSegmentedControl(element.querySelector('#calendar-status'), { onChange: status => navigate({ status }, true) });
    const openIds = detail.tasks.filter(task => task.status !== 'done').map(task => task.id), canReorder = !route.query && !route.projectId && !route.unassigned && route.status !== 'done';
    element.querySelector('.calendar-detail').innerHTML = `<header><div><h2>${esc(route.selectedDay)}</h2><p>${detail.counts.open} 项待办 · ${detail.counts.done} 项已完成</p></div></header><div class="calendar-detail-actions">${actionButton({ label: '选择任务', symbol: 'plus', attrs: { 'data-calendar-action': 'choose' } })}${actionButton({ label: '新建任务', variant: 'text', attrs: { 'data-calendar-action': 'new' } })}</div><div class="task-list">${detail.tasks.map(task => taskRow(task, { project: state.projects.find(project => project.id === task.projectId), context: { showProject: true }, actions: `${canReorder && task.status !== 'done' ? actionButton({ label: '上移', symbol: 'up', iconOnly: true, variant: 'icon', attrs: { 'data-calendar-action': 'up', 'data-id': task.id, disabled: openIds[0] === task.id } }) + actionButton({ label: '下移', symbol: 'down', iconOnly: true, variant: 'icon', attrs: { 'data-calendar-action': 'down', 'data-id': task.id, disabled: openIds.at(-1) === task.id } }) : ''}${actionButton({ label: '改到日期', symbol: 'calendar', iconOnly: true, variant: 'icon', attrs: { 'data-calendar-action': 'reschedule', 'data-id': task.id } })}${actionButton({ label: '移出当天', symbol: 'close', iconOnly: true, variant: 'icon', attrs: { 'data-calendar-action': 'remove', 'data-id': task.id } })}` }).replaceAll('data-action=', 'data-calendar-action=')).join('') || `<p class="picker-empty">${route.query || route.projectId || route.unassigned || route.status !== 'all' ? '当前筛选下没有任务。' : '这一天没有安排。'}</p>`}</div>${taskClient.getPending() ? actionButton({ label: '重试原日历操作', attrs: { 'data-calendar-action': 'retry' } }) : ''}`;
  }
  function showReschedule(id) {
    const fromDay = route.selectedDay; reschedule?.dispose();
    reschedule = createDialogShell({ title: '改到日期', description: '仅移动当前日期的安排，其余安排和任务状态保持不变。' });
    reschedule.setContent(`<form data-calendar-reschedule>${dateField({ name: 'toDay', label: '目标日期', value: fromDay, required: true })}<p data-calendar-preview>请选择与 ${esc(fromDay)} 不同的日期。</p>${actionButton({ label: '确认改期', variant: 'primary', attrs: { type: 'submit', disabled: true } })}<p data-calendar-error role="alert"></p></form>`);
    const form = reschedule.element.querySelector('form');
    form.addEventListener('input', () => { const toDay = form.elements.toDay.value; form.querySelector('[type=submit]').disabled = !toDay || toDay === fromDay; form.querySelector('[data-calendar-preview]').textContent = `从 ${fromDay} 移到 ${toDay || '所选日期'}，其余安排不变`; });
    form.addEventListener('submit', async event => { event.preventDefault(); const toDay = form.elements.toDay.value; if (!toDay || toDay === fromDay) return; reschedule.setBusy(true); form.querySelector('[type=submit]').disabled = true; const success = await write({ type: 'plan.reschedule', id, fromDay, toDay }, '任务安排已改期'); reschedule.setBusy(false); if (success) reschedule.close(); else { form.querySelector('[type=submit]').disabled = false; form.querySelector('[data-calendar-error]').textContent = '改期未确认，当前日期输入已保留。请核对最新安排后重试。'; } });
    reschedule.open();
  }
  element.addEventListener('click', async event => {
    const button = event.target.closest('[data-calendar-action]'); if (!button || !element.contains(button) || button.disabled) return;
    const { calendarAction: action, id } = button.dataset;
    if (action === 'previous' || action === 'next') changeMonth(action === 'previous' ? -1 : 1);
    if (action === 'today') navigate({ selectedDay: localDate(), month: localDate().slice(0, 7) });
    if (action === 'edit') openTask(id);
    if (action === 'new') openTask(null, { planDay: route.selectedDay, projectId: route.projectId });
    if (action === 'choose') openPicker({ targetDay: route.selectedDay, onChoose: id => write({ type: 'plan.add', id }, '任务已加入 ' + route.selectedDay, route.selectedDay) });
    if (action === 'reschedule') showReschedule(id);
    if (action === 'remove') await write({ type: 'plan.remove', id, preserveExecution: true }, '已移出当天，任务仍保留', route.selectedDay);
    if (action === 'up' || action === 'down') await write({ type: 'plan.move', id, direction: action === 'up' ? -1 : 1 }, '已调整当日顺序', route.selectedDay);
    if (action === 'toggle') { const task = getTaskSnapshot().state.tasks.find(task => task.id === id); if (task.status !== 'done' && !confirmTaskCompletion(id)) return; await write({ type: 'task.status', id, status: task.status === 'done' ? 'todo' : 'done' }, task.status === 'done' ? '任务已恢复' : '任务已完成'); }
    if (action === 'retry') { try { await taskClient.retry(); notify('已核对日历操作', Boolean(taskClient.getUndo())); render(); } catch (error) { notify(error.message); } }
  }, { signal: abort.signal });
  element.addEventListener('input', event => { if (event.target.matches('[data-calendar-search]')) navigate({ query: event.target.value }, true); }, { signal: abort.signal });
  element.addEventListener('change', event => { const control = event.target.matches('workbench-select') ? event.target.querySelector('input') : event.target; if (control.name === 'calendar-project') navigate({ projectId: control.value.startsWith('project:') ? control.value.slice(8) : null, unassigned: control.value === 'unassigned' }, true); }, { signal: abort.signal });
  return { element, updateRoute(next) { route = { ...route, ...next }; if (visible) render(); }, updateState() { if (visible) render(); }, setVisible(value) { visible = value; element.hidden = !value; if (value) render(); }, dispose() { abort.abort(); grid.dispose(); statusDispose?.(); reschedule?.dispose(); element.remove(); } };
}
