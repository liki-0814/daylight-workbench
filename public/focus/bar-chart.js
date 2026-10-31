// 柱状图（独立、可复用模块；无业务依赖，可整体迁入共享组件库）。
// 只负责：HTML 渲染（字符串，文本一律转义）、悬停/聚焦提示、键盘漫游（roving tabindex）、可访问名称。
// 颜色全部来自 CSS 变量（--bc-*，回退到应用已有令牌），本文件与 bar-chart.css 内没有写死的色值。
//
// 用法：
//   host.innerHTML = barChart({ id, label, bars, yTicks, yMax, xTicks, band, marker, showValues, initialIndex });
//   const dispose = mountBarChart(host.querySelector('.bc'));   // 重新渲染前先 dispose()
//
// barChart 参数：
//   id            必填，唯一 id（用于 aria 关联）
//   label         必填，整张图的可访问名称，例如「今日分时专注」
//   bars[]        { key, value, label, text?, future? }
//                   value  数值（>=0），柱高 = value / yMax
//                   label  该柱的 aria-label（须含时间与数值，例如「07:00–08:00，专注 30 分钟」）
//                   text   提示气泡文字，默认同 label
//                   future 为 true 时不画零值短线（尚未到来）
//   yMax          纵轴最大值（默认取 bars 最大值，至少 1）
//   yTicks[]      { value, label } 纵轴刻度与网格线
//   xTicks[]      { pos(0–1), label?, major? } 横轴刻度；有 label 的才显示文字
//   band[]        { from, to, tone('night'|'day'|…) } 横轴下的 6px 色带（可省略）；tone 对应 CSS 变量 --bc-band-<tone>
//   marker        { pos(0–1), label } 竖线标记（例如「现在 11:30」），可省略
//   showValues    在柱顶显示数值（柱数较少时）
//   initialIndex  roving tabindex 的初始项（默认 0）
// 键盘：← → 移动，Home / End 到首 / 尾；Esc 关闭提示。焦点环 2px，见 bar-chart.css。
import { escapeButtonText as esc } from '../components/button.js';

const POSITION = { 'data-bc-top': 'top', 'data-bc-left': 'left', 'data-bc-width': 'width', 'data-bc-height': 'height' };

export function nextBarIndex(key, index, count) {
  if (count <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowLeft') return Math.max(0, index - 1);
  if (key === 'ArrowRight') return Math.min(count - 1, index + 1);
  return index;
}
const pct = fraction => `${(Math.min(1, Math.max(0, fraction)) * 100).toFixed(3).replace(/\.?0+$/, '')}%`;

export function barChart({ id, label, bars, yMax, yTicks = [], xTicks = [], band = [], marker = null, showValues = false, initialIndex = 0 }) {
  const max = Math.max(1, yMax ?? Math.max(0, ...bars.map(bar => bar.value))), start = bars.length ? Math.min(bars.length - 1, Math.max(0, initialIndex)) : 0;
  const grid = yTicks.map(tick => `<i class="bc-gl" aria-hidden="true" data-bc-top="${pct(1 - tick.value / max)}"></i>`).join('');
  const yLabels = yTicks.map(tick => `<span class="bc-yl" data-bc-top="${pct(1 - tick.value / max)}">${esc(tick.label)}</span>`).join('');
  const cols = bars.map((bar, index) => {
    const fraction = bar.value / max, zero = !(bar.value > 0);
    return `<div class="bc-col" role="img" tabindex="${index === start ? 0 : -1}" data-bc-index="${index}" data-bc-key="${esc(bar.key ?? index)}" data-bc-tip="${esc(bar.text ?? bar.label)}" aria-label="${esc(bar.label)}">${showValues && !zero ? `<span class="bc-val" aria-hidden="true" data-bc-bottom="${pct(fraction)}">${esc(bar.value)}</span>` : ''}<span class="bc-bar${zero ? bar.future ? ' bc-future' : ' bc-zero' : ''}" aria-hidden="true"${zero ? '' : ` data-bc-height="${pct(fraction)}"`}></span></div>`;
  }).join('');
  const ticks = xTicks.map(tick => `<i class="bc-tk${tick.major ? ' bc-major' : ''}" aria-hidden="true" data-bc-left="${pct(tick.pos)}"></i>`).join('');
  const labels = xTicks.filter(tick => tick.label).map(tick => `<span class="bc-tl" aria-hidden="true" data-bc-left="${pct(tick.pos)}">${esc(tick.label)}</span>`).join('');
  const strip = band.length ? `<div class="bc-band" aria-hidden="true">${band.map(part => `<i data-tone="${esc(part.tone)}" data-bc-left="${pct(part.from)}" data-bc-width="${pct(part.to - part.from)}"></i>`).join('')}</div>` : '';
  const now = marker ? `<div class="bc-now${marker.pos > .8 ? ' bc-now-left' : ''}" aria-hidden="true" data-bc-left="${pct(marker.pos)}"><span>${esc(marker.label)}</span></div>` : '';
  return `<div class="bc" id="${esc(id)}" data-bc-count="${bars.length}"><div class="bc-plot"><div class="bc-y" aria-hidden="true">${yLabels}</div><div class="bc-area" role="group" aria-label="${esc(label)}（方向键切换，Esc 关闭提示）">${grid}<div class="bc-cols">${cols}</div>${now}<div class="bc-tip" role="tooltip" hidden></div></div></div><div class="bc-axis${band.length ? ' bc-has-band' : ''}"><div class="bc-ruler"><div class="bc-ticks">${ticks}</div>${strip}${labels}</div></div></div>`;
}

export function mountBarChart(root) {
  const abort = new AbortController(), options = { signal: abort.signal }, area = root.querySelector('.bc-area'), tip = root.querySelector('.bc-tip');
  const columns = [...root.querySelectorAll('.bc-col')];
  // CSP 禁止内联 style 属性：位置与尺寸统一在这里用 CSSOM 设置。
  for (const [attribute, property] of Object.entries(POSITION)) for (const element of root.querySelectorAll(`[${attribute}]`)) element.style[property] = element.getAttribute(attribute);
  for (const element of root.querySelectorAll('[data-bc-bottom]')) element.style.bottom = `calc(${element.getAttribute('data-bc-bottom')} + 1px)`;
  root.style.setProperty('--bc-n', String(columns.length));
  const hide = () => { tip.hidden = true; };
  function show(column) {
    tip.textContent = column.dataset.bcTip; tip.hidden = false;
    const areaBox = area.getBoundingClientRect(), box = column.getBoundingClientRect(), bar = column.querySelector('.bc-bar').getBoundingClientRect();
    const half = tip.offsetWidth / 2, center = box.left - areaBox.left + box.width / 2;
    tip.style.left = `${Math.min(Math.max(center, half), Math.max(half, areaBox.width - half))}px`;
    tip.style.bottom = `${Math.max(0, areaBox.bottom - bar.top) + 6}px`;
  }
  function focusColumn(index) {
    const next = columns[index]; if (!next) return;
    for (const column of columns) column.tabIndex = column === next ? 0 : -1;
    next.focus(); show(next);
  }
  area.addEventListener('pointerover', event => { const column = event.target.closest?.('.bc-col'); if (column) show(column); }, options);
  area.addEventListener('pointerleave', () => { if (!columns.includes(document.activeElement)) hide(); }, options);
  area.addEventListener('focusin', event => { const column = event.target.closest?.('.bc-col'); if (column) show(column); }, options);
  area.addEventListener('focusout', event => { if (!area.contains(event.relatedTarget)) hide(); }, options);
  area.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !tip.hidden) { hide(); return; }
    const column = event.target.closest?.('.bc-col'); if (!column || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); focusColumn(nextBarIndex(event.key, columns.indexOf(column), columns.length));
  }, options);
  return () => abort.abort();
}
