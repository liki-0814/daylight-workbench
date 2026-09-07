const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A form-compatible, select-only combobox. The list expands below the trigger. */
export function selectField({ name, label, value = '', options, disabled = false }) {
  const id = `select-${crypto.randomUUID()}`;
  const selected = options.find(option => option.value === value) || options[0];
  return `<div class="select-field"><span id="${id}-label" class="select-label">${escape(label)}</span>
    <workbench-select>
      <input type="hidden" name="${escape(name)}" value="${escape(selected?.value || '')}" ${disabled ? 'disabled' : ''}>
      <button type="button" class="select-trigger" role="combobox" aria-labelledby="${id}-label" aria-controls="${id}-list" aria-haspopup="listbox" aria-expanded="false" ${disabled || !options.length ? 'disabled' : ''}>
        <span class="select-value">${escape(selected?.label || '暂无选项')}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <ul id="${id}-list" class="select-options" role="listbox" aria-labelledby="${id}-label" hidden>
        ${options.map((option, index) => `<li id="${id}-option-${index}" class="select-option" role="option" aria-selected="${option === selected}" data-value="${escape(option.value)}"><span>${escape(option.label)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg></li>`).join('')}
      </ul>
    </workbench-select>
  </div>`;
}

class WorkbenchSelect extends HTMLElement {
  connectedCallback() {
    this.trigger = this.querySelector('.select-trigger');
    this.list = this.querySelector('[role="listbox"]');
    this.input = this.querySelector('input');
    this.options = [...this.querySelectorAll('[role="option"]')];
    this.activeIndex = Math.max(0, this.options.findIndex(option => option.getAttribute('aria-selected') === 'true'));
    this.controller = new AbortController();
    const { signal } = this.controller;
    this.trigger.addEventListener('click', () => this.setOpen(this.list.hidden), { signal });
    this.list.addEventListener('pointerdown', event => event.preventDefault(), { signal });
    this.list.addEventListener('click', event => {
      const option = event.target.closest('[role="option"]');
      if (option && this.options.includes(option)) this.choose(this.options.indexOf(option));
    }, { signal });
    this.trigger.addEventListener('keydown', event => this.onKey(event), { signal });
    document.addEventListener('pointerdown', event => {
      if (!this.contains(event.target)) this.setOpen(false);
    }, { signal });
    this.addEventListener('focusout', event => {
      if (!this.contains(event.relatedTarget)) this.setOpen(false);
    }, { signal });
    this.closest('dialog')?.addEventListener('close', () => this.setOpen(false), { signal });
  }

  disconnectedCallback() {
    this.controller?.abort();
    clearTimeout(this.searchTimer);
  }

  setOpen(open) {
    if (open && this.trigger.disabled) return;
    this.list.hidden = !open;
    this.trigger.setAttribute('aria-expanded', String(open));
    if (open) {
      this.activeIndex = Math.max(0, this.options.findIndex(option => option.getAttribute('aria-selected') === 'true'));
      this.highlight(this.activeIndex);
    } else this.trigger.removeAttribute('aria-activedescendant');
  }

  highlight(index) {
    this.activeIndex = Math.max(0, Math.min(index, this.options.length - 1));
    this.options.forEach((option, i) => option.classList.toggle('is-highlighted', i === this.activeIndex));
    const active = this.options[this.activeIndex];
    if (active) {
      this.trigger.setAttribute('aria-activedescendant', active.id);
      const top = active.offsetTop;
      const bottom = top + active.offsetHeight;
      if (top < this.list.scrollTop) this.list.scrollTop = top;
      else if (bottom > this.list.scrollTop + this.list.clientHeight) this.list.scrollTop = bottom - this.list.clientHeight;
    }
  }

  choose(index) {
    const option = this.options[index];
    if (!option) return;
    this.options.forEach(item => item.setAttribute('aria-selected', String(item === option)));
    this.input.value = option.dataset.value;
    this.querySelector('.select-value').textContent = option.querySelector('span').textContent;
    this.setOpen(false);
    this.trigger.focus();
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }

  onKey(event) {
    const open = !this.list.hidden;
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      this.setOpen(false);
    } else if (event.key === 'Tab') this.setOpen(false);
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!open) this.setOpen(true);
      if (event.key === 'Home') this.highlight(0);
      else if (event.key === 'End') this.highlight(this.options.length - 1);
      else if (open) this.highlight(this.activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) this.choose(this.activeIndex);
      else this.setOpen(true);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (!open) this.setOpen(true);
      clearTimeout(this.searchTimer);
      this.search = (this.search || '') + event.key.toLocaleLowerCase();
      const found = this.options.findIndex(option => option.textContent.trim().toLocaleLowerCase().startsWith(this.search));
      if (found !== -1) this.highlight(found);
      this.searchTimer = setTimeout(() => { this.search = ''; }, 600);
    }
  }
}

customElements.define('workbench-select', WorkbenchSelect);
