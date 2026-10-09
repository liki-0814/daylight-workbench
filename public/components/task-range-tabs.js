import { icon } from './icons.js';
import { buttonAttributes, escapeButtonText as esc } from './button.js';

const options = [
  { value: 'all', label: '全部任务' },
  { value: 'today', label: '今天', symbol: 'sun' },
  { value: 'calendar', label: '日历', symbol: 'calendar' },
];

export function taskRangeTabs({ view } = {}) {
  const selected = view === 'today' || view === 'calendar' ? view : 'all';
  return `<div class="task-range-tabs" role="group" aria-label="任务范围">${options.map(option => `<button ${buttonAttributes({ type: 'button', class: option.value === selected ? 'chosen' : '', 'data-view': option.value, 'aria-current': option.value === selected ? 'page' : null })}>${option.symbol ? icon(option.symbol) : ''}${esc(option.label)}</button>`).join('')}</div>`;
}
