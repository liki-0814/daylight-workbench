import { icon } from './icons.js';
import { escapeButtonText as esc } from './button.js';

const pad = value => String(value).padStart(2, '0');
function doneDate(completedAt) {
  const date = new Date(completedAt);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const monthDay = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return date.getFullYear() === now.getFullYear() ? monthDay : `${date.getFullYear()}-${monthDay}`;
}

/** Context and actions come from the owner; this template owns no task state. */
export function taskRow(task, { busy = false } = {}) {
  const done = task.status === 'done';
  const date = done ? doneDate(task.completedAt) : '';
  const notes = String(task.notes || '').replace(/\s+/g, ' ').trim();
  const meta = `${task.status === 'active' ? '<span class="task-meta-chip">进行中</span>' : ''}${notes ? `<span class="task-meta-notes">${esc(notes.slice(0, 80))}</span>` : ''}`;
  return `<div class="task-row ${done ? 'done' : ''}" data-task="${esc(task.id)}"><button class="check-button" data-action="toggle" data-id="${esc(task.id)}" aria-label="${done ? '恢复' : '完成'}：${esc(task.title)}" ${busy ? 'disabled' : ''}>${done ? icon('check') : ''}</button><button class="task-text" data-action="edit" data-id="${esc(task.id)}" title="编辑任务"><span class="task-title">${esc(task.title)}</span>${meta ? `<span class="task-row-meta">${meta}</span>` : ''}</button>${date ? `<span class="task-date">${date}</span>` : ''}</div>`;
}
