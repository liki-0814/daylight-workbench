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

// ⌘F（0.7 PR-6）：原生菜单只负责触发——在网页里 window.dispatchEvent(new CustomEvent('daylight-find', { cancelable: true }))；
// 网页把焦点放到当前页可见的搜索框并全选；没有可见搜索框就什么都不做（dispatchEvent 返回 true，原生侧可据此回退到系统查找）；
// 处理了则对事件 preventDefault()（dispatchEvent 返回 false）。有打开的对话框时只在对话框里找（背景是 inert）。
export const findEventName = 'daylight-find';
const searchInputSelector = 'input[type="search"]';   // searchField 组件的输入框，以及模型路由 / CLI 页自带的 type=search 输入框
const isShown = el => el.isConnected && !el.disabled && !el.closest('[hidden], [inert]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
export function focusVisibleSearchField(root = globalThis.document) {
  if (!root?.querySelectorAll) return false;
  const dialog = globalThis.document?.querySelector('dialog[open]');
  const scope = dialog || root;
  const input = [...scope.querySelectorAll(searchInputSelector)].find(isShown);
  if (!input) return false;
  input.focus(); input.select();
  return true;
}
const onDaylightFind = event => { if (focusVisibleSearchField(document)) event.preventDefault(); };
// 只装一次（模块被重复加载或热更新也不会重复监听）；返回的函数可移除监听，测试用。
export function installFindListener(target = globalThis.window) {
  if (!target?.addEventListener) return () => {};
  const key = Symbol.for('daylight.find.installed');
  if (target[key]) return target[key];
  target.addEventListener(findEventName, onDaylightFind);
  const remove = () => { target.removeEventListener(findEventName, onDaylightFind); delete target[key]; };
  target[key] = remove; return remove;
}
installFindListener();
