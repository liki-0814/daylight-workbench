import { isCivilDate, addCivilDays } from '../../core/date.js';
import { focusRoute } from '../routes.js';
import { actionButton, escapeButtonText as esc } from '../components/button.js';
import { selectField } from '../components/select.js';
import { createDateRange } from '../components/date-range.js';
import { metricCard } from '../components/metric-card.js';
import { createBarChart } from '../components/bar-chart.js';
import { pagination, mountPagination } from '../components/pagination.js';
import { sectionHeading, refreshButton, setRefreshState } from '../components/section.js';
import { statisticsToday, durationText, endReasonText, timeQualityText, sessionElapsed } from './presentation.js';
import { createReportRefresh } from './report-refresh.js';

export function createStatisticsPage({ client, controller, getTaskSnapshot, onRoute, openTask, notify }) {
  const element = document.createElement('main'); element.id = 'focus-statistics-page'; element.className = 'focus-statistics-page';
  const abort = new AbortController(); let visible = false, requestAbort, generation = 0, report, records, cursor, pageNumber = 1, paginationDispose, filters = { projectId: null, taskId: null, unassigned: false }, phase = 'work';
  const today = statisticsToday(controller.getSnapshot()); let range = { preset: 'today', today, from: today, to: today };
  element.innerHTML = `<header class="topbar"><span>我的工作空间 <span class="slash">/</span> 专注统计</span></header><div class="workspace focus-statistics-workspace"><section class="page-heading"><div><h1>专注统计</h1><p>统计计时记录，包含睡眠和退出期间经过的时间</p></div>${actionButton({ label: '导出专注 JSON', symbol: 'disk', attrs: { 'data-focus-statistics': 'export' } })}</section><div class="focus-statistics-range"></div><div class="focus-statistics-filters"></div><p class="quiet-note" data-statistics-timezone></p><div class="focus-statistics-toolbar">${refreshButton({ id: 'refresh-focus-statistics', ariaLabel: '刷新专注统计', attrs: { 'data-focus-statistics': 'refresh' } })}<p data-statistics-status role="status"></p></div><div class="focus-metrics" data-statistics-metrics></div><section class="focus-report-panel">${sectionHeading({ title: '每日专注计时', description: '按统计时区分配运行区间；0 值日期保留' })}<div data-statistics-chart></div></section><section class="focus-report-panel">${sectionHeading({ title: '项目投入', description: '按开始专注时的项目归属，历史不会随任务迁移重写' })}<div data-statistics-projects></div></section><section class="focus-report-panel">${sectionHeading({ title: '会话记录', description: '时间区间与范围有交集，或结束点落在范围内的记录' })}<div data-statistics-phase></div><div data-statistics-sessions></div><div data-statistics-pagination></div></section></div>`;
  const dateRange = createDateRange({ value: range, onChange(value) { range = value; changed(); } }); element.querySelector('.focus-statistics-range').append(dateRange.element);
  const chart = createBarChart({ label: '每日专注计时', onSelect(day) { range = { ...range, preset: 'custom', from: day, to: day }; dateRange.update(range); changed(); } }); element.querySelector('[data-statistics-chart]').append(chart.element);
  function query() { return { from: range.from, to: range.to, ...(filters.projectId ? { projectId: filters.projectId } : filters.unassigned ? { unassigned: '1' } : {}), ...(filters.taskId ? { taskId: filters.taskId } : {}) }; }
  function changed() { cursor = null; pageNumber = 1; onRoute(focusRoute(query()), { replace: true }); void refresh(); }
  function renderFilters() {
    if (element.querySelector('.focus-statistics-filters').contains(document.activeElement)) return;
    const { state } = getTaskSnapshot(), projects = new Map(state.projects.map(project => [project.id, project.name]));
    for (const project of report?.projects || []) if (project.projectId && !projects.has(project.projectId)) projects.set(project.projectId, project.name + '（已删除）');
    const tasks = state.tasks.map(task => ({ value: task.id, label: task.title })); if (filters.taskId && !tasks.some(task => task.value === filters.taskId)) tasks.push({ value: filters.taskId, label: '已删除任务 · ' + filters.taskId });
    element.querySelector('.focus-statistics-filters').innerHTML = selectField({ name: 'focus-project-filter', label: '项目', value: filters.projectId ? 'project:' + filters.projectId : filters.unassigned ? 'unassigned' : '', compact: true, options: [{ value: '', label: '所有项目' }, { value: 'unassigned', label: '未归类' }, ...[...projects].map(([id, name]) => ({ value: 'project:' + id, label: name }))] }) + selectField({ name: 'focus-task-filter', label: '任务', value: filters.taskId || '', compact: true, options: [{ value: '', label: '所有任务' }, ...tasks] });
    element.querySelector('[data-statistics-phase]').innerHTML = selectField({ name: 'focus-phase-filter', label: '会话阶段', value: phase, compact: true, options: [{ value: 'work', label: '工作记录' }, { value: 'shortBreak', label: '短休息记录（不计入工作指标）' }] });
  }
  function renderReport() {
    renderFilters();
    if (!report) { element.querySelector('[data-statistics-metrics]').innerHTML = metricCard({ label: '专注计时', value: '—', state: 'loading' }); return; }
    const { summary, timeZone } = report;
    const warning=controller.getSnapshot().runtime?.largeHistory?' 专注记录较大，查询可能需要更长时间。':'';
    element.querySelector('[data-statistics-timezone]').textContent = `统计今天：${statisticsToday(controller.getSnapshot())} · ${timeZone}；轮次按结束日计数，跨日时长分别分配。${warning}`;
    element.querySelector('[data-statistics-metrics]').innerHTML = metricCard({ label: '专注计时', value: durationText(summary.workElapsedMs), note: summary.includesCurrent ? '含当前计时' : '工作阶段运行区间' }) + metricCard({ label: '完整轮数', value: summary.completedRounds, unit: '轮' }) + metricCard({ label: '提前结束', value: summary.stoppedSessions, unit: '次', note: '任务完成/删除等中断 ' + summary.interruptedSessions + ' 次' });
    chart.update(report.daily.map(day => ({ key: day.day, label: day.day.slice(5), value: day.workElapsedMs, valueText: durationText(day.workElapsedMs) })));
    element.querySelector('[data-statistics-projects]').innerHTML = `<div class="focus-record-scroll"><table class="focus-record-table"><thead><tr><th scope="col">项目快照</th><th scope="col">专注计时</th><th scope="col">完整轮数</th></tr></thead><tbody>${report.projects.map(project => `<tr><td>${esc(project.name)}${project.projectId && !getTaskSnapshot().state.projects.some(value => value.id === project.projectId) ? '<small>已删除项目</small>' : ''}<small>${esc(project.projectId || '未归类')}</small></td><td>${durationText(project.workElapsedMs)}</td><td>${project.completedRounds}</td></tr>`).join('') || '<tr><td colspan="3">当前范围没有项目计时。</td></tr>'}</tbody></table></div>`;
  }
  function renderSessions() {
    if (!records) return;
    element.querySelector('[data-statistics-sessions]').innerHTML = `<div class="focus-record-scroll"><table class="focus-record-table"><thead><tr><th scope="col">开始时间</th><th scope="col">任务 / 项目快照</th><th scope="col">计时</th><th scope="col">结果</th></tr></thead><tbody>${records.sessions.map(session => `<tr><td>${esc(new Date(session.startedAt).toLocaleString('zh-CN', { timeZone: records.timeZone }))}</td><td>${session.taskId && getTaskSnapshot().state.tasks.some(task => task.id === session.taskId) ? `<button class="text-button" data-focus-statistics-task="${esc(session.taskId)}">${esc(session.taskTitleSnapshot)}</button>` : esc(session.taskTitleSnapshot || '短休息')}${session.taskId && !getTaskSnapshot().state.tasks.some(task => task.id === session.taskId) ? '<small>任务已删除</small>' : ''}<small>${esc(session.projectNameSnapshot || '未归类')}</small></td><td>${durationText(sessionElapsed(session, records.serverNow))}</td><td>${session.status === 'ended' ? esc(endReasonText(session.endReason)) : session.status === 'paused' ? '已暂停' : '进行中'}${timeQualityText(session.timeQuality) ? `<small>${esc(timeQualityText(session.timeQuality))}</small>` : ''}</td></tr>`).join('') || '<tr><td colspan="4">当前筛选下没有会话记录。</td></tr>'}</tbody></table></div>`;
    paginationDispose?.(); element.querySelector('[data-statistics-pagination]').innerHTML = pagination({ ...records, label: `第 ${pageNumber} 页 · ${records.total} 条` });
    paginationDispose = mountPagination(element.querySelector('.ui-pagination'), { onChange(direction) { cursor = direction === 'previous' ? records.previousCursor : records.nextCursor; pageNumber += direction === 'previous' ? -1 : 1; void refresh(); } });
  }
  async function refresh() {
    if (!visible || document.hidden || !controller.getSnapshot().settings) return;
    const current = ++generation; requestAbort?.abort(); requestAbort = new AbortController(); const signal = requestAbort.signal;
    setRefreshState(element.querySelector('#refresh-focus-statistics'), { loading: true }); element.querySelector('[data-statistics-status]').textContent = report ? '正在更新…' : '正在读取统计…';
    try {
      const [nextReport, nextRecords] = await Promise.all([client.statistics(query(), { signal }), client.sessions({ ...query(), phase, limit: 20, ...(cursor ? { cursor } : {}) }, { signal })]);
      if (!visible || current !== generation) return;
      if (nextReport.version !== nextRecords.version) { cursor = null; pageNumber = 1; void refresh(); return; }
      report = nextReport; records = nextRecords; renderReport(); renderSessions(); element.querySelector('[data-statistics-status]').textContent = '';
    } catch (error) {
      if (error.name === 'AbortError' || current !== generation || !visible) return;
      if (error.code === 'CURSOR_STALE') { cursor = null; pageNumber = 1; notify('统计记录已变化，已返回第一页'); void refresh(); return; }
      element.querySelector('[data-statistics-status]').textContent = (report ? '尚未更新：' : '读取失败：') + error.message;
    } finally { if (current === generation) setRefreshState(element.querySelector('#refresh-focus-statistics'), { loading: false }); }
  }
  const refreshLifecycle = createReportRefresh({ controller, refresh, visible: false, getKey: snapshot => snapshot.version + ':' + statisticsToday(snapshot), onHide() { generation++; requestAbort?.abort(); }, onChange(snapshot, previousKey) {
    const day = statisticsToday(snapshot); if (['today', '7', '30'].includes(range.preset) && day !== range.today) { range = { ...range, today: day, from: addCivilDays(day, range.preset === 'today' ? 0 : 1 - Number(range.preset)), to: day }; dateRange.update(range); }
    if (previousKey !== undefined && cursor) { cursor = null; pageNumber = 1; }
  } });
  element.addEventListener('change', event => { const control = event.target.matches('workbench-select') ? event.target.querySelector('input') : event.target; if (control.name === 'focus-project-filter') { filters = { ...filters, projectId: control.value.startsWith('project:') ? control.value.slice(8) : null, unassigned: control.value === 'unassigned' }; changed(); } if (control.name === 'focus-task-filter') { filters = { ...filters, taskId: control.value || null }; changed(); } if (control.name === 'focus-phase-filter') { phase = control.value; cursor = null; pageNumber = 1; void refresh(); } }, { signal: abort.signal });
  element.addEventListener('click', async event => {
    const task = event.target.closest('[data-focus-statistics-task]'); if (task) openTask(task.dataset.focusStatisticsTask);
    const button = event.target.closest('[data-focus-statistics]'); if (!button || !element.contains(button)) return;
    if (button.dataset.focusStatistics === 'refresh') void refresh();
    if (button.dataset.focusStatistics === 'export') { button.disabled = true; try { const data = await client.export(); const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), anchor = document.createElement('a'); anchor.href = url; anchor.download = `Daylight-focus-${statisticsToday(controller.getSnapshot())}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (error) { notify(error.message); } finally { button.disabled = false; } }
  }, { signal: abort.signal });
  renderFilters(); renderReport();
  return { element, updateRoute(next = {}) { filters = { projectId: next.projectId || null, taskId: next.taskId || null, unassigned: Boolean(next.unassigned) }; const day = statisticsToday(controller.getSnapshot()); range = isCivilDate(next.from) && isCivilDate(next.to) ? { preset: 'custom', today: day, from: next.from, to: next.to } : { preset: 'today', today: day, from: day, to: day }; dateRange.update(range); cursor = null; pageNumber = 1; renderFilters(); if (visible) void refresh(); }, updateState() { renderFilters(); }, setVisible(value) { element.hidden = !value; visible = value; refreshLifecycle.setVisible(value); }, dispose() { visible = false; generation++; refreshLifecycle.dispose(); abort.abort(); requestAbort?.abort(); paginationDispose?.(); dateRange.dispose(); chart.dispose(); element.remove(); } };
}
