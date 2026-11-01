import { html, attrs, cx, esc, uid, flag, trusted } from '../../core/html.js';
import { icon } from '../../core/icons.js';
import { dot } from '../chip/chip.js';
import { emit, sourceOf } from '../../core/events.js';
import { install, moveFocus } from '../../core/behave.js';

// select({ name, value, label, options, variant, placeholder, search, placement, width, attrs })
//   options: [{ value, label, dot?, icon?, meta?, divider?: true, action?: true }]
//   variant: field（36 高的输入框外观）| chip（胶囊属性标签）| ghost
//   action: true 的项（如「新建项目…」）不改变值，只派发 ui:select。
//   菜单向下展开（placement: 'down'），可以超出所在容器 / 弹窗边缘（dialog 不裁切）。
export function select({ name, value = '', label, options = [], variant = 'field', placeholder = '未选择', search = false, placement = 'down', attrs: extra, id = uid('dl-select'), disabled = false } = {}) {
  if (!label) throw new TypeError('select needs a label (aria-label)');
  const current = options.find(option => !option.divider && String(option.value) === String(value));
  const items = options.map(option => option.divider
    ? html`<div class="dl-menu__divider" role="separator"></div>`
    : html`<button class="${cx('dl-menu__item', option.action && 'is-action')}" type="button" role="option" aria-selected="${!option.action && String(option.value) === String(value) ? 'true' : 'false'}" data-value="${option.value}" data-label="${option.label}" data-key="${option.value}">${option.dot ? dot(option.dot) : ''}${option.icon ? icon(option.icon, { size: 14 }) : ''}<span class="dl-menu__label">${option.label}</span>${option.meta ? html`<span class="dl-menu__meta">${option.meta}</span>` : ''}${!option.action && String(option.value) === String(value) ? icon('check', { size: 14, className: 'dl-menu__check' }) : ''}</button>`);
  const triggerClass = variant === 'chip' ? 'dl-chip' : variant === 'ghost' ? 'dl-select__trigger dl-select__trigger--ghost' : 'dl-select__trigger';
  return html`<div class="${cx('dl-select', `dl-select--${esc(variant)}`)}" data-ui="select" data-placement="${placement}" data-ui-keep="data-open"${name ? attrs({ 'data-name': name }) : ''}${attrs(extra)}>
<button class="${cx(triggerClass, !current && 'is-empty')}" type="button" id="${id}" aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}-menu" aria-label="${label}"${flag('disabled', disabled)} data-ui-keep="aria-expanded" data-value="${value}" data-placeholder="${placeholder}">${current?.dot ? dot(current.dot) : ''}<span class="dl-select__value">${current ? current.label : placeholder}</span>${icon('down', { size: 14, className: 'dl-select__chev' })}</button>
<div class="dl-menu" id="${id}-menu" role="listbox" aria-label="${label}" hidden data-ui-keep="hidden">${search ? html`<input class="dl-menu__search" type="text" aria-label="搜索 ${label}" placeholder="搜索…" autocomplete="off" data-ui-keep="value">` : ''}${items}</div>
</div>`;
}

const parts = root => ({ trigger: root.querySelector(':scope > .dl-select__trigger, :scope > .dl-chip'), menu: root.querySelector(':scope > .dl-menu') });
const itemsOf = menu => [...menu.querySelectorAll('.dl-menu__item')];

// 内部：只有用户操作（带 event）才派发 ui:open / ui:close；程序化关闭（closeSelects）静默。
function setOpen(root, open, event) {
  const { trigger, menu } = parts(root);
  if (!trigger || !menu || (open && trigger.disabled) || menu.hidden !== open) return;
  if (open) for (const other of document.querySelectorAll('.dl-select[data-open="1"]')) if (other !== root) setOpen(other, false, event);
  menu.hidden = !open;
  trigger.setAttribute('aria-expanded', String(open));
  root.toggleAttribute('data-open', open);
  if (open) root.dataset.open = '1';
  if (event) emit(root, open ? 'open' : 'close', { value: null, source: sourceOf(event) });
  if (open) {
    const search = menu.querySelector('.dl-menu__search');
    (search || menu.querySelector('.dl-menu__item[aria-selected="true"]') || itemsOf(menu)[0])?.focus();
  }
}

// 由「当前值」整体渲染选择器的状态：data-value、显示文字（无匹配项 → 占位符）、is-empty、各选项的 aria-selected。
// 乐观更新与回滚都走这一个函数——回滚就是用原值再渲染一次，不逐个补丁 class / 属性，也就不会漏掉某一项状态。
function renderValue(root, value) {
  const { trigger, menu } = parts(root);
  const label = trigger.querySelector('.dl-select__value');
  const options = itemsOf(menu);
  const current = options.find(el => !el.classList.contains('is-action') && (el.dataset.value ?? '') === value);
  trigger.dataset.value = value;
  trigger.classList.toggle('is-empty', !current);
  if (label) label.textContent = current ? (current.dataset.label ?? value) : (trigger.dataset.placeholder ?? '');
  for (const el of options) el.setAttribute('aria-selected', String(el === current));
}

function pick(root, item, event) {
  const { trigger } = parts(root);
  const value = item.dataset.value ?? '';
  const source = sourceOf(event);
  // 契约 E-10：ui:select / ui:change 先于 ui:close。先静默收起菜单并把焦点还给触发按钮（监听器看到的是已关闭的 DOM），
  // 通知值之后再补发 close（只有菜单原来是打开的才派发）。
  const wasOpen = !parts(root).menu.hidden;
  const emitClose = () => { if (wasOpen) emit(root, 'close', { value: null, source }); };
  setOpen(root, false); trigger.focus();
  if (item.classList.contains('is-action')) {
    emit(root, 'select', { value, source });
    emitClose();
    return;
  }
  const previousValue = trigger.dataset.value ?? '';
  if (previousValue === value) return emitClose();
  // 乐观更新：先按新值渲染，ui:change 被取消就按原值重新渲染（回滚 = 再渲染一次，见 renderValue）。
  renderValue(root, value);
  if (!emit(root, 'change', { value, previousValue, source }, { cancelable: true })) renderValue(root, previousValue);
  emitClose();
}

export function closeSelects(scope = document) {
  for (const root of scope.querySelectorAll('.dl-select[data-open="1"]')) setOpen(root, false);
}

install('select', doc => {
  doc.addEventListener('click', event => {
    const root = event.target.closest?.('.dl-select');
    const open = doc.querySelector('.dl-select[data-open="1"]');
    if (!root) { if (open) setOpen(open, false, event); return; }
    const item = event.target.closest('.dl-menu__item');
    if (item) return pick(root, item, event);
    if (event.target.closest('.dl-select__trigger, .dl-chip')) setOpen(root, root.querySelector(':scope > .dl-menu').hidden, event);
  });
  doc.addEventListener('keydown', event => {
    const root = event.target.closest?.('.dl-select');
    if (!root) return;
    const { trigger, menu } = parts(root);
    const isOpen = !menu.hidden;
    if (event.target === trigger && !isOpen && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); return setOpen(root, true, event); }
    if (!isOpen) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(root, false, event); trigger.focus(); return; }
    if (event.key === 'Tab') return setOpen(root, false, event);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && event.target !== trigger) {
      event.preventDefault();
      const list = itemsOf(menu);
      const active = list.includes(event.target) ? event.target : null;
      if (!active && event.key === 'ArrowUp') return list.at(-1)?.focus();
      if (!active) return list.find(el => !el.hidden)?.focus();
      moveFocus(list, active, event.key);
    }
  }, true);
  doc.addEventListener('input', event => {
    const search = event.target.closest?.('.dl-menu__search');
    if (!search) return;
    const needle = search.value.trim().toLowerCase();
    for (const item of itemsOf(search.closest('.dl-menu'))) item.hidden = !!needle && !(item.dataset.label ?? '').toLowerCase().includes(needle);
  });
});
