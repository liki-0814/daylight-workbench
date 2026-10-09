export function createProgressMeter({ label }) {
  const element = document.createElement('progress'); element.className = 'ui-progress-meter'; element.max = 1; element.value = 0; element.setAttribute('aria-label', label);
  return { element, setValue(value, text) { element.value = Math.max(0, Math.min(1, Number(value) || 0)); if (text) element.setAttribute('aria-valuetext', text); }, dispose() { element.remove(); } };
}
