import { html, attrs, flag, trusted } from '../../core/html.js';
import { emit, sourceOf } from '../../core/events.js';
import { install } from '../../core/behave.js';

// switchControl({ name, checked, label, busy, disabled, attrs }) —— role="switch"，label 必填（aria-label）。
//   受控组件：aria-checked 永远以 props 里的 checked 为准。点击时先乐观翻转，ui:change 被取消则回滚；页面随后用 view() 带着真实的 checked 重绘（morph 会把它写回），页面不需要也不应该补写 aria-checked。
export function switchControl({ name, checked = false, label, busy = false, disabled = false, attrs: extra, id } = {}) {
  if (!label) throw new TypeError('switch needs a label (aria-label)');
  return html`<button class="dl-switch" type="button" role="switch" aria-checked="${checked ? 'true' : 'false'}" aria-label="${label}"${name ? attrs({ 'data-name': name }) : ''}${id ? attrs({ id }) : ''}${busy ? trusted(' aria-busy="true"') : ''}${attrs(extra)}${flag('disabled', disabled)}><span class="dl-switch__thumb"></span></button>`;
}

install('switch', doc => doc.addEventListener('click', event => {
  const el = event.target.closest?.('.dl-switch');
  if (!el || el.disabled) return;
  const previousValue = el.getAttribute('aria-checked') === 'true';
  el.setAttribute('aria-checked', String(!previousValue)); // 乐观更新
  if (!emit(el, 'change', { value: !previousValue, previousValue, source: sourceOf(event) }, { cancelable: true })) el.setAttribute('aria-checked', String(previousValue));
}));
