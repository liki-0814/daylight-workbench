// 最小 DOM：只实现 public/ui/ 组件行为用到的那部分，让组件的事件委托能在 node 里直接测（仓库里没有 jsdom / happy-dom，也不引入）。
//   · 事件：捕获 / 目标 / 冒泡三阶段、stopPropagation、preventDefault（只对 cancelable 生效）、capture 监听；
//   · 节点：Element / Text / DocumentFragment / Document，classList、dataset、attributes、hidden / disabled / open 与属性同步；
//   · 选择器：标签、.class、[attr]、[attr="v"]、:scope、:disabled、:not(简单选择器)、后代与 > 组合、逗号列表；
//   · innerHTML：解析组件产出的那种标记（含 svg 自闭合、void 元素、实体）；template.content；
//   · <dialog>：showModal() / close() 只改 open 属性；close() 按浏览器行为再派发一个不冒泡的原生 close 事件（用来证明组件不把它当成 ui:close）。
// 不模拟布局：getBoundingClientRect() 返回元素上的 rect 字段（默认全 0），测试按需设置；offsetParent 只看「已挂载且祖先没有 hidden」。
// 用法：模块必须先 installDom()，再 await import 组件（install() 在 import 时读 document，且每个进程只装一次）。
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
const decode = text => text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name) => {
  if (name[0] === '#') return String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10));
  return NAMED[name.toLowerCase()] ?? whole;
});

let currentDocument = null;

// ---- 事件 ----------------------------------------------------------------------------------------------
export class MiniEvent {
  constructor(type, init = {}) {
    const { bubbles = false, cancelable = false, composed = false, detail, ...rest } = init;
    Object.assign(this, rest);
    this.type = type;
    this.bubbles = bubbles;
    this.cancelable = cancelable;
    this.composed = composed;
    this.detail = detail === undefined ? this.constructor.defaultDetail : detail;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.stopped = false;
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
}
MiniEvent.defaultDetail = 0; // UIEvent.detail：键盘激活的 click 是 0，鼠标点击 ≥ 1
export class MiniCustomEvent extends MiniEvent {}
MiniCustomEvent.defaultDetail = null;

// ---- 选择器 --------------------------------------------------------------------------------------------
function parseCompound(src) {
  const compound = { tag: null, classes: [], attrs: [], pseudos: [], nots: [] };
  let i = 0;
  const ident = () => {
    const found = /^[\w-]+/.exec(src.slice(i));
    if (!found) throw new Error(`mini-dom: bad selector "${src}"`);
    i += found[0].length;
    return found[0];
  };
  if (src[i] === '*') i += 1;
  else if (src[i] && /[a-zA-Z]/.test(src[i])) compound.tag = ident().toUpperCase();
  while (i < src.length) {
    const ch = src[i];
    if (ch === '.') { i += 1; compound.classes.push(ident()); }
    else if (ch === '[') {
      const end = src.indexOf(']', i);
      const found = /^([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|(.*)))?$/.exec(src.slice(i + 1, end));
      if (end < 0 || !found) throw new Error(`mini-dom: bad attribute selector "${src}"`);
      compound.attrs.push({ name: found[1], value: found[2] ?? found[3] ?? found[4] ?? null });
      i = end + 1;
    } else if (ch === ':') {
      i += 1;
      const name = ident();
      if (name === 'not') {
        const end = src.indexOf(')', i);
        compound.nots.push(parseCompound(src.slice(i + 1, end)));
        i = end + 1;
      } else compound.pseudos.push(name);
    } else throw new Error(`mini-dom: unsupported selector "${src}"`);
  }
  return compound;
}
function parseComplex(src) {
  const parts = [];
  let depth = 0, current = '', combinator = null;
  const flush = () => {
    if (!current) return;
    if (parts.length) parts.push(combinator ?? ' ');
    parts.push(parseCompound(current));
    current = '';
    combinator = null;
  };
  for (const ch of src) {
    if (ch === '[' || ch === '(') depth += 1;
    if (ch === ']' || ch === ')') depth -= 1;
    if (depth === 0 && (ch === ' ' || ch === '>')) { flush(); if (ch === '>') combinator = '>'; continue; }
    current += ch;
  }
  flush();
  return parts;
}
const parsed = new Map();
function parseSelector(src) {
  if (!parsed.has(src)) {
    const lists = [];
    let depth = 0, current = '';
    for (const ch of src) {
      if (ch === '[' || ch === '(') depth += 1;
      if (ch === ']' || ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) { lists.push(current); current = ''; } else current += ch;
    }
    lists.push(current);
    parsed.set(src, lists.map(item => parseComplex(item.trim())));
  }
  return parsed.get(src);
}
function matchCompound(el, compound, scope) {
  if (compound.tag && el.nodeName !== compound.tag) return false;
  for (const name of compound.classes) if (!el.classList.contains(name)) return false;
  for (const { name, value } of compound.attrs) {
    const actual = el.getAttribute(name);
    if (actual === null || (value !== null && actual !== value)) return false;
  }
  for (const pseudo of compound.pseudos) {
    if (pseudo === 'scope') { if (el !== scope) return false; }
    else if (pseudo === 'disabled') { if (!el.hasAttribute('disabled')) return false; }
    else throw new Error(`mini-dom: unsupported pseudo-class :${pseudo}`);
  }
  for (const inner of compound.nots) if (matchCompound(el, inner, scope)) return false;
  return true;
}
function matchAt(el, parts, index, scope) {
  if (!el || el.nodeType !== 1 || !matchCompound(el, parts[index], scope)) return false;
  if (index === 0) return true;
  if (parts[index - 1] === '>') return matchAt(el.parentNode, parts, index - 2, scope);
  for (let up = el.parentNode; up; up = up.parentNode) if (matchAt(up, parts, index - 2, scope)) return true;
  return false;
}
const matchesAny = (el, selector, scope) => parseSelector(selector).some(parts => matchAt(el, parts, parts.length - 1, scope));
function walk(node, visit) {
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) continue;
    visit(child);
    walk(child, visit);
  }
}

// ---- 节点 ----------------------------------------------------------------------------------------------
class MiniNode {
  constructor(nodeType, nodeName) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.parentNode = null;
    this.childNodes = [];
    this.listeners = [];
  }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node.nodeType === 9;
  }
  insertBefore(node, ref) {
    if (node.nodeType === 11) { for (const child of [...node.childNodes]) this.insertBefore(child, ref); return node; }
    if (node === ref) return node;
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }
  appendChild(node) { return this.insertBefore(node, null); }
  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index < 0) throw new Error('mini-dom: removeChild of a node that is not a child');
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  append(...nodes) { for (const node of nodes) this.appendChild(typeof node === 'string' ? new MiniText(node) : node); }
  contains(node) {
    for (let up = node; up; up = up.parentNode) if (up === this) return true;
    return false;
  }
  get firstElementChild() { return this.childNodes.find(child => child.nodeType === 1) ?? null; }
  get children() { return this.childNodes.filter(child => child.nodeType === 1); }
  querySelectorAll(selector) { const out = []; walk(this, el => { if (matchesAny(el, selector, this)) out.push(el); }); return out; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(type, fn, options) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    if (!this.listeners.some(entry => entry.type === type && entry.fn === fn && entry.capture === capture)) this.listeners.push({ type, fn, capture });
  }
  removeEventListener(type, fn, options) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    this.listeners = this.listeners.filter(entry => !(entry.type === type && entry.fn === fn && entry.capture === capture));
  }
  // 三阶段：从根到目标的捕获监听 → 目标上的监听（捕获在前）→ 向上的冒泡监听（只在 bubbles 时）。stopPropagation 阻止走向下一个节点，当前节点上剩余的监听仍然执行。
  dispatchEvent(event) {
    event.target = this;
    const path = [];
    for (let node = this; node; node = node.parentNode) path.push(node);
    const invoke = (node, phase) => {
      event.currentTarget = node;
      for (const entry of [...node.listeners]) {
        if (entry.type !== event.type) continue;
        if (phase === 'capture' && !entry.capture) continue;
        if (phase === 'bubble' && entry.capture) continue;
        entry.fn.call(node, event);
      }
    };
    for (let i = path.length - 1; i > 0 && !event.stopped; i -= 1) invoke(path[i], 'capture');
    if (!event.stopped) {
      event.currentTarget = this;
      for (const entry of [...this.listeners]) if (entry.type === event.type && entry.capture) entry.fn.call(this, event);
      for (const entry of [...this.listeners]) if (entry.type === event.type && !entry.capture) entry.fn.call(this, event);
    }
    if (event.bubbles) for (let i = 1; i < path.length && !event.stopped; i += 1) invoke(path[i], 'bubble');
    event.currentTarget = null;
    return !event.defaultPrevented;
  }
}

class MiniText extends MiniNode {
  constructor(data) { super(3, '#text'); this.data = String(data); }
  get nodeValue() { return this.data; }
  set nodeValue(value) { this.data = String(value); }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value); }
}
class MiniFragment extends MiniNode {
  constructor() { super(11, '#document-fragment'); }
}

function parseInto(root, source) {
  const stack = [root];
  let i = 0;
  while (i < source.length) {
    if (source[i] === '<') {
      if (source.startsWith('<!--', i)) { const end = source.indexOf('-->', i); i = end < 0 ? source.length : end + 3; continue; }
      if (source[i + 1] === '/') {
        const end = source.indexOf('>', i);
        const name = source.slice(i + 2, end).trim().toUpperCase();
        for (let k = stack.length - 1; k > 0; k -= 1) if (stack[k].nodeName === name) { stack.length = k; break; }
        i = end + 1;
        continue;
      }
      const open = /^<([a-zA-Z][^\s/>]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*(\/?)>/.exec(source.slice(i));
      if (open) {
        const el = currentDocument.createElement(open[1]);
        for (const found of open[2].matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g)) el.setAttribute(found[1], decode(found[2] ?? found[3] ?? found[4] ?? ''));
        stack[stack.length - 1].appendChild(el);
        if (!open[3] && !VOID.has(open[1].toLowerCase())) stack.push(el);
        i += open[0].length;
        continue;
      }
    }
    let end = source.indexOf('<', i + 1);
    if (end < 0) end = source.length;
    stack[stack.length - 1].appendChild(new MiniText(decode(source.slice(i, end))));
    i = end;
  }
}

const reflect = (proto, prop, attr = prop) => Object.defineProperty(proto, prop, {
  get() { return this.hasAttribute(attr); },
  set(value) { this.toggleAttribute(attr, !!value); },
});

export class MiniElement extends MiniNode {
  constructor(tag) {
    super(1, tag.toUpperCase());
    this.tagName = this.nodeName;
    this.namespaceURI = 'http://www.w3.org/1999/xhtml';
    this.attrs = new Map();
    this.scrollTop = 0;
    this.rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
    if (this.nodeName === 'TEMPLATE') this.content = new MiniFragment();
  }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  setAttribute(name, value) { this.attrs.set(name.toLowerCase(), String(value)); }
  removeAttribute(name) { this.attrs.delete(name); }
  hasAttribute(name) { return this.attrs.has(name); }
  toggleAttribute(name, force) {
    const on = force === undefined ? !this.attrs.has(name) : !!force;
    if (on) { if (!this.attrs.has(name)) this.attrs.set(name, ''); } else this.attrs.delete(name);
    return on;
  }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(value) { this.setAttribute('class', value); }
  get classList() {
    const el = this;
    const tokens = () => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    const write = list => el.setAttribute('class', list.join(' '));
    return {
      contains: name => tokens().includes(name),
      add: (...names) => { const list = tokens(); for (const name of names) if (!list.includes(name)) list.push(name); write(list); },
      remove: (...names) => write(tokens().filter(name => !names.includes(name))),
      toggle: (name, force) => { const on = force === undefined ? !tokens().includes(name) : !!force; if (on) this.classList.add(name); else this.classList.remove(name); return on; },
    };
  }
  get dataset() {
    const el = this;
    const attr = key => `data-${key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)}`;
    return new Proxy({}, {
      get: (_, key) => (typeof key === 'string' && el.hasAttribute(attr(key)) ? el.getAttribute(attr(key)) : undefined),
      set: (_, key, value) => { el.setAttribute(attr(key), value); return true; },
      deleteProperty: (_, key) => { el.removeAttribute(attr(key)); return true; },
      has: (_, key) => typeof key === 'string' && el.hasAttribute(attr(key)),
    });
  }
  get value() {
    if (this.nodeName === 'TEXTAREA') return this.formValue ?? this.textContent;
    return this.formValue ?? this.getAttribute('value') ?? '';
  }
  set value(next) { this.formValue = String(next); }
  get textContent() { return this.childNodes.map(child => child.textContent).join(''); }
  set textContent(value) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    if (String(value) !== '') this.appendChild(new MiniText(value));
  }
  set innerHTML(source) {
    const target = this.nodeName === 'TEMPLATE' ? this.content : this;
    for (const child of [...target.childNodes]) target.removeChild(child);
    parseInto(target, String(source));
  }
  get offsetParent() {
    if (!this.isConnected) return null;
    for (let up = this; up && up.nodeType === 1; up = up.parentNode) if (up.hasAttribute('hidden')) return null;
    return this.parentNode;
  }
  getBoundingClientRect() { return { ...this.rect }; }
  matches(selector) { return matchesAny(this, selector, null); }
  closest(selector) {
    for (let up = this; up && up.nodeType === 1; up = up.parentNode) if (matchesAny(up, selector, null)) return up;
    return null;
  }
  // 不可见 / 已禁用 / 未挂载的元素拿不到焦点（与浏览器一致）。
  focus() {
    if (this.disabled || !this.isConnected || this.offsetParent === null) return;
    currentDocument.activeElement = this;
  }
  blur() { if (currentDocument.activeElement === this) currentDocument.activeElement = currentDocument.body; }
  // 程序化 click()：detail 为 0（和键盘激活一致）；禁用的按钮什么都不发生。
  click() {
    if (this.disabled) return;
    this.dispatchEvent(new MiniEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 0 }));
  }
  showModal() { this.setAttribute('open', ''); }
  close() {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new MiniEvent('close')); // 浏览器：不冒泡，document 的捕获监听仍然能收到
  }
}
reflect(MiniElement.prototype, 'hidden');
reflect(MiniElement.prototype, 'disabled');
reflect(MiniElement.prototype, 'open');

export class MiniDocument extends MiniNode {
  constructor() {
    super(9, '#document');
    currentDocument = this;
    this.documentElement = this.createElement('html');
    this.body = this.createElement('body');
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
    this.activeElement = this.body;
  }
  createElement(tag) { return new MiniElement(tag); }
  createTextNode(text) { return new MiniText(text); }
}

// ---- 安装与测试辅助 ---------------------------------------------------------------------------------------
export function installDom() {
  const doc = new MiniDocument();
  globalThis.document = doc;
  globalThis.window = { innerHeight: 768, document: doc };
  globalThis.CustomEvent = MiniCustomEvent;
  return doc;
}
// 清空 body（每条用例开头调用）；监听器装在 document 上，保留。
export function resetBody() {
  for (const child of [...document.body.childNodes]) document.body.removeChild(child);
  document.activeElement = document.body;
  window.innerHeight = 768;
}
// 把组件的 SafeHtml / 字符串渲染进 body，返回 { host, el }：host 是包裹 div，el 是第一个元素。
export function mount(markup, parent = document.body) {
  const host = document.createElement('div');
  host.innerHTML = String(markup);
  parent.append(host);
  return { host, el: host.firstElementChild };
}
export const fire = (target, type, init = {}) => {
  const event = new MiniEvent(type, { bubbles: true, cancelable: true, composed: true, ...init });
  target.dispatchEvent(event);
  return event;
};
// 鼠标点击：detail 1。键盘激活（Enter / Space 触发按钮）：detail 0。
export const click = (target, init = {}) => fire(target, 'click', { detail: 1, ...init });
export const keyboardClick = (target, init = {}) => fire(target, 'click', { detail: 0, ...init });
export const keydown = (target, key, init = {}) => fire(target, 'keydown', { key, ...init });
// 记录 ui:* 事件：返回 { log, stop, types() }。log 项含事件对象本身（target / detail / cancelable / bubbles / composed）。
const UI_TYPES = ['ui:change', 'ui:select', 'ui:open', 'ui:close', 'ui:dismiss'];
export function record(types = UI_TYPES) {
  const log = [];
  const handler = event => log.push({ type: event.type, target: event.target, detail: event.detail, cancelable: event.cancelable, bubbles: event.bubbles, composed: event.composed, event });
  for (const type of types) document.addEventListener(type, handler);
  return { log, types: () => log.map(item => item.type), stop: () => { for (const type of types) document.removeEventListener(type, handler); } };
}
// 页面侧的 preventDefault：对 type 的事件调用 preventDefault()，返回撤销函数。
export function preventAll(type) {
  const handler = event => event.preventDefault();
  document.addEventListener(type, handler);
  return () => document.removeEventListener(type, handler);
}
// 可控的假定时器（只替换 setTimeout / clearTimeout；用完必须 restore()）。
export function fakeTimers() {
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  let now = 0, seq = 0;
  const timers = new Map();
  globalThis.setTimeout = (fn, ms = 0) => { seq += 1; timers.set(seq, { at: now + ms, fn }); return seq; };
  globalThis.clearTimeout = id => { timers.delete(id); };
  return {
    tick(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    get pending() { return timers.size; },
    restore() { globalThis.setTimeout = real.setTimeout; globalThis.clearTimeout = real.clearTimeout; },
  };
}
