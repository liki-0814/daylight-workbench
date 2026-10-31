import { html, attrs, cx, esc, flag } from '../../core/html.js';
import { icon } from '../../core/icons.js';

export const dotClass = color => `dl-dot--${['green', 'amber', 'neutral'].includes(color) ? color : 'neutral'}`;
export const dot = color => html`<i class="${cx('dl-dot', dotClass(color))}" aria-hidden="true"></i>`;

// chip({ label, icon, dot, empty, selected, interactive, attrs }) —— 胶囊属性标签。
//   interactive: true → <button>（页面级命令用 attrs 的 data-action）；否则 <span>。
//   select 组件的 variant:'chip' 也使用同一套样式（.dl-chip）。
export function chip({ label, icon: iconName, dot: dotColor, empty = false, selected = false, interactive = false, attrs: extra, id } = {}) {
  const inner = html`${dotColor ? dot(dotColor) : ''}${iconName ? icon(iconName, { size: 14 }) : ''}<span class="dl-chip__label">${label}</span>`;
  const cls = cx('dl-chip', empty && 'is-empty', selected && 'is-selected');
  return interactive
    ? html`<button class="${cls}" type="button"${id ? attrs({ id }) : ''}${attrs(extra)}${flag('aria-pressed="true"', selected)}>${inner}</button>`
    : html`<span class="${cls}"${id ? attrs({ id }) : ''}${attrs(extra)}>${inner}</span>`;
}
