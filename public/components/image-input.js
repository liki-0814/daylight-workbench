import { maxImages, maxImageBytes, imageMimeTypes } from '../../core/ai-images.js';
import { createDialogShell } from './dialog-shell.js';
import { actionButton } from './button.js';

const readDataURL = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('图片读取失败，请重新复制'));
  reader.readAsDataURL(file);
});
async function readImage(file) {
  if (!imageMimeTypes.includes(file.type)) throw new Error('请粘贴 PNG、JPEG 或 WebP 图片');
  if (file.size > 20_000_000) throw new Error('原始图片不能超过 20 MB');
  let dataURL = await readDataURL(file), mimeType = file.type;
  if (file.size > maxImageBytes) {
    const image = new Image(); image.src = dataURL;
    await image.decode();
    const scale = Math.min(1, 2048 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    dataURL = canvas.toDataURL('image/jpeg', .85); mimeType = 'image/jpeg';
  }
  return { mimeType, data: dataURL.slice(dataURL.indexOf(',') + 1) };
}

export function mountImageInput(root, { onChange, onError, onPreviewChange }) {
  let images = [], generation = 0, pending = false, disabled = false;
  const dialog = createDialogShell({ title: '图片预览', onClose: () => onPreviewChange?.(false) });
  dialog.element.classList.add('image-preview-dialog');
  function openPreview(image, index) {
    const content = document.createElement('div');
    const toolbar = document.createElement('div'); toolbar.className = 'image-preview-toolbar';
    toolbar.innerHTML = actionButton({ label: '实际大小', variant: 'text' });
    const viewport = document.createElement('div'); viewport.className = 'image-preview-viewport'; viewport.tabIndex = 0; viewport.setAttribute('aria-label', '图片内容，可滚动查看');
    const large = document.createElement('img'); large.src = `data:${image.mimeType};base64,${image.data}`; large.alt = `图片 ${index + 1} 的放大预览`;
    const zoom = () => { const actual = viewport.classList.toggle('is-actual'); toolbar.querySelector('button').textContent = actual ? '适应窗口' : '实际大小'; };
    toolbar.querySelector('button').addEventListener('click', zoom); large.addEventListener('click', zoom);
    content.addEventListener('click', event => { if ([content, toolbar, viewport].includes(event.target)) dialog.close(); });
    viewport.append(large); content.append(toolbar, viewport); dialog.setContent(content);
    if (dialog.open()) onPreviewChange?.(true);
  }
  function paint() {
    root.replaceChildren(); root.hidden = !images.length && !pending;
    for (const [index, image] of images.entries()) {
      const item = document.createElement('div'); item.className = 'image-input-item';
      const preview = document.createElement('img'); preview.src = `data:${image.mimeType};base64,${image.data}`; preview.alt = `已粘贴的图片 ${index + 1}`;
      const enlarge = document.createElement('button'); enlarge.type = 'button'; enlarge.className = 'image-input-preview'; enlarge.setAttribute('aria-label', `放大查看图片 ${index + 1}`); enlarge.title = '放大查看'; enlarge.append(preview);
      enlarge.addEventListener('click', () => openPreview(image, index));
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.className = 'image-input-remove'; remove.setAttribute('aria-label', `移除图片 ${index + 1}`); remove.disabled = disabled || pending;
      remove.addEventListener('click', () => { images.splice(index, 1); paint(); root.dispatchEvent(new Event('image-removed', { bubbles: true })); });
      item.append(enlarge, remove); root.append(item);
    }
    if (pending) { const note = document.createElement('span'); note.textContent = '正在读取图片…'; root.append(note); }
    onChange?.();
  }
  return {
    get images() { return images.map(image => ({ ...image })); },
    get pending() { return pending; },
    set disabled(value) { disabled = value; for (const button of root.querySelectorAll('.image-input-remove')) button.disabled = disabled || pending; },
    async paste(event) {
      const items = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file' && item.type.startsWith('image/'));
      if (!items.length || disabled) return false;
      event.preventDefault();
      if (pending) return true;
      if (images.length + items.length > maxImages) { onError?.(new Error(`最多粘贴 ${maxImages} 张图片`)); return true; }
      const ticket = generation; pending = true; paint();
      try {
        const added = await Promise.all(items.map(item => { const file = item.getAsFile(); if (!file) throw new Error('图片不可读取，请重新复制'); return readImage(file); }));
        if (ticket !== generation) return true;
        const next = images.concat(added);
        if (next.reduce((sum, image) => sum + image.data.length * 3 / 4, 0) > maxImageBytes) throw new Error('图片总大小不能超过 2 MB，请减少图片');
        images = next;
      } catch (error) { if (ticket === generation) onError?.(error); }
      finally { if (ticket === generation) { pending = false; paint(); } }
      return true;
    },
    clear() { generation++; dialog.close(); dialog.setContent(document.createElement('div')); images = []; pending = false; disabled = false; paint(); },
  };
}
