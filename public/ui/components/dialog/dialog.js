import { html, attrs, slot, esc } from '../../core/html.js';
import { morph } from '../../core/morph.js';
import { emit, sourceOf } from '../../core/events.js';
import { install } from '../../core/behave.js';

// dialog({ id, label, width, children }) → SafeHtml（<dialog class="dl-dialog">）。children 必须是 trusted() / 组件返回值。
// 命令式：mountDialog({ id, label, width, children }) → { el, open(), close(), update(children) }
//   Esc / 点遮罩 → 先派发可取消的 ui:dismiss，没被取消才关闭；关闭后派发 ui:close。Cmd/Ctrl+Enter 触发 [data-dialog-submit]。
export function dialog({ id, label, width = 680, children = '', className = '' } = {}) {
  if (!label) throw new TypeError('dialog needs a label (aria-label)');
  return html`<dialog class="dl-dialog${className ? ` ${esc(className)}` : ''}"${attrs({ id, 'aria-label': label, 'data-width': Number(width) || 680 })}><div class="dl-dialog__body">${slot(children)}</div></dialog>`;
}

export function mountDialog({ id, label, width = 680, children = '', parent } = {}) {
  const host = document.createElement('div');
  host.innerHTML = String(dialog({ id, label, width, children }));
  const el = host.firstElementChild;
  (parent || document.body).append(el);
  return {
    el,
    open() { if (!el.open) el.showModal(); },
    close() { if (el.open) el.close(); },
    update(next) { morph(el.querySelector('.dl-dialog__body'), String(slot(next))); },
    destroy() { if (el.open) el.close(); el.remove(); },
  };
}

install('dialog', doc => {
  const dismiss = (el, event) => { if (emit(el, 'dismiss', { value: null, source: sourceOf(event) }, { cancelable: true })) el.close(); };
  doc.addEventListener('cancel', event => {
    const el = event.target;
    if (!el.matches?.('.dl-dialog')) return;
    event.preventDefault();
    dismiss(el, { type: 'keydown' });
  }, true);
  doc.addEventListener('mousedown', event => {
    const el = event.target;
    if (el.matches?.('.dl-dialog[open]')) { const r = el.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dismiss(el, event); }
  });
  doc.addEventListener('close', event => { if (event.target.matches?.('.dl-dialog')) emit(event.target, 'close', { value: event.target.returnValue || null, source: 'user' }); }, true);
  doc.addEventListener('keydown', event => {
    const el = event.target.closest?.('.dl-dialog');
    if (el && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); el.querySelector('[data-dialog-submit]:not(:disabled)')?.click(); }
  });
});
