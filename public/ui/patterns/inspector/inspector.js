import { html, slot } from '../../core/html.js';

// inspector({ label, kicker, title, props: [{ label, value, tone }], primary, sections: [{ key, title, count, body, empty }], note, actions, empty })
//   右侧详情栏（宽 300）。顺序：标题 → 属性 → primary（紧贴属性下方的操作行：两个主按钮 + 「更多」菜单）→ 可滚动的内容分区（备注 / 子任务 / 动态）。
//   primary / actions / sections[].body 只接受 trusted() / 组件返回值。任何文字都不裁切：按钮和长文本自动换行。
export function inspector({ label = '任务详情', kicker = '', title = '', primary = '', props = [], sections = [], note = '', actions = '', empty = '' } = {}) {
  if (empty) return html`<aside class="dl-insp is-empty" aria-label="${label}"><p class="dl-insp__empty">${empty}</p></aside>`;
  const operations = primary || actions;
  return html`<aside class="dl-insp" aria-label="${label}">${kicker ? html`<div class="dl-insp__kicker">${kicker}</div>` : ''}<h2 class="dl-insp__title">${title}</h2><dl class="dl-insp__props">${props.map(prop => html`<div class="dl-prop"><dt>${prop.label}</dt><dd class="${prop.tone ? `is-${prop.tone}` : ''}">${prop.value}</dd></div>`)}</dl>${operations ? html`<div class="dl-insp__primary">${slot(operations)}</div>` : ''}${note || sections.length ? html`<div class="dl-insp__body">${note ? html`<p class="dl-insp__note">${note}</p>` : ''}${sections.map(section => html`<section class="dl-insp__section" data-key="${section.key}" aria-label="${section.title}"><h3 class="dl-insp__h">${section.title}${section.count !== undefined ? html`<span class="dl-insp__count">${section.count}</span>` : ''}</h3>${section.body ? slot(section.body) : html`<p class="dl-insp__hint">${section.empty || ''}</p>`}</section>`)}</div>` : ''}</aside>`;
}
