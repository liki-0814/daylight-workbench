import { icon } from './icons.js';
import { escapeButtonText as esc } from './button.js';

/** Context and actions come from the owner; this template owns no task state. */
export function taskRow(task, { project, showProject = true, busy = false } = {}) {
  const done = task.status === 'done';
  return `<div class="task-row ${done ? 'done' : ''}" data-task="${esc(task.id)}"><div class="ui-first-line-slot"><button class="check-button" data-action="toggle" data-id="${esc(task.id)}" aria-label="${done ? '恢复' : '完成'}：${esc(task.title)}" ${busy ? 'disabled' : ''}>${done ? icon('check') : ''}</button></div><button class="task-text" data-action="edit" data-id="${esc(task.id)}" title="编辑任务"><span class="task-title">${esc(task.title)}</span>${showProject ? `<span class="task-meta"><i class="dot ${esc(project?.color || 'neutral')}"></i>${esc(project?.name || '未归类')}</span>` : ''}</button></div>`;
}
