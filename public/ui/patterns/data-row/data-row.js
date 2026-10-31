import { html, attrs, cx, slot } from '../../core/html.js';
import { icon } from '../../core/icons.js';
import { emit, sourceOf } from '../../core/events.js';
import { install, moveFocus } from '../../core/behave.js';
import { checkbox } from '../../components/checkbox/checkbox.js';
import { button } from '../../components/button/button.js';
import { dot } from '../../components/chip/chip.js';

// 列（README v5）：复选 16 · 编号 56（等宽）· 标题（弹性）· 优先级 20（居中）· 截止 76（左对齐，tabular-nums）· 行内操作 76（悬停 / 选中才显示）
const LEVELS = { high: [3, '高'], medium: [2, '中'], low: [1, '低'] };
export function priorityMark(level) {
  const [on, text] = LEVELS[level] || [0, '未设置'];
  return html`<span class="dl-pri" role="img" aria-label="优先级${text}">${[1, 2, 3].map(n => html`<i class="${on >= n ? '' : 'is-off'}"></i>`)}</span>`;
}

// groupHeader({ key, label, dot, count }) —— 40 高分组头，不用深色块
export function groupHeader({ key, label, dot: color, count } = {}) {
  return html`<h2 class="dl-group" data-key="group-${key}">${color ? dot(color) : ''}<span>${label}</span><span class="dl-group__count">${count}</span></h2>`;
}

// taskRow({ id, code, title, done, priority, due: { text, tone }, selected, action: { label, attrs } })
//   整行可聚焦；点击 / Enter / Space 派发 ui:select（value = id）；勾选框是 checkbox 组件，自己派发 ui:change。
export function taskRow({ id, code, title, done = false, priority, due, selected = false, action, checkLabel = '标记完成' } = {}) {
  return html`<div class="${cx('dl-row', selected && 'is-selected', done && 'is-done')}" role="listitem" tabindex="0" data-ui="row" data-id="${id}" data-key="row-${id}"${selected ? html` aria-current="true"` : ''}>${checkbox({ checked: done, label: `${checkLabel}：${title}`, name: 'done' })}<span class="dl-row__id">${code}</span><span class="dl-row__title">${title}</span>${priorityMark(priority)}<span class="${cx('dl-row__due', due?.tone && `is-${due.tone}`)}">${due?.text || '—'}</span><span class="dl-row__action">${action ? html`<button class="dl-chip" type="button"${attrs(action.attrs)}>${icon(action.icon || 'bolt', { size: 14 })}<span class="dl-chip__label">${action.label}</span></button>` : ''}</span></div>`;
}

// rowList({ label, children }) —— 一组行（role="list"）
export function rowList({ label, children = '', key } = {}) {
  return html`<div class="dl-rows" role="list" aria-label="${label}"${key ? attrs({ 'data-key': key }) : ''}>${slot(children)}</div>`;
}

// rowEmpty({ title, hint, action }) —— 列表为空时的说明（不画插图，只一句话 + 可选操作）。
export function rowEmpty({ title, hint = '', action } = {}) {
  return html`<div class="dl-rows-empty" data-key="empty"><p class="dl-rows-empty__title">${title}</p>${hint ? html`<p class="dl-rows-empty__hint">${hint}</p>` : ''}${action ? button({ label: action.label, attrs: action.attrs }) : ''}</div>`;
}

install('data-row', doc => {
  doc.addEventListener('click', event => {
    const row = event.target.closest?.('.dl-row');
    if (!row || event.target.closest('button, a, input')) return;
    emit(row, 'select', { value: row.dataset.id ?? '', source: sourceOf(event) });
  });
  doc.addEventListener('keydown', event => {
    const row = event.target.closest?.('.dl-row');
    if (!row || event.target !== row) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); emit(row, 'select', { value: row.dataset.id ?? '', source: 'keyboard' }); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); moveFocus([...row.closest('main, body').querySelectorAll('.dl-row')], row, event.key); }
  });
});
