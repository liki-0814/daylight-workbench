import { actionButton, escapeButtonText as esc } from '../components/button.js';
import { createProgressMeter } from '../components/progress-meter.js';
import { timerText, durationText, endReasonText, timeQualityText, canResumeFocus, focusNotificationFeedback } from './presentation.js';
export function createFocusPanel({ controller, getSuggestedTask = () => null, onStartTask, onChooseTask, openTask, onStatistics, notify }) {
  const element = document.createElement('section'); element.className = 'focus-panel'; const abort = new AbortController(); let key, meter;
  const button = (action, label, symbol, disabled, variant = 'secondary') => actionButton({ label, symbol, variant, attrs: { 'data-focus-action': action, disabled } });
  function update({ snapshot }) {
    const { current, lastOutcome, busy, degraded, unknownRequest } = snapshot, disabled = busy || degraded || unknownRequest;
    const delivery = focusNotificationFeedback(snapshot);
    const nextKey = JSON.stringify([snapshot.unavailable, snapshot.settings?.workSeconds, current?.id, current?.status, current?.clockIssue, lastOutcome?.id, lastOutcome?.acknowledged, lastOutcome?.notification?.state, snapshot.runtime?.notificationError, busy, degraded, unknownRequest, snapshot.connectionError, getSuggestedTask()?.id]);
    if (nextKey !== key) {
      key = nextKey; meter?.dispose();
      let content;
      if (current) content = `<div class="focus-label">${current.phase === 'work' ? '正在专注' : '短休息'} · ${current.status === 'paused' ? '已暂停' : '进行中'}</div><h2 class="focus-session-title">${esc(current.taskTitleSnapshot || '短休息')}</h2><p class="focus-timer" data-focus-timer>${timerText(current.remainingMs)}</p><div data-focus-progress></div><p class="focus-state-note" data-focus-state-note>${current.clockIssue ? '系统时间回拨，计时已冻结。可结束本轮，或待系统时间恢复后继续。' : current.status === 'paused' ? '暂停期间不计入专注时间' : ''}</p><div class="focus-actions">${button(current.status === 'paused' ? 'resume' : 'pause', current.status === 'paused' ? '继续' : '暂停', current.status === 'paused' ? 'play' : 'pause', disabled)}${button('finish', '结束本轮', 'close', disabled)}${current.taskId ? button('task', '查看任务', null, false, 'text') : ''}${button('statistics', '查看统计', 'chart', false, 'text')}</div>${timeQualityText(current.timeQuality) ? `<p class="quiet-note">${esc(timeQualityText(current.timeQuality))}</p>` : ''}`;
      else if (lastOutcome && !lastOutcome.acknowledged) content = `<div class="focus-label">本轮已结束 · ${esc(endReasonText(lastOutcome.endReason))}</div><h2 class="focus-session-title">${esc(lastOutcome.taskTitleSnapshot || '短休息')}</h2><p class="focus-outcome-time">本轮计时 ${durationText(lastOutcome.elapsedMs)}</p>${timeQualityText(lastOutcome.timeQuality) ? `<p class="quiet-note">${esc(timeQualityText(lastOutcome.timeQuality))}</p>` : ''}<div class="focus-actions">${lastOutcome.phase === 'work' ? button('break', '开始休息', 'timer', disabled) : ''}${lastOutcome.taskId ? button('again', '再来一轮', 'play', disabled) : button('choose', '选择任务', 'tasks', disabled)}${button('statistics', '查看统计', 'chart', false, 'text')}${button('acknowledge', '收起结果', null, disabled, 'text')}</div>`;
      else { const task = getSuggestedTask(); content = `<div class="focus-label">专注计时</div><h2 class="focus-session-title">${task ? esc(task.title) : '选择一项任务开始专注'}</h2><p class="quiet-note">默认 ${Math.round((snapshot.settings?.workSeconds || 1500) / 60)} 分钟；开始专注不会自动开始任务或加入今天。</p><div class="focus-actions">${button(task ? 'start' : 'choose', task ? '开始专注' : '选择任务', 'timer', disabled || snapshot.unavailable, 'primary')}${button('break', '短休息', null, disabled || snapshot.unavailable)}</div>`; }
      element.innerHTML = content + (delivery ? `<p class="ui-feedback" role="status" data-focus-delivery-error>${esc(delivery.message)}</p>${delivery.details ? `<details class="focus-permission-details"><summary>查看发送失败详情</summary><p>${esc(delivery.details)}</p></details>` : ''}` : '') + `<p class="focus-connection" role="status">${degraded ? esc(snapshot.connectionError || '连接中断，计时状态待核对') : ''}</p>${unknownRequest ? button('retry', '重试原专注操作', 'refresh', busy) : degraded || snapshot.unavailable ? button('refresh', '刷新计时状态', 'refresh', busy) : ''}`;
      if (current) { meter = createProgressMeter({ label: '本轮计时进度' }); element.querySelector('[data-focus-progress]').append(meter.element); }
    }
    if (current) {
      element.querySelector('[data-focus-timer]').textContent = timerText(current.remainingMs); meter.setValue(1 - current.remainingMs / current.targetMs, `剩余 ${timerText(current.remainingMs)}`);
      if (!current.clockIssue && current.status === 'running' && current.remainingMs === 0) element.querySelector('[data-focus-state-note]').textContent = '到期结果待保存，正在核对服务状态';
      if (current.status === 'paused') element.querySelector('[data-focus-action=resume]').disabled = disabled || !canResumeFocus(snapshot);
    }
  }
  const unsubscribe = controller.subscribe(update);
  element.addEventListener('click', async event => {
    const target = event.target.closest('[data-focus-action]'); if (!target || !element.contains(target) || target.disabled) return;
    const action = target.dataset.focusAction, snapshot = controller.getSnapshot();
    try {
      if (action === 'start') await onStartTask(getSuggestedTask()?.id);
      if (action === 'choose') onChooseTask();
      if (action === 'again') await onStartTask(snapshot.lastOutcome?.taskId);
      if (action === 'task') openTask(snapshot.current.taskId);
      if (action === 'statistics') onStatistics();
      if (action === 'break') await controller.act({ type: 'focus.start', phase: 'shortBreak' });
      if (['pause', 'resume', 'finish'].includes(action)) await controller.act({ type: 'focus.' + action, sessionId: snapshot.current.id });
      if (action === 'acknowledge') await controller.act({ type: 'focus.acknowledge', outcomeId: snapshot.lastOutcome.id });
      if (action === 'refresh') await controller.refresh();
      if (action === 'retry') await controller.retry();
    } catch (error) { notify(error.message); }
  }, { signal: abort.signal });
  return { element, dispose() { unsubscribe(); meter?.dispose(); abort.abort(); element.remove(); } };
}
