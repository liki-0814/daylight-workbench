import { html, attrs, cx, esc, slot, uid } from '../../core/html.js';
import { nav } from '../../components/nav/nav.js';

// settingsLayout({ navLabel, sections, title, subtitle, children, scroll })
//   左侧二级导航（200 宽）+ 右侧内容。右侧 children 只接受 trusted() / 组件返回值。
//   scroll: 'body'（默认，右侧内容自己滚动）| 'page'（整页滚动，由外层页面决定高度；设置页用这个）
export function settingsLayout({ navLabel = '设置分类', sections = [], title, subtitle = '', children = '', scroll = 'body' } = {}) {
  return html`<div class="dl-set" data-scroll="${scroll === 'page' ? 'page' : 'body'}"><aside class="dl-set__nav">${nav({ label: navLabel, kind: 'list', sections })}</aside><div class="dl-set__body"><h2 class="dl-set__title">${title}</h2>${subtitle ? html`<p class="dl-set__sub">${subtitle}</p>` : ''}${slot(children)}</div></div>`;
}

// settingsGroup({ title, rows, key, flush }) —— 一张分组卡片（18 圆角，细线）
//   flush: true 时不带下外边距、不限制宽度（放进已经有间距 / 宽度的容器里，如代理服务卡）
export function settingsGroup({ title, rows = [], key, flush = false } = {}) {
  const id = uid('dl-sg');
  return html`<section class="dl-sgroup"${flush ? attrs({ 'data-flush': '' }) : ''} aria-labelledby="${id}"${key ? attrs({ 'data-key': key }) : ''}>${title ? html`<h3 class="dl-sgroup__title" id="${id}">${title}</h3>` : ''}<div class="dl-sgroup__card" role="group" aria-labelledby="${id}">${slot(rows)}</div></section>`;
}

// settingsRow({ label, hint, hintTone, control, key, controlWidth }) —— 一行 60 高；control 靠右、统一右边缘。
//   controlWidth: 'auto'（默认，控件列按内容宽；输入框 / 选择器固定 var(--ui-srow-control-w)=200，按钮不小于 var(--ui-srow-button-w)=112）
//               | 'fixed'（控件列整列固定 var(--ui-srow-control-w) 宽，里面的控件撑满；用于一列里要左右对齐的行）
export function settingsRow({ label, hint = '', hintTone, control = '', key, controlWidth = 'auto' } = {}) {
  return html`<div class="dl-srow" data-control="${controlWidth === 'fixed' ? 'fixed' : 'auto'}"${key ? attrs({ 'data-key': key }) : ''}><div class="dl-srow__text"><div class="dl-srow__label">${label}</div>${hint ? html`<div class="${hintTone === 'error' ? 'dl-srow__hint is-error' : 'dl-srow__hint'}">${hint}</div>` : ''}</div><div class="dl-srow__control">${slot(control)}</div></div>`;
}

// settingsReadout({ text, mono, attrs }) —— 行右侧的只读文字（路径 / 地址 / 状态）。右对齐、超长在任意位置折行，最宽 var(--ui-srow-readout-w)=420。
export function settingsReadout({ text = '', mono = false, attrs: extra } = {}) {
  return html`<span class="${cx('dl-readout', mono && 'dl-readout--mono')}"${attrs(extra)}>${text}</span>`;
}
