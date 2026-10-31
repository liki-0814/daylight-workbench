import { html, attrs, cx, esc, flag, uid } from '../../core/html.js';
import { icon } from '../../core/icons.js';
import { emit, sourceOf } from '../../core/events.js';
import { install } from '../../core/behave.js';

// input({ name, value, label, placeholder, type, variant, icon, kbd, mono, align, live, invalid, multiline, rows, attrs })
//   variant: field（默认，带边框）| title（无边框大标题）| bare（无边框正文）| pill（胶囊，搜索）
//   label 是 aria-label（必填）。live: true 时每次输入都派发 ui:change；否则在失焦 / 回车（change）时派发一次。
//   用户输入的值通过 value 属性回填时经 esc()。
export function input({ name, value = '', label, placeholder = '', type = 'text', variant = 'field', icon: iconName, kbd, mono = false, align, live = false, invalid = false, multiline = false, rows = 3, disabled = false, autofocus = false, attrs: extra, id } = {}) {
  if (!label) throw new TypeError('input needs a label (aria-label)');
  const common = attrs({ class: 'dl-input__control', name, 'aria-label': label, placeholder, id, 'data-ui-keep': 'value', 'data-prev': value, 'data-live': live ? '1' : false, 'aria-invalid': invalid ? 'true' : false });
  const control = multiline
    ? html`<textarea${common} rows="${Number(rows) || 3}"${flag('disabled', disabled)}${flag('autofocus', autofocus)}${attrs(extra)}>${value}</textarea>`
    : html`<input${common} type="${['text', 'search', 'number', 'url', 'email', 'password'].includes(type) ? type : 'text'}" value="${value}"${flag('disabled', disabled)}${flag('autofocus', autofocus)}${attrs(extra)}>`;
  return html`<span class="${cx('dl-input', `dl-input--${esc(variant)}`, mono && 'dl-input--mono', align === 'end' && 'dl-input--end', invalid && 'is-invalid')}" data-ui="input">${iconName ? icon(iconName, { size: 14 }) : ''}${control}${kbd ? html`<kbd class="dl-kbd">${kbd}</kbd>` : ''}</span>`;
}

function commit(event, control) {
  const previousValue = control.dataset.prev ?? '';
  if (control.value === previousValue) return;
  const proceed = emit(control, 'change', { value: control.value, previousValue, source: sourceOf(event) }, { cancelable: true });
  if (proceed) control.dataset.prev = control.value;
  else control.value = previousValue;
}
install('input', doc => {
  doc.addEventListener('change', event => { const el = event.target; if (el.matches?.('.dl-input__control') && el.dataset.live !== '1') commit(event, el); });
  doc.addEventListener('input', event => { const el = event.target; if (el.matches?.('.dl-input__control[data-live="1"]') && !event.isComposing) commit(event, el); });
  doc.addEventListener('compositionend', event => { const el = event.target; if (el.matches?.('.dl-input__control[data-live="1"]')) commit(event, el); });
});
