import { html, attrs, flag } from '../../core/html.js';
import { icon } from '../../core/icons.js';
import { emit, sourceOf } from '../../core/events.js';
import { install } from '../../core/behave.js';

// checkbox({ name, checked, label, disabled, attrs }) —— 16px 圆形勾选，role="checkbox"，label 必填（aria-label）。
export function checkbox({ name, checked = false, label, disabled = false, attrs: extra, id } = {}) {
  if (!label) throw new TypeError('checkbox needs a label (aria-label)');
  return html`<button class="dl-check" type="button" role="checkbox" aria-checked="${checked ? 'true' : 'false'}" aria-label="${label}"${name ? attrs({ 'data-name': name }) : ''}${id ? attrs({ id }) : ''}${attrs(extra)}${flag('disabled', disabled)} data-ui-keep="aria-checked">${icon('check', { size: 12 })}</button>`;
}

install('checkbox', doc => doc.addEventListener('click', event => {
  const el = event.target.closest?.('.dl-check');
  if (!el || el.disabled) return;
  const previousValue = el.getAttribute('aria-checked') === 'true';
  el.setAttribute('aria-checked', String(!previousValue));
  if (!emit(el, 'change', { value: !previousValue, previousValue, source: sourceOf(event) }, { cancelable: true })) el.setAttribute('aria-checked', String(previousValue));
}));
