import { icon } from './icons.js';

import { actionButton, buttonAttributes as attributes, escapeButtonText as escape } from './button.js';

/** Shared refresh control. Both labels reserve space so loading never shifts the header.
 * Example: refreshButton({ id: 'refresh-models', ariaLabel: '刷新模型' }).
 * Use setRefreshState(button, { loading, disabled }) instead of replacing its text. */
export function refreshButton({ id, label = '刷新', loadingLabel = '刷新中…', ariaLabel = label, attrs = {} } = {}) {
  return actionButton({variant:'secondary',className:'ui-refresh-button',symbol:'refresh',attrs:{id,'aria-label':ariaLabel,'aria-busy':'false',...attrs},content:`<span class="ui-refresh-label"><span data-refresh-idle>${escape(label)}</span><span data-refresh-busy aria-hidden="true">${escape(loadingLabel)}</span></span>`});
}

export function setRefreshState(button, { loading = false, disabled = false } = {}) {
  button.disabled = loading || disabled;
  button.setAttribute('aria-busy', String(loading));
  button.querySelector('[data-refresh-idle]').setAttribute('aria-hidden', String(loading));
  button.querySelector('[data-refresh-busy]').setAttribute('aria-hidden', String(!loading));
}

/** Title, description and actions for ordinary sections. Action markup is trusted template HTML. */
export function sectionHeading({ title, description, actions = '', level = 2, titleAddon = '', className = '' }) {
  return `<div class="ui-section-heading ${escape(className)}"><div><h${level}>${escape(title)}${titleAddon}</h${level}>${description ? `<p class="ui-section-description">${escape(description)}</p>` : ''}</div>${actions}</div>`;
}

/** A native checkbox with its label and help text aligned in one settings row. */
export function settingToggleRow({ name, label, description }) {
  return `<label class="ui-setting-row"><span><span class="ui-setting-title">${escape(label)}</span>${description ? `<span class="ui-setting-description">${escape(description)}</span>` : ''}</span><input type="checkbox" ${attributes({ name })}></label>`;
}

/** Collapsible sections always keep title, description and actions in the shared heading.
 * Pass trusted template HTML as content/actions; text values are escaped here. */
export function disclosureSection({ id, title, description = '', actions = '', content = '', className = '' }) {
  return `<details ${attributes({ id })} class="ui-disclosure ${escape(className)}"><summary class="ui-disclosure-heading">${icon('down')}<span class="ui-disclosure-title">${escape(title)}</span><span class="ui-section-actions">${description ? `<span class="ui-section-description">${escape(description)}</span>` : ''}${actions}</span></summary><div class="ui-disclosure-body">${content}</div></details>`;
}

/** Header actions must not trigger the summary's native collapse/expand action. */
export function mountDisclosures(root) {
  root.addEventListener('click', event => {
    if (event.target.closest('.ui-disclosure-heading button')) event.preventDefault();
  });
}
