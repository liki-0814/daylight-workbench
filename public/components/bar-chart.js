import { actionButton } from './button.js';
const ns = 'http://www.w3.org/2000/svg';
export function createBarChart({ label, onSelect = () => {} }) {
  const element = document.createElement('section'); element.className = 'ui-bar-chart'; element.setAttribute('aria-label', label);
  const scroller = document.createElement('div'); scroller.className = 'ui-bar-chart-scroll';
  const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', label); scroller.append(svg);
  const toggle = document.createElement('div'); toggle.innerHTML = actionButton({ label: '查看数据表', variant: 'text', attrs: { 'data-chart-table': true, 'aria-expanded': 'false' } });
  const table = document.createElement('table'); table.hidden = true; table.className = 'ui-bar-chart-table';
  element.append(scroller, toggle, table); const abort = new AbortController();
  toggle.addEventListener('click', () => { table.hidden = !table.hidden; const button = toggle.querySelector('button'); button.setAttribute('aria-expanded', String(!table.hidden)); button.textContent = table.hidden ? '查看数据表' : '收起数据表'; }, { signal: abort.signal });
  function update(data) {
    svg.replaceChildren(); table.replaceChildren();
    const width = Math.max(560, data.length * 36), height = 210, max = Math.max(1, ...data.map(item => item.value));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height));
    const caption = document.createElement('caption'); caption.textContent = label; table.append(caption);
    const head = document.createElement('tr'); for (const title of ['日期', '专注计时']) { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = title; head.append(cell); } table.append(head);
    data.forEach((item, index) => {
      const step = width / Math.max(1, data.length), barWidth = Math.min(26, step - 6), barHeight = item.value / max * 160;
      const group = document.createElementNS(ns, 'g'); group.setAttribute('role', 'button'); group.setAttribute('tabindex', '0'); group.setAttribute('aria-label', `${item.label}，${item.valueText}`); group.dataset.chartKey = item.key;
      const title = document.createElementNS(ns, 'title'); title.textContent = `${item.label} · ${item.valueText}`;
      const rect = document.createElementNS(ns, 'rect'); for (const [key, value] of Object.entries({ x: index * step + (step - barWidth) / 2, y: 176 - barHeight, width: barWidth, height: Math.max(2, barHeight), rx: 3 })) rect.setAttribute(key, String(value));
      const text = document.createElementNS(ns, 'text'); text.setAttribute('x', String(index * step + step / 2)); text.setAttribute('y', '198'); text.setAttribute('text-anchor', 'middle'); text.textContent = item.label;
      group.append(title, rect, text); svg.append(group);
      const row = document.createElement('tr'); for (const value of [item.label, item.valueText]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); } table.append(row);
    });
  }
  svg.addEventListener('click', event => { const group = event.target.closest('[data-chart-key]'); if (group) onSelect(group.dataset.chartKey); }, { signal: abort.signal });
  svg.addEventListener('keydown', event => { const group = event.target.closest('[data-chart-key]'); if (!group) return; if (['Enter', ' '].includes(event.key)) { event.preventDefault(); onSelect(group.dataset.chartKey); } if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const groups = [...svg.querySelectorAll('[data-chart-key]')], index = groups.indexOf(group); groups[Math.max(0, Math.min(groups.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)))].focus(); } }, { signal: abort.signal });
  return { element, update, dispose() { abort.abort(); element.remove(); } };
}
