import { addCivilDays, validateDateRange } from '../../core/date.js';
import { segmentedControl, mountSegmentedControl } from './segmented-control.js';
import { dateField } from './date-field.js';
export function createDateRange({ value, onChange, maxDays = 366 }) {
  const element = document.createElement('div'); element.className = 'ui-date-range'; const abort = new AbortController(); let current = value, disposeSegments;
  function update(next) {
    current = { preset: 'today', ...next }; disposeSegments?.();
    element.innerHTML = segmentedControl({ id: 'focus-range', label: '统计范围', value: current.preset, showLabel: true, options: [{ value: 'today', label: '今天' }, { value: '7', label: '近 7 天' }, { value: '30', label: '近 30 天' }, { value: 'custom', label: '自定义' }] }) + `<div class="ui-date-range-custom" ${current.preset === 'custom' ? '' : 'hidden'}>${dateField({ name: 'range-from', label: '开始日期', value: current.from, required: true, compact: true })}${dateField({ name: 'range-to', label: '结束日期', value: current.to, required: true, compact: true })}</div><p class="ui-date-range-error" role="alert"></p>`;
    disposeSegments = mountSegmentedControl(element.querySelector('.ui-segmented'), { onChange(preset) { if (preset === 'custom') { update({ ...current, preset }); return; } const to = current.today || current.to; const next = { ...current, preset, from: addCivilDays(to, preset === 'today' ? 0 : 1 - Number(preset)), to }; update(next); onChange(next); } });
  }
  element.addEventListener('change', event => {
    if (!event.target.name?.startsWith('range-')) return;
    const from = element.querySelector('[name=range-from]').value, to = element.querySelector('[name=range-to]').value;
    try { validateDateRange({ from, to, maxDays }); current = { ...current, preset: 'custom', from, to }; element.querySelector('[role=alert]').textContent = ''; onChange(current); }
    catch (error) { element.querySelector('[role=alert]').textContent = error.message; }
  }, { signal: abort.signal });
  update(value); return { element, update, dispose() { disposeSegments?.(); abort.abort(); element.remove(); } };
}
