// 专注统计 B 版（仪表盘）的纯函数：范围预设、对比期、按小时/按日分桶、等级、排行、迷你图、对比度。
// 无 DOM、无网络，便于单测（test/focus-stats-model.test.mjs）。
import { addCivilDays } from '../../core/date.js';

export const DAILY_GOAL_MINUTES = 240; // 前端没有“每日目标”数据（设置里只有单轮时长），先用默认 4 小时；见 PR 残留问题。
export const PRESETS = [{ value: 'today', label: '今日' }, { value: 'week', label: '本周' }, { value: 'month', label: '本月' }, { value: 'year', label: '全年' }];
export const PRESET_NAMES = { today: '今日', week: '本周', month: '本月', year: '全年', custom: '所选范围' };
export const COMPARE_LABELS = { today: '较昨天', week: '较上周同期', month: '较上月同期', year: '较去年同期', custom: '较上一周期' };

// 浅色令牌（与 stats.css 里的变量一一对应；test 会解析 CSS 校验一致并计算 WCAG 对比度）。
export const STATS_COLORS = {
  light: { bg: '#ffffff', card: '#f5f5f7', text: '#1d1d1f', textSecondary: '#636366', accent: '#0071e3', accentText: '#0066cc', heatEmpty: '#e5e5ea', heat1: '#6f89ae', heat2: '#526c91', heat3: '#3e516d', heat4: '#273446', bar: '#6e6e73', barTrack: '#ffffff', spark: '#6e6e73' },
  dark: { bg: '#1c1c1e', card: '#2c2c2e', text: '#f5f5f7', textSecondary: '#a1a1a6', accent: '#0a84ff', accentText: '#64d2ff', heatEmpty: '#3a3a3c', heat1: '#5b78a2', heat2: '#7e96b6', heat3: '#a6b6cd', heat4: '#d0d9e5', bar: '#98989d', barTrack: '#1c1c1e', spark: '#98989d' }
};

const parse = day => day.split('-').map(Number);
const pad = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const weekdayIndex = day => { const [y, m, d] = parse(day); return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; }; // 周一=0
export const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export const dayCount = (from, to) => Math.round((Date.UTC(...parse(to).map((v, i) => i === 1 ? v - 1 : v)) - Date.UTC(...parse(from).map((v, i) => i === 1 ? v - 1 : v))) / 864e5) + 1;

export function rangeForPreset(preset, today) {
  const [y, m] = parse(today);
  if (preset === 'week') return { from: addCivilDays(today, -weekdayIndex(today)), to: today };
  if (preset === 'month') return { from: ymd(y, m, 1), to: today };
  if (preset === 'year') return { from: ymd(y, 1, 1), to: today };
  return { from: today, to: today };
}
export function detectPreset(from, to, today) {
  for (const { value } of PRESETS) { const r = rangeForPreset(value, today); if (r.from === from && r.to === to) return value; }
  return 'custom';
}
// 对比期：今日→昨天；本周→上周同期（同样的天数）；本月→上月同期；全年→去年同期；自定义→紧邻的等长区间。
export function previousRange(preset, from, to) {
  if (preset === 'today') return { from: addCivilDays(from, -1), to: addCivilDays(from, -1) };
  if (preset === 'week') return { from: addCivilDays(from, -7), to: addCivilDays(to, -7) };
  if (preset === 'month') { const [y, m] = parse(from), [, , d] = parse(to), py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1; return { from: ymd(py, pm, 1), to: ymd(py, pm, Math.min(d, daysInMonth(py, pm))) }; }
  if (preset === 'year') { const [y] = parse(from), [, tm, td] = parse(to); return { from: ymd(y - 1, 1, 1), to: ymd(y - 1, tm, Math.min(td, daysInMonth(y - 1, tm))) }; }
  const length = dayCount(from, to); return { from: addCivilDays(from, -length), to: addCivilDays(from, -1) };
}
export const lastDays = (today, n = 7) => Array.from({ length: n }, (_, i) => addCivilDays(today, i - n + 1));

// —— 时间格式 ——
export const minutesOf = ms => Math.floor(Math.max(0, ms || 0) / 60000);
export function durationParts(ms) { const total = minutesOf(ms); return { hours: Math.floor(total / 60), minutes: total % 60, total }; }
export function durationLabel(ms) { const { hours, minutes } = durationParts(ms); return hours ? (minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`) : `${minutes} 分钟`; }
export function goalMinutes(range) { return DAILY_GOAL_MINUTES * dayCount(range.from, range.to); }
export const percentOf = (value, whole) => whole > 0 ? Math.round(value / whole * 100) : 0;

// 较上一期：中性色 + 箭头 + 文字（不用红绿）。minutes 为单位时 diff 以分钟计。
export function deltaInfo(current, previous, { unit = '', minutes = false } = {}) {
  if (previous === null || previous === undefined || Number.isNaN(previous)) return { dir: 'none', text: '—', pct: null };
  const diff = current - previous, amount = Math.abs(minutes ? Math.round(diff) : diff);
  const dir = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
  const pct = previous > 0 ? Math.round(diff / previous * 100) : null;
  const text = dir === 'flat' ? '持平' : `${amount} ${unit}`.trim();
  return { dir, diff, amount, pct, text, pctText: pct === null || dir === 'flat' ? '' : `${pct > 0 ? '+' : ''}${pct}%` };
}

// —— 时区内的按小时/按日分桶 ——
const formatters = new Map();
function zoned(time, timeZone) {
  let f = formatters.get(timeZone);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); formatters.set(timeZone, f); }
  const p = {}; for (const part of f.formatToParts(time)) p[part.type] = part.value;
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second) };
}
export const zonedDay = (time, timeZone) => zoned(time, timeZone).day;

/**
 * 把工作会话的运行区间按（日期 × 小时）、按任务、按日汇总。
 * 返回 { hours: Map<day, number[24] 毫秒>, tasks: Map<key,{taskId,title,project,byDay:Map}>, longest: Map<day,ms>, rounds: Map<day,n>, stopped: Map<day,n> }
 */
export function bucketSessions(sessions, { timeZone, now }) {
  const hours = new Map(), tasks = new Map(), longest = new Map(), rounds = new Map(), stopped = new Map();
  const add = (map, key, value) => map.set(key, (map.get(key) || 0) + value);
  for (const session of sessions) {
    if (session.phase && session.phase !== 'work') continue;
    const key = session.taskId || 'none:' + (session.taskTitleSnapshot || ''), task = tasks.get(key) || { taskId: session.taskId || null, title: session.taskTitleSnapshot || '未命名任务', project: session.projectNameSnapshot || '未归类', byDay: new Map() };
    tasks.set(key, task);
    let total = 0, startDay = null;
    for (const segment of session.segments || []) {
      const end = segment.endAt ?? Math.min(now, session.deadlineAt ?? now);
      for (let t = segment.startAt; t < end;) {
        const z = zoned(t, timeZone), boundary = t + 3600000 - ((z.minute * 60 + z.second) * 1000 + (((t % 1000) + 1000) % 1000)), upTo = Math.min(end, Math.max(boundary, t + 1)), amount = upTo - t;
        let row = hours.get(z.day); if (!row) { row = new Array(24).fill(0); hours.set(z.day, row); }
        row[z.hour] += amount; add(task.byDay, z.day, amount); total += amount; startDay ??= z.day; t = upTo;
      }
    }
    if (total > 0) { const day = startDay; longest.set(day, Math.max(longest.get(day) || 0, total)); }
    if (session.status === 'ended' && session.endedAt) { const day = zonedDay(session.endedAt, timeZone); if (session.endReason === 'completed') add(rounds, day, 1); else if (session.endReason === 'stopped') add(stopped, day, 1); }
  }
  return { hours, tasks, longest, rounds, stopped };
}
export const sumDays = (map, from, to) => { let sum = 0; for (const [day, value] of map) if (day >= from && day <= to) sum += value; return sum; };
export const maxDays = (map, from, to) => { let max = 0; for (const [day, value] of map) if (day >= from && day <= to) max = Math.max(max, value); return max; };

// 热力图 4 级（分钟/小时格）：1–14、15–29、30–44、≥45；0 为空。
export function heatLevel(minutes) { return minutes <= 0 ? 0 : minutes < 15 ? 1 : minutes < 30 ? 2 : minutes < 45 ? 3 : 4; }
export const HEAT_LEGEND = [{ level: 1, label: '1–14 分钟' }, { level: 2, label: '15–29 分钟' }, { level: 3, label: '30–44 分钟' }, { level: 4, label: '45 分钟以上' }];
export function heatGrid(hours, days) {
  return days.map(day => { const row = hours.get(day) || new Array(24).fill(0); const minutes = row.map(minutesOf); return { day, minutes, total: row.reduce((a, b) => a + b, 0) }; });
}

// 排行：取前 limit 项，百分比 = 占范围合计。
export function rank(items, { limit = 4 } = {}) {
  const list = items.filter(item => item.ms > 0).sort((a, b) => b.ms - a.ms || String(a.name).localeCompare(String(b.name))), total = list.reduce((s, i) => s + i.ms, 0), max = list[0]?.ms || 0;
  return { rows: list.slice(0, limit).map((item, index) => ({ ...item, index: index + 1, pct: percentOf(item.ms, total), width: max ? Math.max(2, Math.round(item.ms / max * 100)) : 0 })), total: list.length, shown: Math.min(limit, list.length) };
}
export function taskRanking(tasks, range, options) { return rank([...tasks.values()].map(task => ({ name: task.title, sub: task.project, key: task.taskId, ms: sumDays(task.byDay, range.from, range.to) })), options); }
export function projectRanking(projects, options) { return rank((projects || []).map(project => ({ name: project.name || '未归类', sub: '', key: project.projectId, ms: project.workElapsedMs })), options); }

// 迷你图：values → polyline 的点（宽 w 高 h，留 3px 边距）；全 0 时返回 null（画虚线）。
export function sparkPoints(values, w = 84, h = 32) {
  const max = Math.max(...values, 0); if (!values.length || max <= 0) return null;
  return values.map((v, i) => [Math.round(3 + (values.length === 1 ? 0 : i * (w - 6) / (values.length - 1))), Math.round(h - 3 - (v / max) * (h - 6))]);
}

// —— WCAG 对比度 ——
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const channel = v => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const luminance = hex => { const [r, g, b] = rgb(hex).map(channel); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export function contrastRatio(a, b) { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }
