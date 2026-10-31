import { html, attrs, cx, esc } from '../../core/html.js';
import { icon } from '../../core/icons.js';
import { emit, sourceOf } from '../../core/events.js';
import { install } from '../../core/behave.js';

// toast.js —— 通知。命令式：showToast({ message, tone, actions, persistent }) → { el, dismiss() }
//   tone: success | info | warning | error。
//   错误（error）和警告（warning）**不会自动消失**，必须手动关闭（× 派发 ui:dismiss）；success / info 默认 6.5 秒后收起，悬停或键盘聚焦时暂停。
//   actions: [{ label, value }] → 点击派发 ui:select { value }。
export const AUTO_DISMISS_MS = 6500;
export const sticky = tone => tone === 'error' || tone === 'warning';

export function toastMarkup({ message, tone = 'info', actions = [] } = {}) {
  const iconName = tone === 'success' ? 'success' : tone === 'error' ? 'error' : tone === 'warning' ? 'warning' : 'info';
  return html`<div class="${cx('dl-toast', `dl-toast--${esc(tone)}`)}" role="${sticky(tone) ? 'alert' : 'status'}" data-ui="toast">${icon(iconName, { size: 16 })}<span class="dl-toast__text">${message}</span>${actions.map(action => html`<button class="dl-toast__action" type="button" data-value="${action.value}">${action.label}</button>`)}<button class="dl-toast__close" type="button" aria-label="关闭通知" title="关闭">${icon('close', { size: 14 })}</button></div>`;
}

function region() {
  let el = document.querySelector('.dl-toasts');
  if (!el) {
    el = document.createElement('div');
    el.className = 'dl-toasts';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', '通知');
    document.body.append(el);
  }
  return el;
}

export function showToast({ message, tone = 'info', actions = [], persistent = false, timeout = AUTO_DISMISS_MS } = {}) {
  const host = document.createElement('div');
  host.innerHTML = String(toastMarkup({ message: String(message ?? ''), tone, actions }));
  const el = host.firstElementChild;
  region().append(el);
  let timer = null;
  const dismiss = () => { clearTimeout(timer); el.remove(); };
  const arm = () => { if (!persistent && !sticky(tone)) timer = setTimeout(dismiss, timeout); };
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', arm);
  el.addEventListener('focusin', () => clearTimeout(timer));
  el.addEventListener('focusout', arm);
  arm();
  return { el, dismiss };
}

// 页面不查 .dl-toast…：是否已有同样的通知、收掉某个动作按钮（如撤销）都经组件。
export const hasToast = ({ message, tone }) => [...document.querySelectorAll('[data-ui="toast"]')].some(el => el.classList.contains(`dl-toast--${tone}`) && el.querySelector('.dl-toast__text')?.textContent === String(message));
export const dropToastActions = value => document.querySelectorAll('[data-ui="toast"] .dl-toast__action').forEach(node => { if (node.dataset.value === value) node.remove(); });

install('toast', doc => doc.addEventListener('click', event => {
  const el = event.target.closest?.('.dl-toast');
  if (!el) return;
  const action = event.target.closest('.dl-toast__action');
  if (action) { emit(el, 'select', { value: action.dataset.value ?? '', source: sourceOf(event) }); el.remove(); return; }
  if (event.target.closest('.dl-toast__close') && emit(el, 'dismiss', { value: null, source: sourceOf(event) }, { cancelable: true })) el.remove();
}));
