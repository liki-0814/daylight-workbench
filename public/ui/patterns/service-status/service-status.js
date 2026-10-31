import { html, attrs, cx, slot, trusted } from '../../core/html.js';
import { statusTag } from '../../components/status-tag/status-tag.js';
import { switchControl } from '../../components/switch/switch.js';
import { button } from '../../components/button/button.js';

// serviceHero({ state, title, tagLabel, address, addressNote, meta, note, error, cancel, announce, switchLabel })
//   state: running | starting | stopped | error（四种状态互斥）。
//   · running：绿色标签，可复制的地址，运行时长 / 请求数
//   · starting：灰色虚线标签 + 青绿旋转圈，开关已是开启态（aria-busy），超过 5 秒页面传入 cancel 显示「取消」
//   · stopped：灰色标签，「未在监听」+ 启用后将使用的地址预览
//   · error：红色标签 + 错误说明（发生了什么 / 为什么 / 怎么办）+ 操作按钮；开关回到关
//   焦点始终在开关上：本组件不移动焦点；状态变化写进 role="status" 的播报区（announce）。
const TONE = { running: 'success', starting: 'neutral', stopped: 'neutral', error: 'error' };
export function serviceHero({ state = 'stopped', title, tagLabel, address = '', addressNote = '', copyLabel = '复制', meta = [], note = '', error, cancel, announce = '', switchLabel, switchAttrs } = {}) {
  const on = state === 'running' || state === 'starting';
  const tag = statusTag({ tone: TONE[state] || 'neutral', label: tagLabel, dashed: state === 'starting', spin: state === 'starting' });
  const addressRow = state === 'error' ? '' : state === 'running'
    ? html`<div class="dl-hero__addr is-live" data-key="addr-running"><span class="dl-hero__url">${address}</span>${button({ label: copyLabel, variant: 'ghost', attrs: { 'data-action': 'copy-address', 'data-copy': address } })}</div>`
    : html`<div class="dl-hero__addr is-muted" data-key="addr-${state}"><span>${addressNote}</span></div>`;
  return html`<div class="dl-hero" data-state="${state}"><div class="dl-hero__top"><h3 class="dl-hero__title">${title}</h3>${tag}${cancel ? button({ label: cancel.label, variant: 'ghost', attrs: cancel.attrs }) : ''}<span class="dl-hero__switch">${switchControl({ checked: on, busy: state === 'starting', label: switchLabel || title, attrs: switchAttrs })}</span></div>${addressRow}${state === 'running' && meta.length ? html`<div class="dl-hero__meta is-live" data-key="meta-running">${meta.map(item => html`<span>${item.label} <b>${item.value}</b></span>`)}</div>` : ''}${note && state !== 'error' ? html`<div class="dl-hero__note">${note}</div>` : ''}${error ? html`<div class="dl-hero__err" data-key="err-open"><div class="dl-hero__err-inner"><div class="dl-hero__errbox" role="alert"><b>${error.what}</b> ${error.why}<br>${error.todo}${error.actions ? html`<div class="dl-hero__acts">${slot(error.actions)}</div>` : ''}</div></div></div>` : ''}<div class="dl-sr-only" role="status" aria-live="polite" data-ui-static>${announce}</div></div>`;
}
