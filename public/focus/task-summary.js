import { disclosureSection } from '../components/section.js';
import { actionButton, escapeButtonText as esc } from '../components/button.js';
import { durationText, endReasonText, timeQualityText, sessionElapsed } from './presentation.js';
import { createReportRefresh } from './report-refresh.js';
export function createTaskSummaryRefresh({ taskId, ...options }) { return createReportRefresh({ ...options, matchesCurrent: current => current.taskId === taskId }); }

export function createTaskSummary({ taskId, client, controller, onStartTask, onStatistics, hasUnsavedEdits, getTask, notify, document: page = globalThis.document }) {
  const element = document.createElement('section'); element.className = 'focus-task-summary'; const abort = new AbortController(); let requestAbort, generation = 0, data;
  element.innerHTML = disclosureSection({ id: 'task-focus-summary', title: '专注记录', content: `<div data-task-focus-body>正在读取专注记录…</div><div class="focus-actions">${actionButton({ label: '开始专注', symbol: 'timer', attrs: { 'data-task-focus': 'start' } })}${actionButton({ label: '查看统计', variant: 'text', attrs: { 'data-task-focus': 'statistics' } })}${actionButton({ label: '刷新记录', variant: 'text', attrs: { 'data-task-focus': 'refresh' } })}</div><div data-task-focus-confirm></div><p data-task-focus-error role="status"></p>` });
  async function refresh() {
    if (page?.hidden) return;
    const current = ++generation; requestAbort?.abort(); requestAbort = new AbortController();
    try { const result = await client.taskSummary(taskId, { signal: requestAbort.signal }); if (current !== generation) return; data = result; render(); element.querySelector('[data-task-focus-error]').textContent = ''; }
    catch (error) { if (error.name !== 'AbortError' && current === generation) element.querySelector('[data-task-focus-error]').textContent = (data ? '记录尚未更新：' : '') + error.message; }
  }
  function render() { element.querySelector('[data-task-focus-body]').innerHTML = `<p>累计 ${durationText(data.summary.workElapsedMs)} · ${data.summary.completedRounds} 个完整轮次${data.summary.includesCurrent ? ' · 含当前计时' : ''}</p><ol class="focus-recent">${data.recent.map(session => `<li><span>${new Date(session.startedAt).toLocaleString('zh-CN')}</span><span>${durationText(sessionElapsed(session, data.serverNow))} · ${session.status === 'ended' ? esc(endReasonText(session.endReason)) : session.status === 'paused' ? '已暂停' : '进行中'}</span>${timeQualityText(session.timeQuality) ? `<small>${esc(timeQualityText(session.timeQuality))}</small>` : ''}</li>`).join('') || '<li>暂无专注记录</li>'}</ol>`; }
  const unsubscribe = controller.subscribe(({ snapshot }) => { element.querySelector('[data-task-focus=start]').disabled = snapshot.busy || snapshot.degraded || snapshot.unavailable || snapshot.unknownRequest || getTask?.()?.status === 'done' || Boolean(getTask && !getTask()); });
  const refreshLifecycle = createTaskSummaryRefresh({ taskId, controller, refresh, document: page, onHide() { generation++; requestAbort?.abort(); } });
  element.addEventListener('click', async event => { const button = event.target.closest('[data-task-focus]'); if (!button || !element.contains(button)) return; const action = button.dataset.taskFocus; if (action === 'statistics') onStatistics(taskId); if (action === 'refresh') void refresh(); if (action === 'cancel') element.querySelector('[data-task-focus-confirm]').replaceChildren(); if (action === 'start' && hasUnsavedEdits?.()) { element.querySelector('[data-task-focus-confirm]').innerHTML = `<p class="quiet-note">存在未保存编辑。专注将使用已保存的任务；你也可以先保存修改。</p>${actionButton({ label: '使用已保存任务开始', attrs: { 'data-task-focus': 'confirmed' } })}${actionButton({ label: '先保存', variant: 'text', attrs: { 'data-task-focus': 'cancel' } })}`; return; } if (action === 'start' || action === 'confirmed') { try { await onStartTask(taskId); } catch (error) { notify(error.message); } } }, { signal: abort.signal });
  return { element, dispose() { generation++; refreshLifecycle.dispose(); unsubscribe(); abort.abort(); requestAbort?.abort(); element.remove(); } };
}
