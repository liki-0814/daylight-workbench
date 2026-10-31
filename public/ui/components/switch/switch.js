import { html, attrs, flag, trusted } from '../../core/html.js';
import { emit, sourceOf } from '../../core/events.js';
import { install } from '../../core/behave.js';

// switchControl({ name, checked, label, busy, disabled, attrs }) —— role="switch"，label 必填（aria-label）。
export function switchControl({ name, checked = false, label, busy = false, disabled = false, attrs: extra, id } = {}) {
  if (!label) throw new TypeError('switch needs a label (aria-label)');
  return html`<button class="dl-switch" type="button" role="switch" aria-checked="${checked ? 'true' : 'false'}" aria-label="${label}"${name ? attrs({ 'data-name': name }) : ''}${id ? attrs({ id }) : ''}${busy ? trusted(' aria-busy="true"') : ''}${attrs(extra)}${flag('disabled', disabled)} data-ui-keep="aria-checked"><span class="dl-switch__thumb"></span></button>`;
}

install('switch', doc => doc.addEventListener('click', event => {
  const el = event.target.closest?.('.dl-switch');
  if (!el || el.disabled) return;
  const previousValue = el.getAttribute('aria-checked') === 'true';
  el.setAttribute('aria-checked', String(!previousValue)); // 乐观更新
  if (!emit(el, 'change', { value: !previousValue, previousValue, source: sourceOf(event) }, { cancelable: true })) el.setAttribute('aria-checked', String(previousValue));
}));
