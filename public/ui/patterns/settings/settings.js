import { html, attrs, slot, uid } from '../../core/html.js';
import { nav } from '../../components/nav/nav.js';

// settingsLayout({ navLabel, nav: sections, title, subtitle, children })
//   左侧二级导航（200 宽）+ 右侧内容。右侧 children 只接受 trusted() / 组件返回值。
export function settingsLayout({ navLabel = '设置分类', sections = [], title, subtitle = '', children = '' } = {}) {
  return html`<div class="dl-set"><aside class="dl-set__nav">${nav({ label: navLabel, kind: 'list', sections })}</aside><div class="dl-set__body"><h2 class="dl-set__title">${title}</h2>${subtitle ? html`<p class="dl-set__sub">${subtitle}</p>` : ''}${slot(children)}</div></div>`;
}

// settingsGroup({ title, rows, key }) —— 一张分组卡片（18 圆角，细线）
export function settingsGroup({ title, rows = [], key } = {}) {
  const id = uid('dl-sg');
  return html`<section class="dl-sgroup" aria-labelledby="${id}"${key ? attrs({ 'data-key': key }) : ''}>${title ? html`<h3 class="dl-sgroup__title" id="${id}">${title}</h3>` : ''}<div class="dl-sgroup__card" role="group" aria-labelledby="${id}">${slot(rows)}</div></section>`;
}

// settingsRow({ label, hint, hintTone, control, key }) —— 一行 60 高；control 靠右、统一右边缘；输入框 / 选择器宽 200。
export function settingsRow({ label, hint = '', hintTone, control = '', key } = {}) {
  return html`<div class="dl-srow"${key ? attrs({ 'data-key': key }) : ''}><div class="dl-srow__text"><div class="dl-srow__label">${label}</div>${hint ? html`<div class="${hintTone === 'error' ? 'dl-srow__hint is-error' : 'dl-srow__hint'}">${hint}</div>` : ''}</div><div class="dl-srow__control">${slot(control)}</div></div>`;
}
