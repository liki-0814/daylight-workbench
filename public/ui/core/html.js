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
