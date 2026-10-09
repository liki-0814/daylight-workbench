import { actionButton } from './button.js';
export function createDialogShell({ title, description = '', onClose = () => {} }) {
  const element = document.createElement('dialog'); element.className = 'ui-dialog';
  const abort = new AbortController(); let trigger, busy = false;
  const heading = document.createElement('h2'); heading.id = 'ui-dialog-' + crypto.randomUUID(); heading.textContent = title; element.setAttribute('aria-labelledby', heading.id);
  const header = document.createElement('div'); header.className = 'dialog-header'; header.append(heading); header.insertAdjacentHTML('beforeend', actionButton({ label: '关闭', symbol: 'close', iconOnly: true, variant: 'icon', attrs: { 'data-dialog-close': true } }));
  const body = document.createElement('div'); body.className = 'ui-dialog-content';
  element.append(header); if (description) { const text = document.createElement('p'); text.textContent = description; text.className = 'ui-dialog-description'; element.append(text); } element.append(body);
  const close = () => { if (!busy && element.open) element.close(); };
  element.addEventListener('cancel', event => { if (busy) event.preventDefault(); }, { signal: abort.signal });
  element.addEventListener('click', event => { if (event.target.closest('[data-dialog-close]')) close(); if (event.target === element) { const rect = element.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); } }, { signal: abort.signal });
  element.addEventListener('close', () => { trigger?.focus(); onClose(); }, { signal: abort.signal });
  return { element, open() { if (document.querySelector('dialog[open]')) return false; trigger = document.activeElement; if (!element.isConnected) document.body.append(element); element.showModal(); return true; }, close, setBusy(value) { busy = value; element.querySelector('[data-dialog-close]').disabled = value; }, setContent(content) { typeof content === 'string' ? body.innerHTML = content : body.replaceChildren(content); }, dispose() { busy = false; close(); abort.abort(); element.remove(); } };
}
