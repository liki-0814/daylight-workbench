import { html, attrs, flag } from '../../core/html.js';
import { icon } from '../../core/icons.js';
import { emit, sourceOf } from '../../core/events.js';
import { install } from '../../core/behave.js';

// checkbox({ name, checked, label, disabled, attrs }) —— 16px 圆形勾选，role="checkbox"，label 必填（aria-label）。
//   受控组件（同 switch）：aria-checked 永远以 props 里的 checked 为准。点击先乐观翻转；保存失败时页面用未变的 state 重绘，morph 会把它写回，页面不碰 aria。
export function checkbox({ name, checked = false, label, disabled = false, attrs: extra, id } = {}) {
  if (!label) throw new TypeError('checkbox needs a label (aria-label)');
  return html`<button class="dl-check" type="button" role="checkbox" aria-checked="${checked ? 'true' : 'false'}" aria-label="${label}"${name ? attrs({ 'data-name': name }) : ''}${id ? attrs({ id }) : ''}${attrs(extra)}${flag('disabled', disabled)}>${icon('check', { size: 12 })}</button>`;
}

install('checkbox', doc => doc.addEventListener('click', event => {
  const el = event.target.closest?.('.dl-check');
  if (!el || el.disabled) return;
  const previousValue = el.getAttribute('aria-checked') === 'true';
  el.setAttribute('aria-checked', String(!previousValue));
  if (!emit(el, 'change', { value: !previousValue, previousValue, source: sourceOf(event) }, { cancelable: true })) el.setAttribute('aria-checked', String(previousValue));
}));
