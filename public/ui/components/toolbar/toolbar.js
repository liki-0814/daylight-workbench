import { html, attrs, slot } from '../../core/html.js';

// toolbar({ title, subtitle, start, end }) —— 页面顶部 56 高工具栏，底部细线。start / end 只接受 trusted() / 组件返回值。
export function toolbar({ title, count, start = '', end = '', attrs: extra } = {}) {
  return html`<header class="dl-toolbar"${attrs(extra)}><h1 class="dl-toolbar__title">${title}${count !== undefined && count !== null ? html`<span class="dl-toolbar__count">${count}</span>` : ''}</h1><div class="dl-toolbar__start">${slot(start)}</div><div class="dl-toolbar__end">${slot(end)}</div></header>`;
}
