import { escapeButtonText as esc, buttonAttributes } from './button.js';
// mode: 'radio'（默认，向后兼容：互斥选项）| 'tabs'（用作页签：tablist/tab + aria-selected，E-15）。
const checkedAttribute = root => root.getAttribute('role') === 'tablist' ? 'aria-selected' : 'aria-checked';
export function segmentedControl({ id, label, value, options, showLabel = false, mode = 'radio' }) {
  const tabs = mode === 'tabs', itemRole = tabs ? 'tab' : 'radio', stateAttribute = tabs ? 'aria-selected' : 'aria-checked';
  const control = `<div class="ui-segmented" id="${esc(id)}" role="${tabs ? 'tablist' : 'radiogroup'}" aria-label="${esc(label)}">${options.map(option => `<button ${buttonAttributes({ type: 'button', role: itemRole, [stateAttribute]: String(value === option.value), tabindex: value === option.value ? 0 : -1, 'data-segment-value': option.value, disabled: option.disabled })}>${esc(option.label)}</button>`).join('')}</div>`;
  return showLabel ? `<div class="ui-segmented-field"><span class="ui-segmented-label">${esc(label)}</span>${control}</div>` : control;
}
export function mountSegmentedControl(root, { onChange }) {
  const abort = new AbortController(), options = { signal: abort.signal };
  function choose(button) {
    root.querySelectorAll('[data-segment-value]').forEach(item => { item.setAttribute(checkedAttribute(root), String(item === button)); item.tabIndex = item === button ? 0 : -1; });
    button.focus(); onChange(button.dataset.segmentValue);
  }
  root.addEventListener('click', event => { const button = event.target.closest('[data-segment-value]'); if (button && root.contains(button) && !button.disabled) choose(button); }, options);
  root.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...root.querySelectorAll('[data-segment-value]:not(:disabled)')], index = buttons.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault(); choose(buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length]);
  }, options);
  return () => abort.abort();
}
