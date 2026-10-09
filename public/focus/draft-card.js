import { escapeButtonText as esc } from '../components/button.js';
import { durationText } from './presentation.js';

const labels = {'focus.start':'开始计时','focus.pause':'暂停计时','focus.resume':'继续计时','focus.finish':'结束本轮','focus.switch':'结束旧轮并开始新轮','focus.settings':'修改专注设置','focus.acknowledge':'确认本轮结果'};
const phase = value => value==='work'?'工作':'短休息';
function details(action, workspace={tasks:[]}, impact={}) {
  const currentAction=['focus.pause','focus.resume','focus.finish'].includes(action?.type);
  const session=currentAction && impact.current?.id===action.sessionId ? impact.current : ['focus.start','focus.switch'].includes(action?.type) ? impact.target : null;
  const taskId=session?.taskId || action?.taskId, task=workspace.tasks?.find(task=>task.id===taskId);
  const sessionPhase=session?.phase || action?.phase, targetMs=session?.targetMs ?? (action?.durationSeconds ? action.durationSeconds*1000 : null);
  return `<p><strong>${esc(labels[action?.type] || '专注操作')}</strong>${sessionPhase?' · '+phase(sessionPhase):''}</p>${taskId?`<p>任务：${esc(session?.taskTitleSnapshot || task?.title || taskId)}</p>`:''}${targetMs!==null?`<p>时长：${esc(durationText(targetMs))}</p>`:''}${currentAction && session && Number.isFinite(session.elapsedMs) && Number.isFinite(session.remainingMs)?`<p>已计时：${esc(durationText(session.elapsedMs))} · 剩余：${esc(durationText(session.remainingMs))}</p>`:''}<details><summary>操作详情</summary><pre>${esc(JSON.stringify(action,null,2))}</pre></details>`;
}
export function focusDraftCard(p, workspace) {
  const current=p.impact?.current,oldTask=workspace.tasks?.find(task=>task.id===current?.taskId),oldTitle=current?.taskTitleSnapshot || oldTask?.title;
  return `<div class="ai-card focus-draft-card"><h3>审阅专注变更</h3><p>${esc(p.summary)}</p>${details(p.action,workspace,p.impact)}${p.impact?.endsCurrent?`<p class="ai-impact">将提前结束${esc(oldTitle ? '「'+oldTitle+'」' : '当前')}${current?.phase?' '+phase(current.phase):''}计时，已计时约 ${Math.floor((current?.elapsedMs || 0)/60000)} 分钟。</p>`:''}${p.expiresAt?`<p class="muted">草稿有效至 ${esc(new Date(p.expiresAt).toLocaleTimeString())}；状态变化后须重新核对。</p>`:''}<p class="muted">计时不会自动完成任务；专注历史不能用任务撤销恢复。设置变更不会弹出系统通知授权。</p><div class="ai-card-actions"><button type="button" class="secondary" data-reject>取消草稿</button><button type="button" class="primary" data-apply>应用专注变更</button></div></div>`;
}
export function focusSubmissionCard(s, workspace) {
  const uncertain=['submitted','unknown'].includes(s.status),applied=s.status==='applied';
  const error=s.error?.error || s.error || s.result?.error;
  const latest=s.latestState, current=latest?.current;
  const readback=latest?`<p class="muted">核对快照 · 专注版本 ${esc(latest.version)}：${current?esc((current.taskTitleSnapshot || phase(current.phase))+' · '+(current.status==='paused'?'已暂停':'进行中')):'当前没有计时会话'}。<a href="#focus">查看最新专注统计</a></p>`:'';
  return `<div class="ai-card focus-submission-card"><h3>${uncertain?'上次专注提交待核对':applied?'专注变更已保存':'专注提交需要核对'}</h3><p>${esc(s.summary)}</p>${details(s.request?.action,workspace,s.impact)}${uncertain?'<p>响应未确认，操作可能已经执行。核对只重试已批准的原请求，不创建新操作。</p>':applied?'<p>已保存成功，核对结果已记录在对话中。</p>':'<p>请核对当前计时与拒绝原因；超过回执保留窗口时，无法据此证明原请求从未执行。</p>'}${error?`<p class="ai-impact">${esc(typeof error==='string'?error:error.message || JSON.stringify(error))}</p>`:''}${readback}<div class="ai-card-actions">${uncertain?`<button type="button" class="primary" data-focus-submission="retry" data-submission-id="${esc(s.id)}">核对原请求</button>`:`<button type="button" class="secondary" data-focus-submission="acknowledge" data-submission-id="${esc(s.id)}">${applied?'确认结果':'已人工核对，确认结果'}</button>`}</div></div>`;
}
