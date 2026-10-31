// 组件库自带的线性图标（24×24，stroke currentColor）。路径集合与旧 public/components/icons.js 同源；库内不得 import 库外文件，所以单独一份。
import { trusted, esc } from './html.js';
const paths = {
  tasks: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m7 8 1 1 2-2M12 8h5m-10 5 1 1 2-2m2 1h5M7 18h10"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18M7 14h3M14 14h3M7 18h3"/>',
  timer: '<circle cx="12" cy="14" r="8"/><path d="M9 2h6M12 2v4m6 1 2-2M12 10v5l3 2"/>',
  chart: '<path d="M3 3v18h18M7 17v-6M12 17V7M17 17v-9"/>',
  terminal: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m6 9 3 3-3 3m6 0h6"/>',
  chat: '<path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M7 9h10M7 13h6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  inbox: '<path d="M4 4h16l2 11v5H2v-5L4 4Z"/><path d="M2 15h6l2 3h4l2-3h6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6v.1"/>',
  warning: '<path d="M12 3.5 21 19.5H3L12 3.5Z"/><path d="M12 10v4.5M12 17.2v.1"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.4v.1"/>',
  success: '<circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.8 2.8L16 9.6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3 7V4h6l2 3h10v13H3V7Z"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  'arrow-up': '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  play: '<path d="m8 5 11 7-11 7V5Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15.36-6.36L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.36 6.36L3 16M8 16H3v5"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.65 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03Z"/>',
  paperclip: '<path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L14 7"/>',
  flag: '<path d="M5 21V4m0 1h12l-2 4 2 4H5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  dot: '<circle cx="12" cy="12" r="4" fill="currentColor"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 9-12h-7l1-8Z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  puzzle: '<path d="M9 3h4v3a2 2 0 1 0 4 0V3h4v6h-3a2 2 0 1 0 0 4h3v8H3V13h3a2 2 0 1 1 0-4H3V3h6Z"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 21h16"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
};
export const iconNames = Object.freeze(Object.keys(paths));
// icon('plus', { size: 16 }) → <svg …>（装饰性：aria-hidden；图标按钮自己提供 aria-label）
export function icon(name, { size = 16, className = '' } = {}) {
  const body = paths[name] ?? paths.circle;
  return trusted(`<svg class="dl-icon${className ? ` ${esc(className)}` : ''}" width="${Number(size) || 16}" height="${Number(size) || 16}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`);
}
