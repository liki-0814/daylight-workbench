export function timerText(ms) { const seconds = Math.ceil(Math.max(0, ms || 0) / 1000); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; }
export function durationText(ms) { if (ms > 0 && ms < 1000) return '不到 1 秒'; const seconds = Math.floor(Math.max(0, ms || 0) / 1000), minutes = Math.floor(seconds / 60); return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : minutes ? `${minutes} 分钟` : `${seconds} 秒`; }
export const endReasonText = value => ({ completed: '完整结束', stopped: '提前结束', task_completed: '任务完成', task_deleted: '任务删除', recovery_task_invalid: '恢复时任务无效' }[value] || value);
export const timeQualityText = value => ({ clock_changed: '系统时间曾回拨，仅计入已确认区间', recovery_uncertain: '恢复时无法确认任务终止时间，仅保留已闭合计时' }[value] || '');
export function canResumeFocus(snapshot) {
  const current = snapshot.current;
  return current?.status === 'paused' && current.remainingMs > 0 && (!current.clockIssue || (snapshot.displayNow ?? snapshot.serverNow ?? 0) >= current.clockIssue.frozenAt);
}
export function focusNotificationFeedback(snapshot) {
  if (snapshot.lastOutcome?.notification?.state !== 'failed') return null;
  const details = typeof snapshot.runtime?.notificationError === 'string' ? snapshot.runtime.notificationError.trim() : '';
  return { message: '专注计时记录已保存，但系统提醒发送失败。请检查系统通知设置。', details };
}
export function statisticsToday(snapshot) {
  const timeZone = snapshot?.settings?.statisticsTimeZone || 'UTC', now = snapshot?.displayNow || snapshot?.serverNow || Date.now();
  const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = type => parts.find(part => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
export function sessionElapsed(session, now) { return session.segments.reduce((sum, segment) => sum + Math.max(0, (segment.endAt ?? Math.min(now, session.deadlineAt)) - segment.startAt), 0); }
