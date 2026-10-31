import { html, attrs, cx, esc, flag } from '../../core/html.js';
import { icon } from '../../core/icons.js';

// iconButton({ label, icon, variant, size, attrs, disabled }) —— label 必填，作为 aria-label 和 title。
//   variant: default | send | ghost；size: md(36) | sm(28，最小点击目标)
export function iconButton({ label, icon: iconName, variant = 'default', size = 'md', attrs: extra, disabled = false, id } = {}) {
  if (!label) throw new TypeError('iconButton needs a label (aria-label)');
  return html`<button class="${cx('dl-icon-btn', `dl-icon-btn--${esc(variant)}`, size === 'sm' && 'dl-icon-btn--sm')}" type="button" aria-label="${label}" title="${label}"${id ? attrs({ id }) : ''}${attrs(extra)}${flag('disabled', disabled)}>${icon(iconName, { size: size === 'sm' ? 14 : 16 })}</button>`;
}
