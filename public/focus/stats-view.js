// 专注统计 B 版：仪表盘各区块的 HTML 渲染（字符串；文本一律转义）。数据与口径见 stats-model.js。
import { escapeButtonText as esc } from '../components/button.js';
import { PRESET_NAMES, COMPARE_LABELS, DAILY_GOAL_MINUTES, WEEKDAYS, HEAT_LEGEND, durationParts, durationLabel, deltaInfo, goalMinutes, percentOf, heatLevel, sparkPoints, weekdayIndex } from './stats-model.js';

const svg = (body, cls = 'fd-ic') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
export const ICONS = {
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6v.1"/>', 'fd-ic fd-ic-info'),
  up: svg('<path d="M12 19V5m-6 6 6-6 6 6"/>'), down: svg('<path d="M12 5v14m-6-6 6 6 6-6"/>'), flat: svg('<path d="M5 12h14"/>'),
  filter: svg('<path d="M4 6h16M7 12h10M10 18h4"/>'), more: svg('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>'),
  play: svg('<path d="M8 5.5v13l10-6.5-10-6.5Z" fill="currentColor"/>'), check: svg('<circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.8 2.8L16 9.6"/>'),
  download: svg('<path d="M12 4v11m-4-4 4 4 4-4M5 20h14"/>')
};
let tipId = 0;
export function infoTip(text, label = '说明') { const id = 'fd-tip-' + (++tipId); return `<span class="fd-tip"><button type="button" class="fd-tip-button" aria-label="${esc(label)}" aria-describedby="${id}">${ICONS.info}</button><span id="${id}" role="tooltip" class="fd-tip-bubble">${esc(text)}</span></span>`; }

export function durationHtml(ms, { big = false } = {}) {
  const { hours, minutes } = durationParts(ms), u = text => `<span class="fd-u">${text}</span>`;
  return hours ? `${hours}${u(' 小时 ')}${minutes}${u(' 分')}` : `${minutes}${u(' 分钟')}`;
}
function deltaHtml(info, label, { pct = true } = {}) {
  if (info.dir === 'none') return `<span class="fd-delta" data-dir="none">${esc(label)} —</span>`;
  const text = info.dir === 'flat' ? '持平' : `${info.text}${pct && info.pctText ? `（${info.pctText}）` : ''}`;
  return `<span class="fd-delta" data-dir="${info.dir}">${esc(label)} ${ICONS[info.dir]}<span>${esc(text)}</span></span>`;
}

export function ringHtml(percent) {
  const r = 70, c = 2 * Math.PI * r, shown = Math.min(100, Math.max(0, percent));
  const arc = shown ? `<circle class="fd-ring-arc" cx="88" cy="88" r="${r}" fill="none" stroke-width="20" stroke-linecap="round" stroke-dasharray="${(c * shown / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 88 88)"/>` : '';
  return `<div class="fd-ring" role="img" aria-label="目标完成 ${percent}%"><svg viewBox="0 0 176 176" aria-hidden="true"><circle class="fd-ring-track" cx="88" cy="88" r="${r}" fill="none" stroke-width="20"/>${arc}</svg><div class="fd-ring-center"><b>${percent}<small>%</small></b><span>${esc(percent >= 100 ? '已达成目标' : '每日目标 4 小时')}</span></div></div>`;
}

export function heroHtml(view) {
  const { preset, range, elapsedMs, prevMs, empty, loading } = view, name = PRESET_NAMES[preset], goal = goalMinutes(range), mins = Math.floor(elapsedMs / 60000), pct = percentOf(mins, goal);
  const delta = deltaInfo(Math.floor(elapsedMs / 60000), prevMs === null ? null : Math.floor(prevMs / 60000), { unit: '分钟', minutes: true });
  const remaining = Math.max(0, goal - mins);
  const goalText = preset === 'today' ? '还差 ' + durationLabel(remaining * 60000) + '达成目标' : '目标 ' + durationLabel(goal * 60000);
  const sub = empty || loading ? '' : `<div class="fd-sub">${prevMs === null ? '' : `${preset === 'today' ? '昨天' : '对比期'} ${durationLabel(prevMs)} · `}${remaining > 0 ? esc(goalText) : '已达成目标'}</div>`;
  const start = view.canStart ? `<div class="fd-act"><button type="button" class="ui-button ui-button-primary fd-start" data-focus-statistics="start">${ICONS.play}开始专注</button><span class="fd-goal-note">每日目标 ${DAILY_GOAL_MINUTES / 60} 小时（默认）</span></div>` : '';
  const body = empty ? `<div class="fd-label">${name}专注</div><div class="fd-big" data-empty="true">0<span class="fd-u"> 分钟</span></div><p class="fd-guide">${preset === 'today' ? '今天' : '这个范围内'}还没有专注记录。开始一轮专注，时长、热力图和排行会自动出现在这里。</p>${start}`
    : `<div class="fd-label">${name}专注${infoTip('统计工作阶段的运行时间，含睡眠和退出期间经过的时间；休息不计入。', '专注时长说明')}</div><div class="fd-big" aria-live="off">${loading ? '—' : durationHtml(elapsedMs)}</div>${loading ? '' : `<div class="fd-cmp">${deltaHtml(delta, COMPARE_LABELS[preset])}</div>`}${sub}${elapsedMs === 0 && !loading ? `<p class="fd-guide">${preset === 'today' ? '今天' : '这个范围内'}还没有专注记录。</p>` : ''}${start}`;
  return `<section class="fd-hero fd-card" aria-label="${name}专注概览" ${empty ? 'data-state="empty"' : ''}>${ringHtml(empty || loading ? 0 : pct)}<div class="fd-ht">${body}</div></section>`;
}

export function sparkHtml(values, label) {
  const points = sparkPoints(values);
  if (!points) return `<svg class="fd-spark" viewBox="0 0 84 32" role="img" aria-label="${esc(label)}：近 7 天无数据"><line x1="3" y1="16" x2="81" y2="16" stroke-dasharray="2 4"/></svg>`;
  const last = points.at(-1);
  return `<svg class="fd-spark" viewBox="0 0 84 32" role="img" aria-label="${esc(label)}：近 7 天 ${values.join('、')}"><polyline fill="none" points="${points.map(p => p.join(',')).join(' ')}"/><circle cx="${last[0]}" cy="${last[1]}" r="2.6"/></svg>`;
}
export function metricsHtml(cards, { empty, compareLabel }) {
  return `<div class="fd-metrics">${cards.map(card => {
    const delta = empty ? `<span class="fd-delta" data-dir="none">${esc(compareLabel)} —</span>` : deltaHtml(card.delta, compareLabel, { pct: false });
    return `<section class="fd-metric fd-card" aria-label="${esc(card.label)}"><h3>${esc(card.label)}${infoTip(card.tip, card.label + '说明')}</h3><p class="fd-mv">${esc(card.value)}<span class="fd-u"> ${esc(card.unit)}</span></p><div class="fd-mr">${delta}${sparkHtml(card.spark, card.label)}</div></section>`;
  }).join('')}</div>`;
}

const dayLabel = day => { const [, m, d] = day.split('-').map(Number); return `${m}月${d}日 ${WEEKDAYS[weekdayIndex(day)]}`; };
export function heatmapHtml(grid, { today, empty, truncated }) {
  const header = `<div class="fd-hr fd-hd" aria-hidden="true"><span></span>${Array.from({ length: 24 }, (_, h) => `<span class="fd-hh">${h % 6 === 0 ? String(h).padStart(2, '0') : ''}</span>`).join('')}<span></span></div>`;
  const rows = grid.map((row, r) => {
    const isToday = row.day === today, name = isToday ? '今天' : dayLabel(row.day).replace(/^(\d+月\d+日) (.+)$/, '$2 $1');
    const cells = row.minutes.map((m, h) => {
      const level = heatLevel(m), range = `${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00`, text = m ? `${dayLabel(row.day)} ${range}，专注 ${m} 分钟` : `${dayLabel(row.day)} ${range}，无专注`;
      return `<div role="gridcell" class="fd-cell" data-level="${level}" data-r="${r}" data-h="${h}" tabindex="${r === grid.length - 1 && h === 0 ? 0 : -1}" title="${esc(text)}" aria-label="${esc(text)}"></div>`;
    }).join('');
    return `<div role="row" class="fd-hr${isToday ? ' fd-today' : ''}"><span role="rowheader" class="fd-rl">${esc(name)}</span>${cells}<span class="fd-rt">${row.total ? esc(durationLabel(row.total)) : '—'}</span></div>`;
  }).join('');
  const legend = `<div class="fd-legend"><span class="fd-legend-title">每格 1 小时</span><span class="fd-sw" data-level="0"></span>无${HEAT_LEGEND.map(l => `<span class="fd-sw" data-level="${l.level}"></span>${l.label}`).join('')}</div>`;
  return `<section class="fd-heat fd-card" aria-label="近 7 天分时分布"><div class="fd-ch"><h2>近 7 天分时分布${infoTip('按统计时区把每段工作计时拆到小时格；颜色越深，该小时专注越久。不随上方范围变化。', '分时分布说明')}</h2><span class="fd-hint">${empty ? '' : '深浅 = 该小时专注分钟数'}</span></div><div role="grid" aria-label="近 7 天每小时专注分钟数，方向键移动" class="fd-hm">${header}${rows}</div><div class="fd-hf">${empty ? '<span>专注后，最常专注的时段会在这里显示。</span>' : legend}${truncated ? '<span>明细仅含最近的部分会话</span>' : ''}</div></section>`;
}

export function rankingHtml({ title, tip, ranking, emptyText, unitName, limited }) {
  const rows = ranking.rows.map(row => `<li class="fd-rk-row"><span class="fd-rk-i">${row.index}</span><span class="fd-rk-name" title="${esc(row.name)}">${esc(row.name)}${row.sub ? `<span class="fd-rk-sub">${esc(row.sub)}</span>` : ''}</span><span class="fd-rk-v">${esc(durationLabel(row.ms))}</span><span class="fd-rk-p">${row.pct}%</span><span class="fd-bar" aria-hidden="true"><i data-w="${row.width}"></i></span></li>`).join('');
  return `<section class="fd-rank fd-card" aria-label="${esc(title)}"><div class="fd-ch"><h2>${esc(title)}${infoTip(tip, title + '说明')}</h2><span class="fd-hint">按专注时长</span></div>${ranking.rows.length ? `<ol class="fd-rk">${rows}</ol><div class="fd-foot">${ranking.total > ranking.shown ? `显示前 ${ranking.shown} 项，共 ${ranking.total} ${unitName}` : `共 ${ranking.total} ${unitName}`}${limited ? '（任务明细基于最近的部分会话）' : ''}</div>` : `<p class="fd-none">${esc(emptyText)}</p>`}</section>`;
}
