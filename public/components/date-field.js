import { escapeButtonText as esc, buttonAttributes } from './button.js';
export const dateField = ({ name, label, value = '', min, max, required = false, compact = false }) => `<label class="ui-date-field${compact ? ' ui-date-field-compact' : ''}">${esc(label)}<input ${buttonAttributes({ type: 'date', name, value, min, max, required })}></label>`;
