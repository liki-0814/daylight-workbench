import { escapeButtonText as esc } from '../components/button.js';
import { extensionsRoute } from '../routes.js';

export function extensionPlanContent(plan) {
  return `<div class="extension-impact">${(plan.impact || []).map(text => `<p>${esc(text)}</p>`).join('')}${(plan.conflicts || []).map(text => `<p role="alert" class="extension-error">${esc(text)}</p>`).join('')}</div><div class="extension-diffs">${(plan.files || []).map(file => `<details><summary><span>${esc(file.path)}</span><small>${esc(file.beforeKind)} → ${esc(file.afterKind)}</small></summary>${file.linkTarget ? `<p>链接到 <code>${esc(file.linkTarget)}</code></p>` : ''}${file.before !== undefined || file.after !== undefined ? `<div class="extension-diff-columns"><div><strong>修改前</strong><pre>${esc(file.before ?? '（不存在）')}</pre></div><div><strong>修改后</strong><pre>${esc(file.after ?? '（移除）')}</pre></div></div>` : '<p>目录或链接的变更已记录，可通过操作回执恢复。</p>'}</details>`).join('')}</div>`;
}
export function extensionDraftCard(pending) {
  return `<div class="ai-card extension-review"><h3>审阅扩展变更</h3><p>${esc(pending.summary)}</p>${extensionPlanContent(pending.plan)}<div class="ai-card-actions"><button type="button" class="secondary" data-reject>取消草稿</button><button type="button" class="primary" data-apply ${pending.plan.conflicts?.length ? 'disabled' : ''}>${pending.action.type === 'mcp.probe' ? '确认并检测' : '应用变更'}</button></div><small>来源或接入文件变化后需要重新预览；不会自动将公共 MCP 加载到 Daylight 对话。</small></div>`;
}
export function extensionSubmissionCard(submission) {
  if (!submission || submission.acknowledged) return '';
  const isProbe = submission.request.action.type === 'mcp.probe';
  const unknown = ['submitted', 'unknown'].includes(submission.status), status = unknown ? '正在核对扩展提交结果' : submission.status === 'applied' ? isProbe ? 'MCP 检测已确认' : '扩展变更已保存' : '扩展变更需要重新审阅';
  return `<div class="ai-card extension-review"><h3>${status}</h3><p>${esc(submission.summary)}</p><p>${esc(submission.error?.error || (unknown ? '服务可能已保存。请核对原请求，不能直接换请求重复执行。' : '客户端加载结果需要另行核对。'))}</p>${extensionPlanContent(submission.plan)}<div class="ai-card-actions">${unknown ? `<button type="button" class="primary" data-extension-submission="retry" data-submission-id="${esc(submission.id)}">核对原请求</button>` : `<button type="button" class="secondary" data-extension-submission="acknowledge" data-submission-id="${esc(submission.id)}">确认结果</button>`}<a class="text-button" href="${extensionsRoute({ tab: submission.request.action.type.startsWith('mcp.') ? 'mcp' : 'skills', operation: submission.request.requestId })}">查看操作回执</a></div></div>`;
}
