import { metricCard } from '../components/metric-card.js';
import { actionButton, escapeButtonText as esc } from '../components/button.js';
import { statisticsToday, durationText } from './presentation.js';
import { createReportRefresh } from './report-refresh.js';
export function createTodaySummary({ client, controller, onStatistics }) {
  const element = document.createElement('section'); element.className = 'focus-today-summary'; const abort = new AbortController(); let visible = false, requestAbort, generation = 0, data;
  async function refresh() {
    if (!visible || document.hidden) return;
    const snapshot = controller.getSnapshot(); if (!snapshot.settings) return;
    const day = statisticsToday(snapshot), current = ++generation; requestAbort?.abort(); requestAbort = new AbortController();
    element.setAttribute('aria-busy', 'true');
    try { const result = await client.statistics({ from: day, to: day }, { signal: requestAbort.signal }); if (!visible || current !== generation) return; data = result; render(); }
    catch (error) { if (error.name !== 'AbortError' && visible && current === generation) { render(); element.querySelector('[data-summary-status]').textContent = (data ? '统计尚未更新：' : '') + error.message; } }
    finally { if (current === generation) element.setAttribute('aria-busy', 'false'); }
  }
  function render() { const summary = data?.summary || {}; element.innerHTML = `<div class="focus-metrics">${metricCard({ label: '今日专注计时', value: durationText(summary.workElapsedMs), note: summary.includesCurrent ? '所有任务 · 含当前计时' : '所有任务' })}${metricCard({ label: '完整轮数', value: summary.completedRounds || 0, unit: '轮' })}${metricCard({ label: '提前结束', value: summary.stoppedSessions || 0, unit: '次' })}</div><div class="focus-summary-footer"><span>${data ? '统计今天：' + esc(data.selection.from) + ' · ' + esc(data.timeZone) : '统计加载中'}</span>${actionButton({ label: '查看统计', variant: 'text', attrs: { 'data-summary-open': true } })}${actionButton({ label: '刷新', variant: 'text', attrs: { 'data-summary-refresh': true } })}</div><p data-summary-status role="status"></p>`; }
  const refreshLifecycle = createReportRefresh({ controller, refresh, visible: false, getKey: snapshot => snapshot.version + ':' + statisticsToday(snapshot), onHide() { generation++; requestAbort?.abort(); } });
  element.addEventListener('click', event => { if (event.target.closest('[data-summary-open]')) onStatistics(); if (event.target.closest('[data-summary-refresh]')) void refresh(); }, { signal: abort.signal });
  render(); return { element, setVisible(value) { visible = value; refreshLifecycle.setVisible(value); }, dispose() { visible = false; generation++; refreshLifecycle.dispose(); abort.abort(); requestAbort?.abort(); element.remove(); } };
}
