import { html, esc, attrs, cx, trusted, slot, flag } from '../../core/html.js';
import { icon } from '../../core/icons.js';

// button({ label, icon, variant, kbd, attrs, disabled, busy, type, children })
//   variant: default | primary | ghost | danger；每个视图只放一个 primary。
//   页面级命令用 attrs: { 'data-action': 'create-task' }；按钮自己不派发 ui:* 事件。
export function button({ label = '', icon: iconName, variant = 'default', kbd, attrs: extra, disabled = false, busy = false, type = 'button', children, className, id } = {}) {
  const content = children === undefined ? html`<span class="dl-btn__label">${label}</span>` : html`<span class="dl-btn__label">${slot(children)}</span>`;
  return html`<button class="${cx('dl-btn', `dl-btn--${esc(variant)}`, className)}" type="${type === 'submit' ? 'submit' : 'button'}"${id ? attrs({ id }) : ''}${attrs(extra)}${flag('disabled', disabled)}${busy ? trusted(' aria-busy="true"') : ''}>${iconName ? icon(iconName, { size: 14 }) : ''}${content}${kbd ? html`<kbd class="dl-kbd">${kbd}</kbd>` : ''}</button>`;
}
