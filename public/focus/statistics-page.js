import { isCivilDate, addCivilDays, validateDateRange } from '../../core/date.js';
import { focusRoute } from '../routes.js';
import { escapeButtonText as esc } from '../components/button.js';
import { updateSelectField } from '../components/select.js';
import { segmentedControl, mountSegmentedControl } from '../components/segmented-control.js';
import { dateField } from '../components/date-field.js';
import { pagination, mountPagination } from '../components/pagination.js';
import { statisticsToday, durationText, endReasonText, timeQualityText, sessionElapsed } from './presentation.js';
import { createReportRefresh } from './report-refresh.js';
import { PRESETS, COMPARE_LABELS, rangeForPreset, detectPreset, previousRange, lastDays, dayCount, minutesOf, deltaInfo, bucketSessions, sumDays, maxDays, chartModel, clockIn, taskRanking, projectRanking } from './stats-model.js';
import { mountBarChart } from './bar-chart.js';
import { ICONS, heroHtml, metricsHtml, chartHtml, emptyHtml, rankingHtml } from './stats-view.js';

const MAX_PAGES = 5; // 分时/任务明细由会话分页汇总，最多取 5×100 条
const EMPTY_FILTERS = { projectId: null, taskId: null, unassigned: false };

export function createStatisticsPage({ client, controller, getTaskSnapshot, onRoute, openTask, notify, onStartFocus }) {
  const element = document.createElement('main'); element.id = 'focus-statistics-page'; element.className = 'focus-statistics-page focus-dash';
  const abort = new AbortController();
  let visible = false, requestAbort, generation = 0, data = null, records, cursor, pageNumber = 1, paginationDispose, disposeSegments, disposeChart, filters = { ...EMPTY_FILTERS }, phase = 'work', loading = false, failure = '';
  const today = statisticsToday(controller.getSnapshot()); let range = { preset: 'today', today, from: today, to: today };
  element.innerHTML = `<header class="topbar fd-toolbar"><div class="fd-title"><h1>专注统计</h1><span class="fd-date" data-fd-date></span></div>
    <div class="fd-tools"><span class="fd-updated" data-statistics-status role="status" aria-live="polite"></span><div data-fd-range></div>
      <div class="fd-pop-wrap"><button type="button" class="fd-btn" data-fd-filter-toggle aria-haspopup="dialog" aria-expanded="false" aria-controls="fd-filter-panel">${ICONS.filter}筛选<span class="fd-filter-count" data-fd-filter-count></span></button>
        <div class="fd-pop fd-filter-panel" id="fd-filter-panel" role="dialog" aria-label="筛选" hidden><div class="fd-fields"><h2>时间范围</h2><div class="fd-dates">${dateField({ name: 'fd-from', label: '开始日期', value: range.from, required: true, compact: true })}${dateField({ name: 'fd-to', label: '结束日期', value: range.to, required: true, compact: true })}</div><h2>项目与任务</h2><div data-fd-selects></div></div>
          <p class="fd-filter-status" role="status" data-fd-filter-status></p><div class="fd-filter-foot"><button type="button" class="fd-btn" data-focus-statistics="reset-filters">重置</button><button type="button" class="ui-button ui-button-primary" data-focus-statistics="close-filter">完成</button></div></div></div>
      <div class="fd-pop-wrap"><button type="button" class="fd-btn fd-icon-only" data-fd-menu-toggle aria-label="更多操作" aria-haspopup="menu" aria-expanded="false" aria-controls="fd-more-menu">${ICONS.more}</button>
        <div class="fd-pop fd-menu" id="fd-more-menu" role="menu" aria-label="更多操作" hidden><button type="button" role="menuitem" data-focus-statistics="export">${ICONS.download}导出专注 JSON</button></div></div></div></header>
    <div class="fd-body" data-fd-body><p class="fd-note" data-statistics-timezone></p><div data-fd-dash></div>
      <details class="fd-records" data-fd-records><summary>会话记录与项目快照</summary><div data-statistics-phase></div><div data-statistics-sessions></div><div data-statistics-pagination></div></details></div>`;
  const $ = selector => element.querySelector(selector), filterToggle = $('[data-fd-filter-toggle]'), filterPanel = $('#fd-filter-panel'), menuToggle = $('[data-fd-menu-toggle]'), menu = $('#fd-more-menu');

  const dayNow = () => statisticsToday(controller.getSnapshot());
  function query(extra = {}) { return { from: range.from, to: range.to, ...(filters.projectId ? { projectId: filters.projectId } : filters.unassigned ? { unassigned: '1' } : {}), ...(filters.taskId ? { taskId: filters.taskId } : {}), ...extra }; }
  const filterCount = () => (filters.projectId || filters.unassigned ? 1 : 0) + (filters.taskId ? 1 : 0) + (range.preset === 'custom' ? 1 : 0);
  function changed() { cursor = null; pageNumber = 1; onRoute(focusRoute(query()), { replace: true }); renderChrome(); void refresh(); }
  function setRange(next) { range = { ...next, today: dayNow() }; changed(); }

  // —— 工具栏 ——
  function renderChrome() {
    disposeSegments?.(); const host = $('[data-fd-range]'), hadFocus = host.contains(document.activeElement);
    host.innerHTML = segmentedControl({ id: 'focus-range', label: '统计范围', value: range.preset, options: PRESETS });
    const group = host.querySelector('.ui-segmented'); if (!group.querySelector('[tabindex="0"]')) group.querySelector('button').tabIndex = 0;
    disposeSegments = mountSegmentedControl(group, { onChange(preset) { setRange({ preset, ...rangeForPreset(preset, dayNow()) }); } });
    if (hadFocus) (group.querySelector('[aria-checked="true"]') || group.querySelector('[tabindex="0"]')).focus({ preventScroll: true });
    const count = filterCount(); $('[data-fd-filter-count]').textContent = count ? ' · ' + count : ''; filterToggle.setAttribute('aria-label', count ? `筛选，已设置 ${count} 项` : '筛选');
    $('[name=fd-from]').value = range.from; $('[name=fd-to]').value = range.to;
    $('[data-fd-date]').textContent = range.from === range.to ? range.from : `${range.from} – ${range.to}`;
    renderFilters();
  }
  function renderFilters() {
    const { state } = getTaskSnapshot(), projects = new Map(state.projects.map(project => [project.id, project.name]));
    for (const project of data?.report.projects || []) if (project.projectId && !projects.has(project.projectId)) projects.set(project.projectId, project.name + '（已删除）');
    const tasks = state.tasks.map(task => ({ value: task.id, label: task.title })); if (filters.taskId && !tasks.some(task => task.value === filters.taskId)) tasks.push({ value: filters.taskId, label: '已删除任务 · ' + filters.taskId });
    const container = $('[data-fd-selects]');
    updateSelectField(container, { name: 'focus-project-filter', label: '项目', value: filters.projectId ? 'project:' + filters.projectId : filters.unassigned ? 'unassigned' : '', compact: true, options: [{ value: '', label: '所有项目' }, { value: 'unassigned', label: '未归类' }, ...[...projects].map(([id, name]) => ({ value: 'project:' + id, label: name }))] });
    updateSelectField(container, { name: 'focus-task-filter', label: '任务', value: filters.taskId || '', compact: true, options: [{ value: '', label: '所有任务' }, ...tasks] });
    updateSelectField($('[data-statistics-phase]'), { name: 'focus-phase-filter', label: '会话阶段', value: phase, compact: true, options: [{ value: 'work', label: '工作记录' }, { value: 'shortBreak', label: '短休息记录（不计入工作指标）' }] });
  }
  function setPopover(button, panel, open, { focus = true } = {}) {
    panel.hidden = !open; button.setAttribute('aria-expanded', String(open));
    if (open) { for (const [b, p] of [[filterToggle, filterPanel], [menuToggle, menu]]) if (p !== panel && !p.hidden) { p.hidden = true; b.setAttribute('aria-expanded', 'false'); } if (focus) (panel.querySelector('input,button,[role=menuitem]') || panel).focus({ preventScroll: true }); }
    else if (focus) button.focus({ preventScroll: true });
  }
  const closePopovers = (options) => { if (!filterPanel.hidden) setPopover(filterToggle, filterPanel, false, options); if (!menu.hidden) setPopover(menuToggle, menu, false, options); };

  // —— 数据 ——
  async function sessionPages(params, signal) {
    const sessions = []; let next = null, truncated = false, timeZone, serverNow;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await client.sessions({ ...params, phase: 'work', limit: 100, ...(next ? { cursor: next } : {}) }, { signal }); timeZone = result.timeZone; serverNow = result.serverNow; sessions.push(...result.sessions);
      next = result.nextCursor; if (!next) break; if (page === MAX_PAGES - 1) truncated = true;
    }
    return { sessions, truncated, timeZone, serverNow };
  }
  async function load(signal) {
    const preset = range.preset, prev = previousRange(preset, range.from, range.to), week = lastDays(range.today, 7), base = query();
    const prevQuery = { ...base, from: prev.from, to: prev.to }, union = { from: prev.from < range.from ? prev.from : range.from, to: range.to };
    const unionOk = dayCount(union.from, union.to) <= 366, covers7 = (unionOk ? union.from : range.from) <= week[0] && range.to >= week[6];
    const heatParams = { ...base, from: week[0], to: week[6] };
    const [report, prevReport, main, extra] = await Promise.all([
      client.statistics(base, { signal }), client.statistics(prevQuery, { signal }).catch(error => { if (error.name === 'AbortError') throw error; return null; }),
      sessionPages({ ...base, ...(unionOk ? union : {}) }, signal), covers7 ? null : sessionPages(heatParams, signal)]);
    if (prevReport && prevReport.version !== report.version) throw Object.assign(new Error('数据在读取期间发生变化'), { code: 'VERSION_RACE' });
    const timeZone = report.timeZone, now = main.serverNow ?? report.serverNow ?? Date.now();
    return { report, prevReport, prev, week, now, timeZone, heat: bucketSessions((extra || main).sessions, { timeZone, now }), main: bucketSessions(main.sessions, { timeZone, now }), truncated: main.truncated || Boolean(extra?.truncated), unionOk, range: { ...range }, filters: { ...filters } };
  }

  // —— 渲染 ——
  const metricDelta = (current, previous, unit) => deltaInfo(current, previous, { unit });
  function buildMetrics() {
    const { report, prevReport, heat, main, week } = data, s = report.summary, p = prevReport?.summary, r = range;
    const sessions = s.completedRounds + s.stoppedSessions + s.interruptedSessions, avg = sessions ? minutesOf(s.workElapsedMs / sessions) : 0;
    const prevSessions = p ? p.completedRounds + p.stoppedSessions + p.interruptedSessions : 0, prevAvg = p ? (prevSessions ? minutesOf(p.workElapsedMs / prevSessions) : 0) : null;
    const longest = minutesOf(maxDays(main.longest, r.from, r.to)), prevLongest = data.unionOk && p ? minutesOf(maxDays(main.longest, data.prev.from, data.prev.to)) : null;
    const stopped = s.stoppedSessions + s.interruptedSessions, prevStopped = p ? p.stoppedSessions + p.interruptedSessions : null;
    const series = fn => week.map(fn), rounds = day => heat.rounds.get(day) || 0, early = day => (heat.stopped.get(day) || 0);
    const dayMs = day => (heat.hours.get(day) || []).reduce((a, b) => a + b, 0);
    return [
      { label: '完整轮数', value: s.completedRounds, unit: '轮', delta: metricDelta(s.completedRounds, p?.completedRounds ?? null, '轮'), spark: series(rounds), tip: '按结束日计数，完整完成一轮工作计时才算。' },
      { label: '平均单轮', value: avg, unit: '分钟', delta: metricDelta(avg, prevAvg, '分钟'), spark: series(day => { const n = rounds(day) + early(day); return n ? minutesOf(dayMs(day) / n) : 0; }), tip: '专注计时 ÷ 工作会话数（含提前结束），不含休息。' },
      { label: '最长连续', value: longest, unit: '分钟', delta: metricDelta(longest, prevLongest, '分钟'), spark: series(day => minutesOf(heat.longest.get(day) || 0)), tip: '单次工作会话的最长运行时间，按开始日归属；仅统计最近的部分会话。' },
      { label: '提前结束', value: stopped, unit: '次', delta: metricDelta(stopped, prevStopped, '次'), spark: series(early), tip: '任务被完成、删除或手动中断，未满一轮的计时记为提前结束。' }];
  }
  function renderDash() {
    const host = $('[data-fd-dash]'), focused = host.contains(document.activeElement) ? document.activeElement : null, restore = focused?.closest('.bc-col')?.dataset.bcIndex;
    host.setAttribute('aria-busy', String(loading)); disposeChart?.(); disposeChart = null;
    const extras = [$('[data-statistics-timezone]'), $('[data-fd-records]')];
    if (!data) {
      for (const node of extras) node.hidden = false;
      host.innerHTML = `<div class="fd-top">${heroHtml({ preset: range.preset, range, elapsedMs: 0, prevMs: null, loading: true, canStart: false })}${metricsHtml(['完整轮数', '平均单轮', '最长连续', '提前结束'].map(label => ({ label, value: '—', unit: '', delta: { dir: 'none' }, spark: [], tip: '读取中' })), { compareLabel: COMPARE_LABELS[range.preset] })}</div>`;
      $('[data-statistics-timezone]').textContent = ''; return;
    }
    const { report, prevReport, main, timeZone, now } = data, s = report.summary, tz = report.timeZone;
    const chart = chartModel({ range, hours: main.hours, clock: clockIn(now, timeZone), preset: range.preset });
    const projectRank = projectRanking(report.projects, { limit: 4 }), taskRank = taskRanking(main.tasks, range, { limit: 4 });
    const empty = s.workElapsedMs === 0 && s.completedRounds + s.stoppedSessions + s.interruptedSessions === 0 && chart.totalMinutes === 0 && !projectRank.rows.length;
    for (const node of extras) node.hidden = empty;
    if (empty) { host.innerHTML = emptyHtml({ preset: range.preset, canStart: Boolean(onStartFocus) }); renderFilters(); return; }
    const canStart = Boolean(onStartFocus) && range.preset === 'today' && s.workElapsedMs === 0;
    const hero = heroHtml({ preset: range.preset, range, elapsedMs: s.workElapsedMs, prevMs: prevReport ? prevReport.summary.workElapsedMs : null, loading: false, canStart });
    host.innerHTML = `<div class="fd-top">${hero}${metricsHtml(buildMetrics(), { compareLabel: COMPARE_LABELS[range.preset] })}</div>${chartHtml(chart, { truncated: data.truncated, initialIndex: restore === undefined ? undefined : Number(restore) })}<div class="fd-two">${rankingHtml({ title: '项目排行', tip: '按所选范围内各项目的专注计时排序，显示前 4 项。', ranking: projectRank, emptyText: '专注后，项目的时长排行会在这里显示。', unitName: '个项目' })}${rankingHtml({ title: '任务排行', tip: '按所选范围内各任务的专注计时排序，显示前 4 项；来自最近的部分会话明细。', ranking: taskRank, emptyText: '专注后，任务的时长排行会在这里显示。', unitName: '个任务', limited: data.truncated })}</div>`;
    const warning = controller.getSnapshot().runtime?.largeHistory ? ' 专注记录较大，查询可能需要更长时间。' : '';
    $('[data-statistics-timezone]').textContent = `统计今天：${statisticsToday(controller.getSnapshot())} · ${tz}；轮次按结束日计数，跨日时长分别分配；每日目标暂用默认 4 小时。${warning}`;
    for (const bar of host.querySelectorAll('[data-w]')) bar.style.width = bar.dataset.w + '%'; // CSP 禁止内联 style 属性，宽度走 CSSOM
    disposeChart = mountBarChart(host.querySelector('.bc'));
    if (restore !== undefined) host.querySelector(`.bc-col[data-bc-index="${restore}"]`)?.focus({ preventScroll: true });
    renderFilters();
  }
  function renderStatus() {
    const status = $('[data-statistics-status]'), panelStatus = $('[data-fd-filter-status]');
    status.dataset.error = String(Boolean(failure));
    if (failure) { status.innerHTML = `${esc((data ? '尚未更新：' : '读取失败：') + failure)} <button type="button" class="fd-retry" data-focus-statistics="retry">重试</button>`; }
    else status.textContent = loading ? (data ? '正在更新…' : '正在读取统计…') : '';
    panelStatus.dataset.error = String(Boolean(failure)); panelStatus.textContent = failure ? '更新失败：' + failure : loading ? '正在更新…' : '';
    filterPanel.setAttribute('aria-busy', String(loading)); $('[data-fd-body]').setAttribute('aria-busy', String(loading));
  }
  function renderSessions() {
    if (!records) return;
    const tasks = getTaskSnapshot().state.tasks;
    $('[data-statistics-sessions]').innerHTML = `<div class="focus-record-scroll"><table class="focus-record-table"><thead><tr><th scope="col">开始时间</th><th scope="col">任务 / 项目快照</th><th scope="col">计时</th><th scope="col">结果</th></tr></thead><tbody>${records.sessions.map(session => `<tr><td>${esc(new Date(session.startedAt).toLocaleString('zh-CN', { timeZone: records.timeZone }))}</td><td>${session.taskId && tasks.some(task => task.id === session.taskId) ? `<button class="text-button" data-focus-statistics-task="${esc(session.taskId)}">${esc(session.taskTitleSnapshot)}</button>` : esc(session.taskTitleSnapshot || '短休息')}${session.taskId && !tasks.some(task => task.id === session.taskId) ? '<small>任务已删除</small>' : ''}<small>${esc(session.projectNameSnapshot || '未归类')}</small></td><td>${durationText(sessionElapsed(session, records.serverNow))}</td><td>${session.status === 'ended' ? esc(endReasonText(session.endReason)) : session.status === 'paused' ? '已暂停' : '进行中'}${timeQualityText(session.timeQuality) ? `<small>${esc(timeQualityText(session.timeQuality))}</small>` : ''}</td></tr>`).join('') || '<tr><td colspan="4">当前筛选下没有会话记录。</td></tr>'}</tbody></table></div>`;
    paginationDispose?.(); $('[data-statistics-pagination]').innerHTML = pagination({ ...records, label: `第 ${pageNumber} 页 · ${records.total} 条` });
    paginationDispose = mountPagination($('.ui-pagination'), { onChange(direction) { cursor = direction === 'previous' ? records.previousCursor : records.nextCursor; pageNumber += direction === 'previous' ? -1 : 1; void refresh(); } });
  }
  async function refresh() {
    if (!visible || document.hidden || !controller.getSnapshot().settings) return;
    const current = ++generation; requestAbort?.abort(); requestAbort = new AbortController(); const signal = requestAbort.signal;
    loading = true; failure = ''; renderStatus(); if (!data) renderDash();
    try {
      const [next, nextRecords] = await Promise.all([load(signal), client.sessions({ ...query(), phase, limit: 20, ...(cursor ? { cursor } : {}) }, { signal })]);
      if (!visible || current !== generation) return;
      if (next.report.version !== nextRecords.version) { cursor = null; pageNumber = 1; void refresh(); return; }
      data = next; records = nextRecords; loading = false; renderDash(); renderSessions();
    } catch (error) {
      if (error.name === 'AbortError' || current !== generation || !visible) return;
      if (error.code === 'CURSOR_STALE') { cursor = null; pageNumber = 1; notify('统计记录已变化，已返回第一页'); void refresh(); return; }
      if (error.code === 'VERSION_RACE') { void refresh(); return; }
      failure = error.message;
    } finally { if (current === generation) { loading = false; renderStatus(); $('[data-fd-dash]').setAttribute('aria-busy', 'false'); } }
  }
  const refreshLifecycle = createReportRefresh({ controller, refresh, visible: false, getKey: snapshot => snapshot.version + ':' + statisticsToday(snapshot), onHide() { generation++; requestAbort?.abort(); }, onChange(snapshot, previousKey) {
    const day = statisticsToday(snapshot); if (range.preset !== 'custom' && day !== range.today) { range = { ...range, today: day, ...rangeForPreset(range.preset, day) }; renderChrome(); }
    if (previousKey !== undefined && cursor) { cursor = null; pageNumber = 1; }
  } });

  // —— 交互 ——
  element.addEventListener('change', event => {
    const control = event.target.matches('workbench-select') ? event.target.querySelector('input') : event.target; if (!control?.name) return;
    if (control.name === 'focus-project-filter') { filters = { ...filters, projectId: control.value.startsWith('project:') ? control.value.slice(8) : null, unassigned: control.value === 'unassigned' }; changed(); }
    if (control.name === 'focus-task-filter') { filters = { ...filters, taskId: control.value || null }; changed(); }
    if (control.name === 'focus-phase-filter') { phase = control.value; cursor = null; pageNumber = 1; void refresh(); }
    if (control.name === 'fd-from' || control.name === 'fd-to') {
      const from = $('[name=fd-from]').value, to = $('[name=fd-to]').value, status = $('[data-fd-filter-status]');
      try { validateDateRange({ from, to, maxDays: 366 }); status.dataset.error = 'false'; status.textContent = ''; const preset = detectPreset(from, to, dayNow()); setRange({ preset, from, to }); }
      catch (error) { status.dataset.error = 'true'; status.textContent = error.message; }
    }
  }, { signal: abort.signal });
  element.addEventListener('click', async event => {
    const task = event.target.closest('[data-focus-statistics-task]'); if (task) openTask(task.dataset.focusStatisticsTask);
    if (event.target.closest('[data-fd-filter-toggle]')) { setPopover(filterToggle, filterPanel, filterPanel.hidden); return; }
    if (event.target.closest('[data-fd-menu-toggle]')) { setPopover(menuToggle, menu, menu.hidden); return; }
    const button = event.target.closest('[data-focus-statistics]'); if (!button || !element.contains(button)) return;
    const action = button.dataset.focusStatistics;
    if (action === 'retry') void refresh();
    if (action === 'close-filter') setPopover(filterToggle, filterPanel, false);
    if (action === 'reset-filters') { filters = { ...EMPTY_FILTERS }; range = { preset: 'today', today: dayNow(), from: dayNow(), to: dayNow() }; changed(); }
    if (action === 'start') onStartFocus?.();
    if (action === 'export') {
      closePopovers({ focus: true }); button.disabled = true;
      try { const exported = await client.export(); const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' })), anchor = document.createElement('a'); anchor.href = url; anchor.download = `Daylight-focus-${statisticsToday(controller.getSnapshot())}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); notify('专注 JSON 已导出'); }
      catch (error) { notify(error.message); } finally { button.disabled = false; }
    }
  }, { signal: abort.signal });
  document.addEventListener('pointerdown', event => { if (!element.contains(event.target) || !event.target.closest('.fd-pop-wrap')) closePopovers({ focus: false }); }, { signal: abort.signal });
  element.addEventListener('keydown', event => {
    if (event.key === 'Escape') { const open = !filterPanel.hidden ? [filterToggle, filterPanel] : !menu.hidden ? [menuToggle, menu] : null; if (open) { event.preventDefault(); event.stopPropagation(); setPopover(open[0], open[1], false); } return; }
    if (event.target.closest('[role=menu]') && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); const items = [...menu.querySelectorAll('[role=menuitem]:not(:disabled)')], i = items.indexOf(event.target); items[(i + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); return; }
    if (event.target === menuToggle && event.key === 'ArrowDown') { event.preventDefault(); setPopover(menuToggle, menu, true); return; }
  }, { signal: abort.signal });
  element.addEventListener('focusout', event => { if (!filterPanel.hidden && event.relatedTarget && !event.relatedTarget.closest?.('.fd-pop-wrap') && element.contains(event.relatedTarget)) setPopover(filterToggle, filterPanel, false, { focus: false }); }, { signal: abort.signal });

  renderChrome(); renderDash(); renderStatus();
  return { element, updateRoute(next = {}) {
    filters = { projectId: next.projectId || null, taskId: next.taskId || null, unassigned: Boolean(next.unassigned) }; const day = dayNow();
    range = isCivilDate(next.from) && isCivilDate(next.to) ? { preset: detectPreset(next.from, next.to, day), today: day, from: next.from, to: next.to } : { preset: 'today', today: day, from: day, to: day };
    cursor = null; pageNumber = 1; renderChrome(); if (visible) void refresh();
  }, updateState() { renderFilters(); }, setVisible(value) { element.hidden = !value; visible = value; refreshLifecycle.setVisible(value); if (!value) closePopovers({ focus: false }); }, dispose() { visible = false; generation++; refreshLifecycle.dispose(); abort.abort(); requestAbort?.abort(); paginationDispose?.(); disposeSegments?.(); disposeChart?.(); element.remove(); } };
}
