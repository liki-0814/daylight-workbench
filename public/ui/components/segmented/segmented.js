import { html, attrs, cx } from '../../core/html.js';
import { emit, sourceOf } from '../../core/events.js';
import { install, moveFocus } from '../../core/behave.js';

// roving tabindex 的唯一判定（markup 与 render 共用，两条路径不会分叉）：恰好一个可 Tab 的项——选中项，没有选中项时取第一个未禁用项。
// entries: [{ active, disabled }]；返回下标，全部禁用时为 -1。
const tabbableIndex = entries => {
  const active = entries.findIndex(entry => entry.active);
  return active >= 0 ? active : entries.findIndex(entry => !entry.disabled);
};

// segmented({ name, value, label, options: [{ value, label, count }], attrs }) —— 单选分段（任务筛选）。role="radiogroup"。
export function segmented({ name, value = '', label, options = [], attrs: extra } = {}) {
  if (!label) throw new TypeError('segmented needs a label (aria-label)');
  const tabbable = tabbableIndex(options.map(option => ({ active: String(option.value) === String(value), disabled: !!option.attrs?.disabled })));
  return html`<div class="dl-seg" role="radiogroup" aria-label="${label}" data-ui="segmented"${name ? attrs({ 'data-name': name }) : ''}${attrs(extra)} data-ui-keep="data-value">${options.map((option, index) => html`<button class="${cx('dl-seg__item', String(option.value) === String(value) && 'is-active')}" type="button" role="radio" aria-checked="${String(option.value) === String(value) ? 'true' : 'false'}" tabindex="${index === tabbable ? 0 : -1}" data-value="${option.value}" data-key="${option.value}"${option.attrs ? attrs(option.attrs) : ''}><span>${option.label}</span>${option.count !== undefined ? html`<span class="dl-seg__count">${option.count}</span>` : ''}</button>`)}</div>`;
}

// 由「选中项」整体渲染分组状态：只有 active 带 is-active / aria-checked=true / tabindex=0，其余全部复位；active 为 null 表示没有选中项。
// 乐观更新与回滚都走这一个函数——回滚就是用原来的选中项（可能没有）再渲染一次，不逐个补丁 class / 属性。
// roving tabindex 由 tabbableIndex 决定（与 segmented() 的初始 markup 同一规则）。
function render(group, active) {
  const items = [...group.querySelectorAll('.dl-seg__item')];
  const tabbable = tabbableIndex(items.map(el => ({ active: el === active, disabled: el.disabled })));
  for (const [index, el] of items.entries()) {
    const on = el === active;
    el.classList.toggle('is-active', on);
    el.setAttribute('aria-checked', String(on));
    el.setAttribute('tabindex', index === tabbable ? '0' : '-1');
  }
}

function choose(group, item, event) {
  const previous = group.querySelector('.dl-seg__item.is-active');
  if (previous === item) return;
  const previousValue = previous?.dataset.value ?? '';
  render(group, item);
  if (!emit(group, 'change', { value: item.dataset.value ?? '', previousValue, source: sourceOf(event) }, { cancelable: true })) render(group, previous);
}
install('segmented', doc => {
  doc.addEventListener('click', event => { const item = event.target.closest?.('.dl-seg__item'); if (item) choose(item.closest('.dl-seg'), item, event); });
  doc.addEventListener('keydown', event => {
    const item = event.target.closest?.('.dl-seg__item');
    if (!item || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const group = item.closest('.dl-seg');
    const next = moveFocus([...group.querySelectorAll('.dl-seg__item')], item, event.key === 'ArrowLeft' ? 'ArrowUp' : event.key === 'ArrowRight' ? 'ArrowDown' : event.key);
    if (next) choose(group, next, event);
  });
});
