import { escapeButtonText as esc } from '../components/button.js';

// 扩展页工具栏的「添加 ▾」菜单（0.7 PR-8）：把「新建」和「导入」收进同一个入口。
// 外框保留 .extension-category-action（L2–L5 的布局锚点就是它：宽度/位置与原来的单个按钮一致），菜单浮在下方，不挤动工具栏。
// 键盘：Enter / Space / ↓ 打开并聚焦第一项，↑ 打开并聚焦最后一项；菜单里 ↑ ↓ Home End 移动，Esc 关闭并回到按钮，Tab 关闭；点外面关闭。

export const ADD_MENU_ITEMS = Object.freeze({
  skills: [{ key: 'create', label: '新建 Skill…', attr: 'data-create' }, { key: 'import-skill', label: '从文件夹导入…', attr: 'data-import-skill' }],
  mcp: [{ key: 'create', label: '新建 MCP 服务…', attr: 'data-create' }, { key: 'import-json', label: '导入 JSON…', attr: 'data-import-json' }],
});
export const addMenuItems = tab => ADD_MENU_ITEMS[tab] || null;

// 下一个高亮项（循环）。key：ArrowDown / ArrowUp / Home / End；index -1 表示还没有。
export function nextMenuIndex(key, index, count) {
  if (!count) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowDown') return index < 0 ? 0 : (index + 1) % count;
  if (key === 'ArrowUp') return index < 0 ? count - 1 : (index - 1 + count) % count;
  return index;
}

export function addMenuMarkup(tab, { disabled = false, reason = '' } = {}) {
  const items = addMenuItems(tab); if (!items) return '';
  return `<button type="button" class="secondary extension-add-trigger" data-add-menu-button aria-haspopup="menu" aria-expanded="false" aria-controls="extension-add-menu" ${disabled ? `disabled title="${esc(reason)}"` : ''}>添加 <span aria-hidden="true">▾</span></button>`
    + `<div class="extension-add-list" id="extension-add-menu" role="menu" aria-label="添加" data-add-menu-list hidden>${items.map(item => `<button type="button" role="menuitem" tabindex="-1" class="extension-add-item" ${item.attr} data-add-item="${item.key}">${esc(item.label)}</button>`).join('')}</div>`;
}

// 绑定行为（事件挂在 slot 上，slot 内容换了也不用重绑）；返回 dispose。选中菜单项时先关菜单、焦点回按钮，再交给原来的点击处理（它会开对话框）。
export function mountAddMenu(slot) {
  const abort = new AbortController(), { signal } = abort;
  const trigger = () => slot.querySelector('[data-add-menu-button]'), list = () => slot.querySelector('[data-add-menu-list]'), items = () => [...slot.querySelectorAll('[role="menuitem"]')];
  const isOpen = () => !!list() && !list().hidden;
  function close({ focus = false } = {}) { const box = list(); if (!box || box.hidden) return; box.hidden = true; trigger()?.setAttribute('aria-expanded', 'false'); if (focus) trigger()?.focus(); }
  function open(at = 'first') {
    const box = list(), button = trigger(); if (!box || !button || button.disabled) return;
    box.hidden = false; button.setAttribute('aria-expanded', 'true');
    const all = items(); (at === 'last' ? all.at(-1) : all[0])?.focus();
  }
  slot.addEventListener('click', event => {
    const button = event.target.closest?.('[data-add-menu-button]');
    if (button) { isOpen() ? close() : open(); return; }
    if (event.target.closest?.('[role="menuitem"]')) close({ focus: true });   // 先把焦点放回按钮：随后打开的对话框会记住它，关闭后焦点回到「添加 ▾」
  }, { signal });
  slot.addEventListener('keydown', event => {
    const onTrigger = event.target.closest?.('[data-add-menu-button]');
    if (onTrigger && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); open(event.key === 'ArrowUp' ? 'last' : 'first'); return; }
    if (!isOpen()) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close({ focus: true }); return; }
    if (event.key === 'Tab') { close(); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && event.target.closest?.('[role="menuitem"]')) {
      event.preventDefault(); const all = items(), index = nextMenuIndex(event.key, all.indexOf(document.activeElement), all.length); all[index]?.focus();
    }
  }, { signal });
  document.addEventListener('pointerdown', event => { if (!slot.isConnected) { abort.abort(); return; } if (isOpen() && !slot.contains(event.target)) close(); }, { signal });
  document.addEventListener('focusin', event => { if (isOpen() && !slot.contains(event.target)) close(); }, { signal });
  return { close, dispose: () => abort.abort() };
}
