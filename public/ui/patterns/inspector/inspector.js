import { html, attrs, slot } from '../../core/html.js';

// inspector({ label, kicker, title, props: [{ label, value, tone }], note, actions, empty })
//   右侧详情栏（宽 300）。actions 只接受 trusted() / 组件返回值。
export function inspector({ label = '任务详情', kicker = '', title = '', props = [], note = '', actions = '', empty = '' } = {}) {
  if (empty) return html`<aside class="dl-insp is-empty" aria-label="${label}"><p class="dl-insp__empty">${empty}</p></aside>`;
  return html`<aside class="dl-insp" aria-label="${label}">${kicker ? html`<div class="dl-insp__kicker">${kicker}</div>` : ''}<h2 class="dl-insp__title">${title}</h2><dl class="dl-insp__props">${props.map(prop => html`<div class="dl-prop"><dt>${prop.label}</dt><dd class="${prop.tone ? `is-${prop.tone}` : ''}">${prop.value}</dd></div>`)}</dl>${note ? html`<p class="dl-insp__note">${note}</p>` : ''}${actions ? html`<div class="dl-insp__actions">${slot(actions)}</div>` : ''}</aside>`;
}
