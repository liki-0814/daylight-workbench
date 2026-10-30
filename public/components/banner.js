import { escapeButtonText as esc, buttonAttributes } from './button.js';
import { icon } from './icons.js';
// 横幅（design-spec §6）：10% 状态底 + 图标 + 粗体首句 + 说明 + 右侧动作；错误类带 role=alert，其余 role=status。
// actions: [{ label, variant = 'secondary', attrs = {} }]；message 是已转义文本或受信 HTML（messageHtml）。
const bannerTones = { error: 'error', warning: 'warning', info: 'info', success: 'success' };
export function bannerMarkup({ tone = 'info', title, message = '', messageHtml = '', actions = [], attrs = {}, className = '' } = {}) {
  const kind = bannerTones[tone] || 'info';
  const buttons = actions.map(action => `<button ${buttonAttributes({ type: 'button', ...(action.attrs || {}) })} class="ui-button ui-button-${esc(action.variant || 'secondary')} secondary">${esc(action.label)}</button>`).join('');
  return `<section ${buttonAttributes({ class: `ui-banner ui-banner-${kind} ${className}`.trim(), role: kind === 'error' ? 'alert' : 'status', ...attrs })}><span class="ui-banner-icon">${icon(kind)}</span><div class="ui-banner-body"><strong>${esc(title)}</strong>${messageHtml || (message ? `<p>${esc(message)}</p>` : '')}</div>${buttons ? `<div class="ui-banner-actions">${buttons}</div>` : ''}</section>`;
}

// 复制文字：优先 navigator.clipboard；失败（无权限、非安全上下文、被拒绝）时选中 selectTarget 里的文字，让用户按 ⌘C。
// 返回 { copied, selected }；不抛错。
export async function copyText(text, { selectTarget, clipboard = globalThis.navigator?.clipboard } = {}) {
  try {
    if (!clipboard?.writeText) throw new Error('clipboard unavailable');
    await clipboard.writeText(text);
    return { copied: true, selected: false };
  } catch {
    return { copied: false, selected: selectNodeText(selectTarget) };
  }
}
export function selectNodeText(node) {
  if (!node || !globalThis.getSelection || !globalThis.document) return false;
  const range = document.createRange(); range.selectNodeContents(node);
  const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  return true;
}

// Toast（design-spec §6）：底部居中，默认 4s 自动消失，可带「撤销」类动作；不抢焦点；容器常驻且 role=status，屏幕阅读器会播报。
let region;
function toastRegion() {
  if (region?.isConnected) return region;
  region = document.createElement('div'); region.className = 'ui-toast-region'; region.setAttribute('role', 'status'); region.setAttribute('aria-live', 'polite'); region.setAttribute('aria-atomic', 'false');
  document.body.append(region); return region;
}
export function showToast({ message, tone = 'info', actionLabel = '', onAction = () => {}, duration = 4000 } = {}) {
  const container = toastRegion(), item = document.createElement('div');
  item.className = `ui-toast ui-toast-${bannerTones[tone] || 'info'}`;
  const text = document.createElement('span'); text.textContent = message; item.append(text);
  let timer;
  const dismiss = () => { clearTimeout(timer); item.remove(); };
  if (actionLabel) { const button = document.createElement('button'); button.type = 'button'; button.className = 'ui-toast-action'; button.textContent = actionLabel; button.addEventListener('click', () => { dismiss(); onAction(); }); item.append(button); }
  container.append(item);
  if (duration > 0) timer = setTimeout(dismiss, duration);
  return { dismiss, element: item };
}
