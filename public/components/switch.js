import { escapeButtonText as esc, buttonAttributes } from './button.js';
// 开关（design-spec §6）：原生 <input type="checkbox" role="switch">，键盘、表单与事件委托与复选框一致，只是语义与外观是开关。
// label：可访问名称（应含行名）；text/hint：可见文字；pending：暂存态（待应用，不只靠颜色）；busy：应用中；
// disabled + hint：禁用时必须写明原因；inputAttrs：如 data-*，原样写到 input 上。
export function switchControl({ label, text = '', hint = '', checked = false, disabled = false, pending = false, busy = false, title = '', className = '', inputAttrs = {} } = {}) {
  const input = buttonAttributes({ type: 'checkbox', role: 'switch', class: 'ui-switch-input', 'aria-label': label, 'aria-busy': busy ? 'true' : null, checked, disabled, ...inputAttrs });
  const note = busy ? '应用中…' : pending ? '待应用' : '';
  return `<label class="ui-switch ${pending ? 'is-pending' : ''} ${busy ? 'is-busy' : ''} ${esc(className)}"${title ? ` title="${esc(title)}"` : ''}><input ${input}><span class="ui-switch-copy">${text ? esc(text) : ''}${hint ? `<small>${esc(hint)}</small>` : ''}${note ? `<small class="ui-switch-note">${note}</small>` : ''}</span></label>`;
}
