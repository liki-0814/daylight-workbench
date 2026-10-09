import { selectTasks } from '../task-view.js';
import { taskRow } from './task-row.js';
import { actionButton, escapeButtonText as esc } from './button.js';
import { selectField } from './select.js';
export function createTaskPicker({ getState, onChoose, targetDay, mode = 'plan' }) {
  const element = document.createElement('section'); element.className = 'ui-task-picker';
  const abort = new AbortController(); let query = '', projectId = '', selecting = false;
  function update() {
    const state = getState(), tasks = selectTasks(state, { status: 'open', query, ...(projectId ? { projectId } : {}), day: targetDay }).tasks;
    element.innerHTML = `<div class="picker-filters"><input data-task-picker-search aria-label="查找任务" placeholder="查找任务…" value="${esc(query)}">${selectField({ name: 'task-picker-project', label: '项目', value: projectId, options: [{ value: '', label: '全部项目' }, ...state.projects.map(project => ({ value: project.id, label: project.name }))], compact: true })}</div><div class="picker-list">${tasks.map(task => { const planned = mode === 'plan' && (state.plans[targetDay] || []).includes(task.id); return taskRow(task, { project: state.projects.find(project => project.id === task.projectId), context: { choose: true }, actions: actionButton({ label: planned ? '已加入' : mode === 'focus' ? '开始专注' : '加入 ' + targetDay, symbol: planned ? 'check' : mode === 'focus' ? 'timer' : 'plus', attrs: { 'data-task-picker-id': task.id, disabled: planned || selecting } }) }); }).join('') || '<p class="picker-empty">当前筛选下没有待办任务。</p>'}</div>`;
    element.querySelectorAll('.task-text').forEach(button => { const text = document.createElement('div'); text.className = 'task-text'; text.innerHTML = button.innerHTML; button.replaceWith(text); });
  }
  element.addEventListener('input', event => { if (!event.target.matches('[data-task-picker-search]')) return; const position = event.target.selectionStart; query = event.target.value; update(); const input = element.querySelector('input'); input.focus(); input.setSelectionRange(position, position); }, { signal: abort.signal });
  element.addEventListener('change', event => { const control = event.target.matches('workbench-select') ? event.target.querySelector('input') : event.target; if (control.name === 'task-picker-project') { projectId = control.value; update(); } }, { signal: abort.signal });
  element.addEventListener('click', async event => { const button = event.target.closest('[data-task-picker-id]'); if (!button || !element.contains(button) || button.disabled || selecting) return; selecting = true; update(); try { await onChoose(button.dataset.taskPickerId); } finally { selecting = false; update(); } }, { signal: abort.signal });
  update(); return { element, update, dispose() { abort.abort(); element.remove(); } };
}
