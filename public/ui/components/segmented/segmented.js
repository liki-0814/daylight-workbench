import { html, attrs, cx } from '../../core/html.js';
import { emit, sourceOf } from '../../core/events.js';
import { install, moveFocus } from '../../core/behave.js';

// segmented({ name, value, label, options: [{ value, label, count }], attrs }) —— 单选分段（任务筛选）。role="radiogroup"。
export function segmented({ name, value = '', label, options = [], attrs: extra } = {}) {
  if (!label) throw new TypeError('segmented needs a label (aria-label)');
  return html`<div class="dl-seg" role="radiogroup" aria-label="${label}" data-ui="segmented"${name ? attrs({ 'data-name': name }) : ''}${attrs(extra)} data-ui-keep="data-value">${options.map(option => html`<button class="${cx('dl-seg__item', String(option.value) === String(value) && 'is-active')}" type="button" role="radio" aria-checked="${String(option.value) === String(value) ? 'true' : 'false'}" tabindex="${String(option.value) === String(value) ? 0 : -1}" data-value="${option.value}" data-key="${option.value}"${option.attrs ? attrs(option.attrs) : ''}><span>${option.label}</span>${option.count !== undefined ? html`<span class="dl-seg__count">${option.count}</span>` : ''}</button>`)}</div>`;
}

function choose(group, item, event) {
  const previous = group.querySelector('.dl-seg__item.is-active');
  if (previous === item) return;
  const previousValue = previous?.dataset.value ?? '';
  const flip = (from, to) => {
    from?.classList.remove('is-active'); from?.setAttribute('aria-checked', 'false'); from?.setAttribute('tabindex', '-1');
    to.classList.add('is-active'); to.setAttribute('aria-checked', 'true'); to.setAttribute('tabindex', '0');
  };
  flip(previous, item);
  if (!emit(group, 'change', { value: item.dataset.value ?? '', previousValue, source: sourceOf(event) }, { cancelable: true })) flip(item, previous || item);
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
