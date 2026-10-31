import { html, attrs, cx, esc, slot, flag } from '../../core/html.js';
import { icon } from '../../core/icons.js';
import { dot } from '../chip/chip.js';
import { emit, sourceOf } from '../../core/events.js';
import { install, moveFocus } from '../../core/behave.js';
import { morph } from '../../core/morph.js';

// navItem({ value, label, icon, dot, count, active, kbd, attrs })
function navItem({ value, label, icon: iconName, dot: dotColor, count, active = false, kbd, attrs: extra }) {
  return html`<button class="${cx('dl-nav__item', active && 'is-active')}" type="button" data-value="${value}" data-key="${value}"${active ? html` aria-current="page"` : ''}${attrs(extra)}>${dotColor ? dot(dotColor) : iconName ? icon(iconName, { size: 16 }) : ''}<span class="dl-nav__label">${label}</span>${kbd ? html`<kbd class="dl-kbd">${kbd}</kbd>` : ''}${count !== undefined && count !== null && count !== '' ? html`<span class="dl-nav__count">${count}</span>` : ''}</button>`;
}

// nav({ label, name, sections: [{ title, items, action }], footer: items, header, kind })
//   name：写到 data-name，页面只靠它区分同一页里的多个导航（ui:select 的 event.target.dataset.name）。
//   kind: 'sidebar'（固定在窗口左侧的全局导航）| 'list'（页面内的二级导航，如设置左栏）
//   header：品牌区，children 必须是 trusted() / 组件返回值。
export function nav({ label, name, sections = [], footer = [], header = '', kind = 'sidebar', attrs: extra } = {}) {
  if (!label) throw new TypeError('nav needs a label (aria-label)');
  const body = sections.map(section => html`<section class="dl-nav__section" data-key="${section.key ?? section.title ?? 'main'}">${section.title ? html`<h2 class="dl-nav__title">${section.title}${section.action ? html`<button class="dl-nav__add" type="button" aria-label="${section.action.label}" title="${section.action.label}"${attrs(section.action.attrs)}>${icon('plus', { size: 14 })}</button>` : ''}</h2>` : ''}${section.items.map(navItem)}${section.empty ? html`<p class="dl-nav__empty">${section.empty}</p>` : ''}</section>`);
  return html`<nav class="${cx('dl-nav', `dl-nav--${kind === 'list' ? 'list' : 'sidebar'}`)}" aria-label="${label}" data-ui="nav"${name ? html` data-name="${name}"` : ''}${attrs(extra)}>${header ? html`<div class="dl-nav__header">${slot(header)}</div>` : ''}<div class="dl-nav__scroll">${body}</div>${footer.length ? html`<div class="dl-nav__footer">${footer.map(navItem)}</div>` : ''}</nav>`;
}

// updateNav(host, content) —— 重绘侧栏 / 列表导航（morph）并保住可滚动区域的 scrollTop。页面不要自己去查 .dl-nav__scroll。
export function updateNav(host, content) {
  const area = () => host.querySelector('.dl-nav__scroll');
  const top = area()?.scrollTop ?? 0;
  morph(host, content);
  const next = area();
  if (next && next.scrollTop !== top) next.scrollTop = top;
  return host;
}

install('nav', doc => {
  doc.addEventListener('click', event => {
    const item = event.target.closest?.('.dl-nav__item');
    if (!item || !item.closest('.dl-nav')) return;
    emit(item.closest('.dl-nav'), 'select', { value: item.dataset.value ?? '', source: sourceOf(event) });
  });
  doc.addEventListener('keydown', event => {
    const item = event.target.closest?.('.dl-nav__item');
    if (!item || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    moveFocus([...item.closest('.dl-nav').querySelectorAll('.dl-nav__item')], item, event.key);
  });
});
