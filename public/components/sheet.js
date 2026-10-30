import { createDialogShell } from './dialog-shell.js';
// Sheet（对话框，design-spec §6）：基于原生 <dialog>.showModal()——Esc 关闭、焦点陷阱、背景 inert、关闭后焦点还给触发者都由浏览器和 dialog-shell 负责；
// 这里只加样式（宽 520 / 表单 560、圆角 14、标题居中 15/600）和统一的页脚（取消在左、主要按钮在右）与内联错误区。
// size: 'default'（520）| 'form'（560）。
export const sheetFooter = ({ cancelLabel = '取消', confirmLabel = '确定', destructive = false, confirmAttrs = 'data-sheet-confirm', cancelAttrs = 'data-sheet-cancel' } = {}) =>
  `<p class="ui-sheet-error" role="alert" data-sheet-error></p><div class="dialog-footer ui-sheet-footer"><button type="button" class="secondary" ${cancelAttrs}>${cancelLabel}</button><button type="button" class="${destructive ? 'ui-button ui-button-danger' : 'primary'}" ${confirmAttrs}>${confirmLabel}</button></div>`;
export function createSheet({ title, size = 'default', description = '', onClose } = {}) {
  const shell = createDialogShell({ title, description, onClose });
  shell.element.classList.add('ui-sheet', ...(size === 'form' ? ['ui-sheet-form'] : []));
  return { ...shell, setError(text) { const slot = shell.element.querySelector('[data-sheet-error]'); if (slot) slot.textContent = text || ''; } };
}
