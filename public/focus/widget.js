import { actionButton, escapeButtonText as esc } from '../components/button.js';
import { createDialogShell } from '../components/dialog-shell.js';
import { createFocusPanel } from './panel.js';
import { timerText, canResumeFocus } from './presentation.js';
export function createFocusWidget(options) {
  const { controller, notify } = options, element = document.createElement('aside'); element.className = 'focus-widget'; element.setAttribute('aria-label', '全局专注计时');
  const abort = new AbortController(); let panel, shell, key;
  function expand() { if (document.querySelector('dialog[open]')) { notify('请先关闭当前对话框'); return; } panel?.dispose(); shell?.dispose(); shell = createDialogShell({ title: '专注计时' }); panel = createFocusPanel({ ...options, openTask(id) { shell.close(); options.openTask(id); }, onStatistics() { shell.close(); options.onStatistics(); }, onChooseTask() { shell.close(); options.onChooseTask(); } }); shell.setContent(panel.element); shell.open(); }
  const unsubscribe = controller.subscribe(({ snapshot }) => {
    const { current, lastOutcome } = snapshot;
    element.hidden = !current && (!lastOutcome || lastOutcome.acknowledged);
    const nextKey = JSON.stringify([current?.id, current?.status, current?.clockIssue, lastOutcome?.id, snapshot.degraded, snapshot.busy, snapshot.unknownRequest]);
    if (key !== nextKey) { key = nextKey; element.innerHTML = current ? `<span class="focus-widget-phase">${current.phase === 'work' ? '工作' : '休息'}</span><strong>${esc(current.taskTitleSnapshot || '短休息')}</strong><span class="focus-widget-timer" data-widget-timer></span>${actionButton({ label: current.status === 'paused' ? '继续' : '暂停', symbol: current.status === 'paused' ? 'play' : 'pause', attrs: { 'data-focus-widget': 'toggle', disabled: snapshot.degraded || snapshot.busy || snapshot.unknownRequest || Boolean(current.clockIssue) } })}${actionButton({ label: '展开', attrs: { 'data-focus-widget': 'expand' } })}<span class="focus-widget-status" role="status">${snapshot.degraded ? '连接中断，状态待核对' : ''}</span>` : `<strong>本轮已结束</strong>${actionButton({ label: '查看结果', attrs: { 'data-focus-widget': 'expand' } })}`; }
    if (current) {
      element.querySelector('[data-widget-timer]').textContent = timerText(current.remainingMs);
      element.querySelector('[data-focus-widget=toggle]').disabled = snapshot.degraded || snapshot.busy || snapshot.unknownRequest || current.status === 'paused' && !canResumeFocus(snapshot);
      element.querySelector('.focus-widget-status').textContent = snapshot.degraded ? '连接中断，状态待核对' : current.clockIssue ? '系统时间回拨，计时已冻结' : '';
    }
  });
  element.addEventListener('click', async event => { const button = event.target.closest('[data-focus-widget]'); if (!button || !element.contains(button) || button.disabled) return; if (button.dataset.focusWidget === 'expand') expand(); else { const current = controller.getSnapshot().current; try { await controller.act({ type: current.status === 'paused' ? 'focus.resume' : 'focus.pause', sessionId: current.id }); } catch (error) { notify(error.message); } } }, { signal: abort.signal });
  return { element, expand, dispose() { unsubscribe(); abort.abort(); panel?.dispose(); shell?.dispose(); element.remove(); } };
}
