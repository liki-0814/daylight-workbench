// 增量更新：把 host 的子节点就地改成 content（SafeHtml / 字符串）的样子，而不是 innerHTML 整体重绘。
// 目的：焦点、输入法组合态（IME）、光标位置、滚动位置、已展开的菜单都不会因为重绘丢失。
//   · 节点按顺序匹配（同标签才复用）；带 data-key 的节点按 key 匹配、可移动，列表增删 / 重排不会重建其它行；
//   · 正在聚焦或正在组合输入的 input / textarea 不改 value；
//   · 节点上 data-ui-keep="open aria-expanded" 列出的属性由组件自己维护，morph 不覆盖；
//   · data-ui-static 的子树整个跳过（外部管理的内容）。
const keyOf = node => (node.nodeType === 1 ? node.getAttribute('data-key') : null);
const same = (a, b) => a.nodeType === b.nodeType && (a.nodeType !== 1 || (a.nodeName === b.nodeName && a.namespaceURI === b.namespaceURI));
let composing = false;
if (typeof document !== 'undefined') {
  document.addEventListener('compositionstart', () => { composing = true; }, true);
  document.addEventListener('compositionend', () => { composing = false; }, true);
}

function patchAttributes(live, next) {
  const keep = new Set((live.getAttribute('data-ui-keep') || '').split(/\s+/).filter(Boolean));
  for (const { name } of [...live.attributes]) if (!next.hasAttribute(name) && !keep.has(name) && name !== 'data-ui-keep') live.removeAttribute(name);
  for (const { name, value } of [...next.attributes]) if (!keep.has(name) && live.getAttribute(name) !== value) live.setAttribute(name, value);
}
function patchFormState(live, next) {
  const focused = typeof document !== 'undefined' && document.activeElement === live;
  if (live.nodeName === 'INPUT') {
    const type = (live.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') { if (live.checked !== next.hasAttribute('checked')) live.checked = next.hasAttribute('checked'); }
    else if (!(focused && composing) && !focused) { const value = next.getAttribute('value') ?? ''; if (live.value !== value) live.value = value; }
  } else if (live.nodeName === 'TEXTAREA') {
    if (!focused) { const value = next.textContent; if (live.value !== value) live.value = value; }
  }
}
function patchNode(live, next) {
  if (live.nodeType !== 1) { if (live.nodeValue !== next.nodeValue) live.nodeValue = next.nodeValue; return; }
  patchAttributes(live, next);
  patchFormState(live, next);
  if (live.nodeName === 'TEXTAREA' || live.hasAttribute('data-ui-static')) return;
  patchChildren(live, next);
}
export function patchChildren(live, next) {
  const incoming = [...next.childNodes], olds = [...live.childNodes];
  const keyed = new Map();
  for (const node of olds) { const key = keyOf(node); if (key !== null) keyed.set(key, node); }
  const used = new Set();
  let ref = live.firstChild;
  for (const node of incoming) {
    const key = keyOf(node);
    let match = null;
    if (key !== null) { match = keyed.get(key); if (match && (used.has(match) || !same(match, node))) match = null; }
    else { while (ref && keyOf(ref) !== null && used.has(ref)) ref = ref.nextSibling; if (ref && keyOf(ref) === null && same(ref, node)) match = ref; }
    if (match) {
      used.add(match);
      if (match === ref) ref = ref.nextSibling; else live.insertBefore(match, ref);
      patchNode(match, node);
    } else {
      used.add(node);
      live.insertBefore(node, ref);
    }
  }
  for (const node of olds) if (!used.has(node) && node.parentNode === live) live.removeChild(node);
}
export function morph(host, content) {
  const template = document.createElement('template');
  template.innerHTML = String(content);
  patchChildren(host, template.content);
  return host;
}
