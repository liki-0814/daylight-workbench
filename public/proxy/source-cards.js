import { proxySources } from '../../core/proxy-sources.js';
import { createCard, updateCard } from '../components/card.js';
import { actionButton } from '../components/button.js';

const EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
const DURATION = 480;
const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
const tones = Object.fromEntries(proxySources.map(source => [source.id, source.tone]));
const toneInk = { codex: 'var(--accent-ink)', kimi: 'var(--accent-ink)', grok: 'var(--ink)', custom: 'var(--ink)' };

export function sourceMeta(source) {
  if (source.account?.login || source.account?.uid) return '已登录';
  if (String(source.id).startsWith('custom:')) return source.enabled === false ? '已停用' : source.configured === false || source.state === 'unconfigured' ? '未配置' : '已连接';
  if (source.configured === false || source.state === 'unconfigured') return '未登录';
  if (source.state === 'disabled' || source.enabled === false) return '已停用';
  return source.state === 'unchecked' ? '' : '已登录';
}

export function sourceEntries(definitions = []) {
  const known = new Map(proxySources.map(source => [source.id, source]));
  return definitions.filter(source => source?.id && source.id !== 'custom').map(source => {
    const base = known.get(source.id);
    const title = source.name || base?.label || source.id;
    return { id: source.id, title, meta: sourceMeta(source), mark: base?.mark || title.replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, '').slice(0, 1) || '源', tone: base?.tone || 'custom' };
  });
}

function cardOptions(entry, { muted = false, size = 'medium' } = {}) {
  return { title: entry.title, mark: entry.mark, meta: entry.meta || '', size, minHeight: 'auto', color: toneInk[entry.tone] || toneInk.custom, markColor: toneInk[tones[entry.id]] || toneInk[entry.tone] || toneInk.custom, muted };
}

export function createSourceCards({ store, onChange }) {
  const element = document.createElement('div');
  element.className = 'proxy-card-board';
  element.innerHTML = `<div class="proxy-card-toolbar">${actionButton({ variant: 'secondary', label: '返回', attrs: { 'data-back': true, hidden: true } })}</div><div class="ui-card-grid" data-grid></div><p class="proxy-error" data-card-error role="alert" hidden></p>`;
  const grid = element.querySelector('[data-grid]');
  const back = element.querySelector('[data-back]');
  const error = element.querySelector('[data-card-error]');
  const nodes = new Map();
  const rear = new Map();
  let order = [];
  let open = null;
  let models = [];
  let drag = null;
  let suppressClick = false;
  let disposed = false;
  let request = 0;

  function flip(mutate) {
    const previous = new Map([...grid.querySelectorAll('.ui-card')].filter(node => !node.classList.contains('is-lifted')).map(node => [node, node.getBoundingClientRect()]));
    mutate();
    if (reduce) return;
    for (const [node, from] of previous) {
      if (!node.isConnected) continue;
      const to = node.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: DURATION, easing: EASING });
    }
  }
  function cardFor(id, options) {
    let button = nodes.get(id);
    if (!button) { button = createCard(options); button.dataset.id = id; nodes.set(id, button); }
    else updateCard(button, options);
    return button;
  }
  function paintSources() {
    const entries = sourceEntries(store.sources);
    const known = new Set(entries.map(entry => entry.id));
    order = [...order.filter(id => known.has(id)), ...entries.map(entry => entry.id).filter(id => !order.includes(id))];
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    grid.replaceChildren(...order.map(id => cardFor(id, cardOptions(byId.get(id)))));
    back.hidden = true;
  }
  function orderedModels() {
    const rearIds = rear.get(open) || [];
    const front = models.filter(model => !rearIds.includes(model.id));
    const backModels = rearIds.map(id => models.find(model => model.id === id)).filter(Boolean);
    return [...front, ...backModels];
  }
  function paintModels() {
    const rearIds = new Set(rear.get(open) || []);
    grid.replaceChildren(...orderedModels().map(model => cardFor(model.id, { title: model.displayName || model.id, mark: String(model.displayName || model.id).replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, '').slice(0, 1) || '模', meta: '', size: 'medium', muted: rearIds.has(model.id) })));
    back.hidden = false;
  }
  async function showModels(id) {
    const current = ++request;
    open = id;
    error.hidden = true;
    back.hidden = false;
    grid.replaceChildren();
    onChange({ page: id.startsWith('custom:') ? null : id });
    try {
      const result = id.startsWith('custom:') ? await store.resource('custom', 'sources') : await store.resource(id, 'models');
      if (disposed || current !== request || open !== id) return;
      models = id.startsWith('custom:') ? (result?.sources?.find(source => `custom:${source.id}` === id)?.models || []) : (result || []);
      paintModels();
      grid.querySelector('.ui-card')?.focus();
    } catch (cause) {
      if (disposed || current !== request || cause.name === 'AbortError') return;
      error.textContent = cause.message;
      error.hidden = false;
    }
  }
  function showSources() {
    request += 1;
    open = null;
    models = [];
    error.hidden = true;
    paintSources();
    onChange({ page: null });
  }
  function moveModel(id) {
    const ids = rear.get(open) || [];
    const next = ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id];
    flip(() => { rear.set(open, next); paintModels(); });
    nodes.get(id)?.focus();
  }
  back.onclick = () => showSources();
  element.addEventListener('click', event => {
    if (suppressClick) { suppressClick = false; return; }
    const card = event.target.closest('.ui-card');
    if (!card) return;
    if (!open) void showModels(card.dataset.id);
    else moveModel(card.dataset.id);
  });
  element.addEventListener('keydown', event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); showSources(); return; }
    const card = event.target.closest('.ui-card');
    if (!card || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const items = [...grid.querySelectorAll('.ui-card')];
    const index = items.indexOf(card);
    const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
    const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[event.key];
    const next = items[index + delta];
    if (!next) return;
    event.preventDefault();
    next.focus();
  });
  const pointerEvents = new AbortController();
  element.addEventListener('pointerdown', event => {
    const card = event.target.closest('.ui-card');
    if (!card || open || event.button !== 0) return;
    drag = { card, x: event.clientX, y: event.clientY, pointerId: event.pointerId, moved: false };
  });
  window.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId || open) return;
    if (!drag.moved) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8) return;
      drag.moved = true;
      const rect = drag.card.getBoundingClientRect();
      drag.offsetX = event.clientX - rect.left;
      drag.offsetY = event.clientY - rect.top;
      drag.placeholder = document.createElement('div');
      drag.placeholder.className = 'ui-card-placeholder';
      drag.card.before(drag.placeholder);
      drag.card.classList.add('is-lifted');
      drag.card.style.position = 'fixed';
      drag.card.style.width = `${rect.width}px`;
      drag.card.style.height = `${rect.height}px`;
      drag.card.setPointerCapture?.(event.pointerId);
    }
    event.preventDefault();
    drag.card.style.left = `${event.clientX - drag.offsetX}px`;
    drag.card.style.top = `${event.clientY - drag.offsetY}px`;
    const items = [...grid.children].filter(node => node !== drag.placeholder && !node.classList.contains('is-lifted'));
    let before = null;
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (event.clientY < rect.top || (event.clientY <= rect.bottom && event.clientX < rect.left + rect.width / 2)) { before = item; break; }
    }
    const next = drag.placeholder.nextElementSibling?.classList.contains('is-lifted') ? drag.placeholder.nextElementSibling.nextElementSibling : drag.placeholder.nextElementSibling;
    if ((next || null) === before) return;
    flip(() => grid.insertBefore(drag.placeholder, before));
  }, { signal: pointerEvents.signal });
  function finishDrag(commit) {
    const info = drag;
    drag = null;
    if (!info?.moved) return;
    suppressClick = true;
    const lifted = info.card.getBoundingClientRect();
    info.card.classList.remove('is-lifted');
    info.card.style.position = '';
    info.card.style.left = '';
    info.card.style.top = '';
    info.card.style.width = '';
    info.card.style.height = '';
    if (!commit) { info.placeholder.remove(); paintSources(); return; }
    info.placeholder.replaceWith(info.card);
    order = [...grid.querySelectorAll('.ui-card')].map(card => card.dataset.id);
    const slot = info.card.getBoundingClientRect();
    if (!reduce) info.card.animate([{ transform: `translate(${lifted.left - slot.left}px, ${lifted.top - slot.top}px)` }, { transform: 'none' }], { duration: DURATION, easing: EASING });
  }
  window.addEventListener('pointerup', event => { if (drag?.pointerId === event.pointerId) finishDrag(true); }, { signal: pointerEvents.signal });
  window.addEventListener('pointercancel', event => { if (drag?.pointerId === event.pointerId) finishDrag(false); }, { signal: pointerEvents.signal });
  const unsubscribe = store.subscribe(() => { if (!open) paintSources(); });
  paintSources();
  return { element, refresh() { if (!open) paintSources(); }, dispose() { disposed = true; request += 1; pointerEvents.abort(); unsubscribe(); } };
}
