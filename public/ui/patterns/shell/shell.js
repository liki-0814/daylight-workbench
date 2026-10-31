import { html, slot, attrs } from '../../core/html.js';

// pageLayout({ toolbar, body, inspector, footer, id, label }) —— 一个页面：顶部 toolbar + 主体（可选右侧 inspector）+ 底部状态条。
//   所有参数只接受 trusted() / 组件返回值。左侧让出全局侧栏宽度。
export function pageLayout({ id, label, toolbar = '', body = '', inspector = '', footer = '', attrs: extra } = {}) {
  return html`<main class="dl-page"${id ? attrs({ id }) : ''}${label ? attrs({ 'aria-label': label }) : ''}${attrs(extra)}>${slot(toolbar)}<div class="${inspector ? 'dl-page__split has-inspector' : 'dl-page__split'}"><div class="dl-page__main">${slot(body)}</div>${inspector ? html`<div class="dl-page__aside">${slot(inspector)}</div>` : ''}</div>${footer ? html`<footer class="dl-foot">${slot(footer)}</footer>` : ''}</main>`;
}
