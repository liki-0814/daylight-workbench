const sizes = { small: '96px', medium: '132px', large: '168px' };

function applyCard(button, { title = '', mark = '', meta = '', size = 'medium', minHeight, color, background, markColor, markBackground, muted = false, label } = {}) {
  button.dataset.size = Object.hasOwn(sizes, size) ? size : 'medium';
  button.classList.toggle('is-muted', muted);
  button.style.setProperty('--ui-card-min-height', minHeight || sizes[button.dataset.size]);
  for (const [name, value] of [['--ui-card-color', color], ['--ui-card-background', background], ['--ui-card-mark-color', markColor], ['--ui-card-mark-background', markBackground]]) {
    if (value) button.style.setProperty(name, value);
    else button.style.removeProperty(name);
  }
  button.querySelector('.ui-card-mark').textContent = mark;
  button.querySelector('.ui-card-mark').hidden = mark === '';
  button.querySelector('.ui-card-title').textContent = title;
  button.querySelector('.ui-card-meta').textContent = meta;
  button.querySelector('.ui-card-meta').hidden = meta === '';
  button.title = title;
  button.setAttribute('aria-label', label || [title, meta].filter(Boolean).join('，'));
}

/** Visual card. Size, ink and surface are chosen by the caller; omitted colors use the shared tokens. */
export function createCard(options = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ui-card';
  button.innerHTML = '<span class="ui-card-mark"></span><span class="ui-card-title"></span><span class="ui-card-meta"></span>';
  applyCard(button, options);
  return button;
}

export function updateCard(button, options) { applyCard(button, options); return button; }
