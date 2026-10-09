import { addCivilDays, isCivilDate } from '../../core/date.js';
export function shiftCalendarMonth(day, delta) {
  if (!isCivilDate(day) || !Number.isSafeInteger(delta)) throw new Error('日期或月份偏移无效');
  const [year, month, date] = day.split('-').map(Number), index = Math.max(0, Math.min(9999 * 12 - 1, (year - 1) * 12 + month - 1 + delta));
  const nextYear = Math.floor(index / 12) + 1, nextMonth = index % 12 + 1, last = new Date(0); last.setUTCFullYear(nextYear, nextMonth, 0);
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-${String(Math.min(date, last.getUTCDate())).padStart(2, '0')}`;
}
export function shiftCalendarDay(day, delta) {
  if (!isCivilDate(day) || !Number.isSafeInteger(delta)) throw new Error('日期或天数偏移无效');
  try { return addCivilDays(day, delta); } catch { return delta < 0 ? '0001-01-01' : '9999-12-31'; }
}
export function createCalendarGrid({ onSelect, onMonthChange }) {
  const element = document.createElement('div'); element.className = 'ui-calendar-grid'; element.setAttribute('role', 'grid'); element.setAttribute('aria-label', '月历');
  const abort = new AbortController(); let selectedDay, days = [];
  function update(input) {
    const focused = element.contains(document.activeElement);
    selectedDay = input.selectedDay; days = input.days;
    element.replaceChildren();
    const header = document.createElement('div'); header.className = 'ui-calendar-week'; header.setAttribute('role', 'row');
    for (const label of ['一', '二', '三', '四', '五', '六', '日']) { const cell = document.createElement('span'); cell.textContent = label; cell.setAttribute('role', 'columnheader'); header.append(cell); } element.append(header);
    for (let index = 0; index < 42; index += 7) {
      const row = document.createElement('div'); row.className = 'ui-calendar-week'; row.setAttribute('role', 'row');
      for (const day of days.slice(index, index + 7)) {
        const cell = document.createElement('div'); cell.setAttribute('role', 'gridcell'); cell.setAttribute('aria-selected', String(day.day === selectedDay));
        if (!day.day) { cell.setAttribute('aria-disabled', 'true'); row.append(cell); continue; }
        const button = document.createElement('button'); button.type = 'button'; button.dataset.calendarDay = day.day; button.tabIndex = day.day === selectedDay ? 0 : -1; button.className = 'ui-calendar-day' + (day.inMonth ? '' : ' outside') + (day.day === selectedDay ? ' selected' : '');
        if (day.day === input.today) button.setAttribute('aria-current', 'date');
        const count = day.matchedCount ?? day.counts?.total ?? 0; button.setAttribute('aria-label', `${day.day}${day.day === input.today ? '，今天' : ''}，当前筛选 ${count} 项任务`);
        const date = document.createElement('span'); date.className = 'ui-calendar-date'; date.textContent = String(Number(day.day.slice(-2))); button.append(date);
        const summary = document.createElement('span'); summary.className = 'ui-calendar-count'; summary.textContent = count ? `${count} 项` : ''; button.append(summary);
        const dots = document.createElement('span'); dots.className = 'ui-calendar-dots'; dots.setAttribute('aria-hidden', 'true');
        for (const task of (day.preview || day.tasks || []).slice(0, 3)) { const preview = document.createElement('span'); preview.className = 'ui-calendar-preview' + (task.status === 'done' ? ' done' : ''); const dot = document.createElement('i'); dot.className = 'dot ' + (task.projectColor || 'neutral'); dot.setAttribute('aria-hidden', 'true'); preview.append(dot, document.createTextNode((task.status === 'done' ? '✓ ' : '') + task.title)); dots.append(dot.cloneNode()); button.append(preview); }
        button.append(dots);
        const extra = count - 3; if (extra > 0) { const more = document.createElement('span'); more.className = 'ui-calendar-more'; more.textContent = `还有 ${extra} 项`; button.append(more); }
        cell.append(button); row.append(cell);
      } element.append(row);
    }
    if (focused) element.querySelector(`[data-calendar-day="${selectedDay}"]`)?.focus({ preventScroll: true });
  }
  function select(day, replace) { onSelect(day, { replace }); }
  element.addEventListener('click', event => { const button = event.target.closest('[data-calendar-day]'); if (button && element.contains(button)) select(button.dataset.calendarDay, true); }, { signal: abort.signal });
  element.addEventListener('keydown', event => {
    const button = event.target.closest('[data-calendar-day]'); if (!button) return;
    const day = button.dataset.calendarDay, index = days.findIndex(item => item.day === day); let next;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) next = shiftCalendarDay(day, { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key]);
    if (event.key === 'Home') next = shiftCalendarDay(day, -(index % 7));
    if (event.key === 'End') next = shiftCalendarDay(day, 6 - index % 7);
    if (event.key === 'PageUp' || event.key === 'PageDown') { event.preventDefault(); onMonthChange(event.key === 'PageUp' ? -1 : 1, { keyboard: true }); return; }
    if (next) { event.preventDefault(); select(next, true); }
  }, { signal: abort.signal });
  return { element, update, dispose() { abort.abort(); element.remove(); } };
}
