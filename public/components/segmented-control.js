import { escapeButtonText as esc, buttonAttributes } from './button.js';

/** Shared horizontal selection. Tabs expose panels; the default remains a radio group. */
export function segmentedControl({ id, label, value, options, showLabel = false, mode = 'radio', className = '', hidden = false }) {
  const tabs = mode === 'tabs', available = options.filter(option => !option.disabled && !option.hidden);
  const selected = tabs && !available.some(option => option.value === value) ? available[0]?.value : value;
  const control = `<div ${buttonAttributes({ class: `ui-segmented${className ? ' ' + className : ''}`, id, role: tabs ? 'tablist' : 'radiogroup', 'aria-label': label, hidden })}>${options.map(option => `<button ${buttonAttributes({ type: 'button', id: option.id, role: tabs ? 'tab' : 'radio', [tabs ? 'aria-selected' : 'aria-checked']: String(selected === option.value && !option.hidden), 'aria-controls': tabs ? option.controls : undefined, tabindex: selected === option.value && !option.hidden ? 0 : -1, 'data-segment-value': option.value, hidden: option.hidden, disabled: option.disabled })}>${esc(option.label)}</button>`).join('')}</div>`;
  return showLabel ? `<div class="ui-segmented-field"><span class="ui-segmented-label">${esc(label)}</span>${control}</div>` : control;
}

/** One keyboard order for radios and tabs, excluding unavailable choices. */
export function segmentKeyboardValue(options, selected, key) {
  const available = options.filter(option => !option.hidden && !option.disabled);
  if (!available.length) return undefined;
  if (key === 'Home') return available[0].value;
  if (key === 'End') return available.at(-1).value;
  if (!['ArrowLeft', 'ArrowRight'].includes(key)) return undefined;
  const index = available.findIndex(option => option.value === selected);
  if (index < 0) return available[0].value;
  return available[(index + (key === 'ArrowLeft' ? -1 : 1) + available.length) % available.length].value;
}

/** Reconcile selection after options are hidden without repainting focused controls. */
export function setSegmentedValue(group, value, { focus = false } = {}) {
  const buttons = [...group.querySelectorAll('[data-segment-value]')];
  const available = buttons.filter(button => !button.disabled && !button.hidden);
  const selected = available.find(button => button.dataset.segmentValue === value) || available[0];
  const attribute = group.getAttribute('role') === 'tablist' ? 'aria-selected' : 'aria-checked';
  for (const button of buttons) {
    button.setAttribute(attribute, String(button === selected));
    button.tabIndex = button === selected ? 0 : -1;
  }
  if (focus) selected?.focus();
  return selected?.dataset.segmentValue;
}

export function mountSegmentedControl(root, { onChange }) {
  const abort = new AbortController(), options = { signal: abort.signal };
  function groupFor(button) {
    const group = button?.closest('.ui-segmented');
    return group && root.contains(button) && !button.closest('[hidden]') ? group : null;
  }
  function choose(group, button) {
    if (button.disabled || button.hidden) return;
    const value = setSegmentedValue(group, button.dataset.segmentValue, { focus: true });
    if (value !== undefined) onChange(value);
  }
  root.addEventListener('click', event => {
    const button = event.target.closest('[data-segment-value]'), group = groupFor(button);
    if (group) choose(group, button);
  }, options);
  root.addEventListener('keydown', event => {
    const button = event.target.closest('[data-segment-value]'), group = groupFor(button);
    if (!group || button.disabled || button.hidden) return;
    const buttons = [...group.querySelectorAll('[data-segment-value]')];
    const value = segmentKeyboardValue(buttons.map(item => ({ value: item.dataset.segmentValue, disabled: item.disabled, hidden: item.hidden })), button.dataset.segmentValue, event.key);
    if (value === undefined) return;
    event.preventDefault(); choose(group, buttons.find(item => item.dataset.segmentValue === value));
  }, options);
  return () => abort.abort();
}
