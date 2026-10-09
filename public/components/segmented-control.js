import { escapeButtonText as esc, buttonAttributes } from './button.js';
export function segmentedControl({ id, label, value, options, showLabel = false }) {
  const control = `<div class="ui-segmented" id="${esc(id)}" role="radiogroup" aria-label="${esc(label)}">${options.map(option => `<button ${buttonAttributes({ type: 'button', role: 'radio', 'aria-checked': String(value === option.value), tabindex: value === option.value ? 0 : -1, 'data-segment-value': option.value, disabled: option.disabled })}>${esc(option.label)}</button>`).join('')}</div>`;
  return showLabel ? `<div class="ui-segmented-field"><span class="ui-segmented-label">${esc(label)}</span>${control}</div>` : control;
}
export function mountSegmentedControl(root, { onChange }) {
  const abort = new AbortController(), options = { signal: abort.signal };
  function choose(button) {
    root.querySelectorAll('[data-segment-value]').forEach(item => { item.setAttribute('aria-checked', String(item === button)); item.tabIndex = item === button ? 0 : -1; });
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
