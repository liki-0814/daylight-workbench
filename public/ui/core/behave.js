// 组件行为的共用小工具：文档级事件委托，每种行为只安装一次（import 组件入口文件即安装）。
const installed = new Set();
export function install(key, fn) {
  if (typeof document === 'undefined' || installed.has(key)) return false;
  installed.add(key);
  fn(document);
  return true;
}
// 同一组件的兄弟 / 菜单项之间用方向键移动焦点。
export function moveFocus(items, current, key) {
  const list = items.filter(item => !item.disabled && !item.hidden && item.offsetParent !== null);
  if (!list.length) return null;
  const index = list.indexOf(current);
  const next = key === 'Home' ? 0 : key === 'End' ? list.length - 1 : (index + (key === 'ArrowDown' || key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
  list[next].focus();
  return list[next];
}
