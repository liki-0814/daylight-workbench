const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function linkURL(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}
// Keep ordinary notes as text; only named Markdown links become interactive.
export function notesHTML(text) {
  const pattern = /\[((?:\\.|[^\]\\])+)\]\((<[^>\n]+>|https?:\/\/[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)\)/g;
  let html = '', start = 0;
  for (const match of String(text || '').matchAll(pattern)) {
    html += escape(text.slice(start, match.index));
    const label = match[1].replace(/\\([\\[\]])/g, '$1');
    const url = linkURL(match[2].replace(/^<|>$/g, ''));
    html += url ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer" contenteditable="false">${escape(label)}</a>` : escape(match[0]);
    start = match.index + match[0].length;
  }
  return html + escape(String(text || '').slice(start));
}
export function notesText(editor) {
  function read(node) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeName === 'BR') return '\n';
    const text = [...node.childNodes].map(read).join('');
    if (node.nodeName === 'A') {
      const url = linkURL(node.getAttribute('href'));
      if (url) return `[${text.replace(/[\\[\]]/g, '\\$&')}](${url.replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
    }
    return ['DIV','P'].includes(node.nodeName) ? '\n' + text : text;
  }
  return [...editor.childNodes].map(read).join('').replace(/^\n/, '');
}
export function notesField(text) {
  return `<div class="notes-field"><div class="notes-heading"><label id="notes-label">备注 <span>选填</span></label><button type="button" class="small-button" data-notes-link>添加链接</button></div><textarea name="notes" hidden>${escape(text)}</textarea><div class="notes-editor" contenteditable="true" role="textbox" aria-multiline="true" aria-labelledby="notes-label" data-placeholder="添加备注">${notesHTML(text)}</div><div class="notes-link-form" hidden><label>显示文字<input data-link-label placeholder="具体问题或文档名称"></label><label>链接地址<input data-link-url type="url" placeholder="https://…"></label><div><button type="button" class="small-button" data-link-save>插入</button><button type="button" class="small-button" data-link-cancel>取消</button></div><small data-link-error role="alert"></small></div></div>`;
}
export function mountNotes(root) {
  const editor = root.querySelector('.notes-editor');
  if (!editor) return;
  const value = root.querySelector('[name="notes"]'), panel = root.querySelector('.notes-link-form');
  const label = panel.querySelector('[data-link-label]'), url = panel.querySelector('[data-link-url]');
  const sync = () => { value.value = notesText(editor); };
  let range, anchor;
  root.querySelector('[data-notes-link]').addEventListener('mousedown', event => event.preventDefault());
  root.querySelector('[data-notes-link]').addEventListener('click', () => {
    const selection = window.getSelection();
    range = selection.rangeCount && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode) ? selection.getRangeAt(0).cloneRange() : null;
    anchor = selection.anchorNode?.parentElement?.closest('a');
    if (!editor.contains(anchor)) anchor = null;
    label.value = anchor?.textContent || range?.toString() || '';
    url.value = anchor?.getAttribute('href') || '';
    panel.querySelector('[data-link-error]').textContent = '';
    panel.hidden = false; (label.value ? url : label).focus();
  });
  root.querySelector('[data-link-save]').addEventListener('click', () => {
    const href = linkURL(url.value.trim()), title = label.value.trim();
    if (!href || !title) { panel.querySelector('[data-link-error]').textContent = '请填写显示文字和有效的 HTTP / HTTPS 链接。'; return; }
    const a = document.createElement('a'); a.href = href; a.textContent = title; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.contentEditable = 'false';
    if (anchor) anchor.replaceWith(a);
    else {
      if (!range) { range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); }
      range.deleteContents(); range.insertNode(a);
    }
    const caret = document.createRange(); caret.setStartAfter(a); caret.collapse(true);
    editor.focus(); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(caret);
    sync(); panel.hidden = true;
  });
  root.querySelector('[data-link-cancel]').addEventListener('click', () => { panel.hidden = true; editor.focus(); });
  editor.addEventListener('input', sync);
  editor.addEventListener('paste', event => {
    event.preventDefault(); document.execCommand('insertText', false, event.clipboardData.getData('text/plain')); sync();
  });
  editor.addEventListener('drop', event => event.preventDefault());
  editor.addEventListener('click', event => {
    const a = event.target.closest('a');
    if (a) { event.preventDefault(); const link = document.createElement('a'); link.href = a.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; document.body.append(link); link.click(); link.remove(); }
  });
  // Preserve untouched existing notes byte for byte; synchronize only after editing.
}
