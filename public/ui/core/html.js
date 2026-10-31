// 共享 HTML 小工具，用来替换各页面里 13 份本地 esc()。纯函数，可直接在 node 里单测。
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ESCAPES[char]);
}

// 属性值（总是被双引号包住）：与 esc 相同，单独命名让调用点更清楚。
export function attr(value) {
  return esc(value);
}

// 拼 class：忽略 falsy，支持字符串与 { name: boolean } 对象。
export function cx(...parts) {
  const names = [];
  for (const part of parts) {
    if (!part) continue;
    if (typeof part === 'string') names.push(part);
    else if (Array.isArray(part)) { const nested = cx(...part); if (nested) names.push(nested); }
    else for (const [name, on] of Object.entries(part)) if (on) names.push(name);
  }
  return names.join(' ');
}

let counter = 0;
export function uid(prefix = 'ui') {
  counter += 1;
  return `${prefix}-${counter}`;
}

// ---- 转义契约（0.8）----------------------------------------------------------------------------------
// 1. 所有文本类 props 都经过 esc()；
// 2. 子内容（children / slot）只接受 SafeHtml——即 trusted(str) 的返回值，或组件 render() 的返回值；裸字符串一律按文本处理；
// 3. html`…` 标签模板：字面量部分是开发者写的标记，插值默认转义，只有 SafeHtml（和它们的数组）原样拼入。
export class SafeHtml {
  constructor(value) { this.value = String(value); }
  toString() { return this.value; }
}
export const isTrusted = value => value instanceof SafeHtml;
// 把一段「已经确定安全」的标记标记为可信。只用于：开发者写死的字符串、已经转义过的结果。绝不要给它用户输入。
export const trusted = value => (value instanceof SafeHtml ? value : new SafeHtml(value));
const part = value => {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(part).join('');
  return esc(value);
};
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) out += part(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}
// 子内容槽：SafeHtml 原样，其它（含裸字符串）转义。
export const slot = part;
// 布尔属性：true → ` name`，false → ''（返回 SafeHtml，可直接插进 html`` 里）。
export const flag = (name, on) => new SafeHtml(on ? ` ${name}` : '');
