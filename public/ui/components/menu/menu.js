import { html, attrs, cx, esc, uid, flag } from '../../core/html.js';
import { icon } from '../../core/icons.js';
import { emit, sourceOf } from '../../core/events.js';
import { install, moveFocus } from '../../core/behave.js';

// menu({ name, label, trigger, options, placement, variant, attrs, id, disabled })
//   name     写进根元素的 data-name；页面只用 data-name 区分是哪个菜单（不要用 class 名）
//   动作菜单（「更多」「…」）：按钮触发，role="menu" / role="menuitem"，选中后只派发 ui:select（不保存值）。
//   与 select（值选择器：role="listbox"、保存当前值、派发 ui:change）语义不同，不要互相代替。
//   label    必填，作触发按钮的 aria-label 与菜单的名称
//   trigger  { text?: string, icon?: string }：触发按钮上的可见文字 / 图标，缺省为 label
//   options  [{ value, label, icon?, meta?, danger?, disabled?, divider?: true }]
//   placement 'down'（左对齐向下）| 'end'（右对齐向下）| 'up' | 'up-end'；空间不够时自动翻转到另一侧
//   variant  default | ghost
export function menu({ name, label, trigger = {}, options = [], placement = 'end', variant = 'default', attrs: extra, id = uid('dl-menu'), disabled = false } = {}) {
  if (!label) throw new TypeError('menu needs a label (aria-label)');
  const items = options.map(option => option.divider
    ? html`<div class="dl-menu__divider" role="separator"></div>`
    : html`<button class="${cx('dl-menu__item', option.danger && 'is-danger')}" type="button" role="menuitem" tabindex="-1" data-value="${option.value}" data-key="${option.value}"${flag('disabled', !!option.disabled)}>${option.icon ? icon(option.icon, { size: 14 }) : ''}<span class="dl-menu__label">${option.label}</span>${option.meta ? html`<span class="dl-menu__meta">${option.meta}</span>` : ''}</button>`);
  const place = ['down', 'end', 'up', 'up-end'].includes(placement) ? placement : 'end';
  return html`<div class="${cx('dl-menubtn', `dl-menubtn--${esc(variant)}`)}" data-ui="menu"${name ? attrs({ 'data-name': name }) : ''} data-placement="${place}" data-ui-keep="data-open data-flip"${attrs(extra)}>
<button class="dl-menubtn__trigger" type="button" id="${id}" aria-haspopup="menu" aria-expanded="false" aria-controls="${id}-list" aria-label="${label}"${flag('disabled', disabled)} data-ui-keep="aria-expanded">${trigger.icon ? icon(trigger.icon, { size: 16 }) : ''}<span class="dl-menubtn__text">${trigger.text ?? label}</span>${trigger.icon ? '' : icon('down', { size: 14, className: 'dl-menubtn__chev' })}</button>
<div class="dl-menu" id="${id}-list" role="menu" aria-labelledby="${id}" hidden data-ui-keep="hidden">${items}</div>
</div>`;
}

const parts = root => ({ trigger: root.querySelector(':scope > .dl-menubtn__trigger'), list: root.querySelector(':scope > .dl-menu') });
const itemsOf = list => [...list.querySelectorAll('.dl-menu__item')];

// 位置：默认向下；下方放不下且上方更宽松时翻到上方。
function place(root, list) {
  root.removeAttribute('data-flip');
  const rect = list.getBoundingClientRect(), room = root.getBoundingClientRect();
  const below = window.innerHeight - room.bottom, above = room.top;
  const wantsUp = root.dataset.placement.startsWith('up');
  const fits = wantsUp ? above >= rect.height + 8 : below >= rect.height + 8;
  if (!fits && (wantsUp ? below : above) > (wantsUp ? above : below)) root.setAttribute('data-flip', '1');
}

// 内部：只有用户操作（带 event）才派发 ui:open / ui:close；程序化关闭（closeMenus）静默。
function setOpen(root, open, event) {
  const { trigger, list } = parts(root);
  if (!trigger || !list || (open && trigger.disabled) || list.hidden !== open) return;
  if (open) for (const other of document.querySelectorAll('.dl-menubtn[data-open="1"]')) if (other !== root) setOpen(other, false, event);
  list.hidden = !open;
  trigger.setAttribute('aria-expanded', String(open));
  if (open) { root.dataset.open = '1'; place(root, list); } else { root.removeAttribute('data-open'); root.removeAttribute('data-flip'); }
  if (event) emit(root, open ? 'open' : 'close', { value: '', source: sourceOf(event) });
  if (open) (itemsOf(list).find(el => !el.disabled))?.focus();
}

// 程序化关闭（路由切换、重绘前）：静默，不派发 ui:close。
export function closeMenus(scope = document) {
  for (const root of scope.querySelectorAll('.dl-menubtn[data-open="1"]')) setOpen(root, false);
}

install('menu', doc => {
  doc.addEventListener('click', event => {
    const root = event.target.closest?.('.dl-menubtn');
    const open = doc.querySelector('.dl-menubtn[data-open="1"]');
    if (!root) { if (open) setOpen(open, false, event); return; }
    const item = event.target.closest('.dl-menu__item');
    if (item) {
      if (item.disabled) return;
      const { trigger } = parts(root), value = item.dataset.value ?? '';
      setOpen(root, false, event); trigger.focus();
      emit(root, 'select', { value, source: sourceOf(event) });
      return;
    }
    if (event.target.closest('.dl-menubtn__trigger')) setOpen(root, parts(root).list.hidden, event);
  });
  doc.addEventListener('keydown', event => {
    const root = event.target.closest?.('.dl-menubtn');
    if (!root) return;
    const { trigger, list } = parts(root), isOpen = !list.hidden;
    if (event.target === trigger && !isOpen && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); return setOpen(root, true, event); }
    if (!isOpen) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(root, false, event); trigger.focus(); return; }
    if (event.key === 'Tab') return setOpen(root, false, event);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const all = itemsOf(list), active = all.includes(event.target) ? event.target : null;
      if (!active) return (event.key === 'ArrowUp' || event.key === 'End' ? all.filter(el => !el.disabled).at(-1) : all.find(el => !el.disabled))?.focus();
      moveFocus(all, active, event.key);
    }
  }, true);
});
