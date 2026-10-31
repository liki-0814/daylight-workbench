// 专注统计 A 版（原生简洁）各区块的 HTML 渲染（字符串；文本一律转义）。数据与口径见 stats-model.js。
import { escapeButtonText as esc } from '../components/button.js';
import { barChart } from './bar-chart.js';
import { PRESET_NAMES, COMPARE_LABELS, DAILY_GOAL_MINUTES, durationParts, durationLabel, deltaInfo, goalMinutes, percentOf, sparkPoints } from './stats-model.js';

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
  const r = 56, c = 2 * Math.PI * r, shown = Math.min(100, Math.max(0, percent));
  const arc = shown ? `<circle class="fd-ring-arc" cx="62" cy="62" r="${r}" fill="none" stroke-width="12" stroke-linecap="round" stroke-dasharray="${(c * shown / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 62 62)"/>` : '';
  return `<div class="fd-ring" role="img" aria-label="目标完成 ${percent}%"><svg viewBox="0 0 124 124" aria-hidden="true"><circle class="fd-ring-track" cx="62" cy="62" r="${r}" fill="none" stroke-width="12"/>${arc}</svg><div class="fd-ring-center"><b>${percent}<small>%</small></b><span>${esc(percent >= 100 ? '已达成' : '每日目标')}</span></div></div>`;
}

export function heroHtml(view) {
  const { preset, range, elapsedMs, prevMs, loading } = view, name = PRESET_NAMES[preset], goal = goalMinutes(range), mins = Math.floor(elapsedMs / 60000), pct = percentOf(mins, goal);
  const delta = deltaInfo(mins, prevMs === null ? null : Math.floor(prevMs / 60000), { unit: '分钟', minutes: true });
  const remaining = Math.max(0, goal - mins), goalText = '目标 ' + durationLabel(goal * 60000) + ' · ' + (remaining > 0 ? '还差 ' + durationLabel(remaining * 60000) : '已达成');
  const compare = loading ? '' : `<div class="fd-cmp">${deltaHtml(delta, COMPARE_LABELS[preset])}${prevMs === null ? '' : `<span class="fd-sub">${preset === 'today' ? '昨天' : '对比期'} ${esc(durationLabel(prevMs))}</span>`}</div><div class="fd-sub fd-goal">${esc(goalText)}</div>`;
  const start = view.canStart ? `<div class="fd-act"><button type="button" class="ui-button ui-button-primary fd-start" data-focus-statistics="start">${ICONS.play}开始专注</button></div>` : '';
  const guide = elapsedMs === 0 && !loading ? `<p class="fd-guide">${preset === 'today' ? '今天' : '这个范围内'}还没有专注记录。</p>` : '';
  return `<section class="fd-hero" aria-label="${name}专注概览">${ringHtml(loading ? 0 : pct)}<div class="fd-ht"><div class="fd-label">${name}专注${infoTip('统计工作阶段的运行时间，含睡眠和退出期间经过的时间；休息不计入。', '专注时长说明')}</div><div class="fd-big" aria-live="off">${loading ? '—' : durationHtml(elapsedMs)}</div>${compare}${guide}${start}</div></section>`;
}

export function sparkHtml(values, label) {
  const points = sparkPoints(values);
  if (!points) return `<svg class="fd-spark" viewBox="0 0 84 32" role="img" aria-label="${esc(label)}：近 7 天无数据"><line x1="3" y1="16" x2="81" y2="16" stroke-dasharray="2 4"/></svg>`;
  const last = points.at(-1);
  return `<svg class="fd-spark" viewBox="0 0 84 32" role="img" aria-label="${esc(label)}：近 7 天 ${values.join('、')}"><polyline fill="none" points="${points.map(p => p.join(',')).join(' ')}"/><circle cx="${last[0]}" cy="${last[1]}" r="2.6"/></svg>`;
}
export function metricsHtml(cards, { compareLabel }) {
  return `<div class="fd-metrics">${cards.map(card => {
    const delta = deltaHtml(card.delta, compareLabel, { pct: false });
    return `<section class="fd-metric" aria-label="${esc(card.label)}"><div class="fd-mt"><h3>${esc(card.label)}${infoTip(card.tip, card.label + '说明')}</h3><p class="fd-mv">${esc(card.value)}<span class="fd-u"> ${esc(card.unit)}</span></p>${delta}</div>${sparkHtml(card.spark, card.label)}</section>`;
  }).join('')}</div>`;
}

export function chartHtml(model, { truncated, initialIndex } = {}) {
  const legend = model.kind === 'hourly' ? '<span class="fd-legend"><span><i class="fd-sw" data-tone="day"></i>日间 <b>06–19</b></span><span><i class="fd-sw" data-tone="night"></i>夜间 <b>19–06</b></span></span>' : '';
  const tip = model.kind === 'hourly' ? '按统计时区把每段工作计时拆到小时，柱高为该小时的专注分钟数；色带深浅区分日间与夜间，蓝线是当前时刻。' : '每根柱是一天的专注时长，按统计时区的日期汇总；柱数较多时只标注部分日期。';
  const chart = barChart({ id: 'fd-chart', label: model.title, bars: model.bars, yMax: model.yMax, yTicks: model.yTicks, xTicks: model.xTicks, band: model.band, marker: model.marker, showValues: model.showValues, initialIndex: initialIndex ?? Math.max(0, model.peakIndex) });
  return `<section class="fd-chart" aria-label="${esc(model.title)}"><div class="fd-ch"><h2>${esc(model.title)}${infoTip(tip, model.title + '说明')}</h2><span class="fd-hint">${esc(model.peakText)}</span></div>${chart}<div class="fd-cf"><span>${model.kind === 'hourly' ? '' : '范围内'}共专注 ${esc(durationLabel(model.totalMinutes * 60000))}${truncated ? ' · 明细仅含最近的部分会话' : ''}</span>${legend}</div></section>`;
}

export function emptyHtml({ preset, canStart }) {
  const where = preset === 'today' ? '今天' : '这个范围内';
  return `<section class="fd-empty" aria-label="暂无专注记录"><svg class="fd-empty-ic" viewBox="0 0 56 56" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="28" cy="28" r="21" class="fd-empty-ring"/><path d="M28 7a21 21 0 0 1 12 3.9"/><path d="M24 20.5v15l12-7.5Z"/></svg><h2>${where}还没有专注记录</h2><p>开始一轮专注，专注时长、分时分布和项目排行会自动出现在这里。<br>每日目标默认 ${DAILY_GOAL_MINUTES / 60} 小时。</p>${canStart ? `<button type="button" class="ui-button ui-button-primary fd-start" data-focus-statistics="start">${ICONS.play}开始专注</button>` : ''}</section>`;
}

export function rankingHtml({ title, tip, ranking, emptyText, unitName, limited }) {
  const rows = ranking.rows.map(row => `<li class="fd-rk-row"><span class="fd-rk-i">${row.index}</span><span class="fd-rk-name" title="${esc(row.name)}">${esc(row.name)}${row.sub ? `<span class="fd-rk-sub">${esc(row.sub)}</span>` : ''}</span><span class="fd-rk-v">${esc(durationLabel(row.ms))}</span><span class="fd-rk-p">${row.pct}%</span><span class="fd-bar" aria-hidden="true"><i data-w="${row.width}"></i></span></li>`).join('');
  return `<section class="fd-rank" aria-label="${esc(title)}"><div class="fd-ch"><h2>${esc(title)}${infoTip(tip, title + '说明')}</h2><span class="fd-hint">按专注时长</span></div>${ranking.rows.length ? `<ol class="fd-rk">${rows}</ol><div class="fd-foot">${ranking.total > ranking.shown ? `显示前 ${ranking.shown} 项，共 ${ranking.total} ${unitName}` : `共 ${ranking.total} ${unitName}`}${limited ? '（任务明细基于最近的部分会话）' : ''}</div>` : `<p class="fd-none">${esc(emptyText)}</p>`}</section>`;
}
