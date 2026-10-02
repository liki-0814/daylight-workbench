import { icon } from './icons.js';

export const escapeButtonText = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export const buttonAttributes = values => Object.entries(values).filter(([, value]) => value !== false && value != null)
  .map(([name, value]) => value === true ? name : `${name}="${escapeButtonText(value)}"`).join(' ');

/** Native controls preserve event delegation, keyboard and form behavior.
 * Variants: primary, secondary, text, icon, danger.
 * Existing class names are aliases for the same shared styles.
 * content/extra are trusted template HTML; text and attribute values are escaped. */
export function actionButton({ label = '', symbol, variant = 'secondary', iconOnly = false, className = '', content, attrs = {}, extra = '' } = {}) {
  return `<button ${buttonAttributes({type:'button', ...(iconOnly ? {'aria-label':label,title:label} : {}), ...attrs})} class="ui-button ui-button-${escapeButtonText(variant)} ${escapeButtonText(className)}" ${extra}>${symbol ? icon(symbol) : ''}${content ?? (iconOnly ? '' : escapeButtonText(label))}</button>`;
}
