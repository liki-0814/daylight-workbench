import { html, attrs, cx, esc } from '../../core/html.js';

export const spinner = () => html`<i class="dl-spinner" aria-hidden="true"></i>`;

// statusTag({ tone, label, dashed, spinner, detail }) —— 小状态标签。tone: success | neutral | warning | error | info
//   dashed：虚线边（启动中）；spin：左侧青绿色加载圈；颜色之外一律带文字（不靠颜色单独传达）。
export function statusTag({ tone = 'neutral', label, dashed = false, spin = false, dot = true, attrs: extra, id } = {}) {
  const lead = spin ? spinner() : dot ? html`<i class="dl-tag__dot" aria-hidden="true"></i>` : '';
  return html`<span class="${cx('dl-tag', `dl-tag--${esc(tone)}`, dashed && 'is-dashed')}" data-key="tag-${tone}${spin ? '-spin' : ''}"${id ? attrs({ id }) : ''}${attrs(extra)}>${lead}<span>${label}</span></span>`;
}
