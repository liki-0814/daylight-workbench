import { escapeButtonText as esc, buttonAttributes } from './button.js';
import { icon } from './icons.js';
// 搜索框（design-spec §6）：高 28 灰底圆角 8，搜索图标 + 占位符 + 清除按钮（SVG，aria-label="清除搜索"，命中 28×28，不用文字 ✕）。
// 有内容才显示清除按钮；清除后焦点回到输入框并派发 input 事件，所以页面只需监听 input。
// className 加到外层（保持页面已有的选择器，如 extension-search）；inputAttrs 写到 input 上。
export function searchField({ label, placeholder = '', value = '', className = '', inputAttrs = {} } = {}) {
  const input = buttonAttributes({ type: 'search', class: 'ui-search-input', placeholder, value: value || null, 'aria-label': label, autocomplete: 'off', ...inputAttrs });
  return `<div class="ui-search ${esc(className)}"><span class="ui-search-icon">${icon('search')}</span><input ${input}><button type="button" class="ui-search-clear" aria-label="清除搜索" title="清除搜索" data-search-clear ${value ? '' : 'hidden'}>${icon('close')}</button></div>`;
}
export function mountSearchField(root, { onClear = () => {} } = {}) {
  const abort = new AbortController(), options = { signal: abort.signal };
  const input = root.querySelector('input'), clear = root.querySelector('[data-search-clear]');
  const sync = () => { clear.hidden = !input.value; };
  input.addEventListener('input', sync, options);
  clear.addEventListener('click', () => { input.value = ''; sync(); input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); onClear(); }, options);
  input.addEventListener('keydown', event => { if (event.key === 'Escape' && input.value) { event.preventDefault(); clear.click(); } }, options);
  sync();
  return { sync, dispose: () => abort.abort() };
}
