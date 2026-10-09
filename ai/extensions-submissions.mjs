import { randomUUID } from 'node:crypto';
import { httpError } from './http.mjs';
import { canonicalJSON } from '../core/extensions-contracts.js';

export const hasUnresolvedExtensionSubmission = c => ['submitted', 'unknown'].includes(c.extensionSubmission?.status);
export function assertExtensionDraftAllowed(c) {
  if (hasUnresolvedExtensionSubmission(c) || c.extensionSubmission?.applying) throw httpError('上次扩展提交尚待核对，请重试原请求', 409, { code: 'EXTENSION_SUBMISSION_UNRESOLVED' });
}
// Approvals outlive the run-local pending/waiter, just like focus submissions.
export function createExtensionSubmissions({ api, save, onResolved = () => {} }) {
  const applying = new Set();
  const isApplying = c => applying.has(c.id);
  const lock = c => { if (isApplying(c)) throw httpError('正在核对扩展提交，请等待', 409); applying.add(c.id); };
  async function submit(c, submission, notify = false) {
    submission.applying = true;
    let result;
    try {
      result = await api('extensions/actions', submission.request);
      if (result?.ok !== true || result.status !== 'applied' || typeof result.version !== 'string' || result.operationId !== submission.request.requestId) throw httpError('扩展回执无法核对，请重试原请求', 502);
    } catch (failure) {
      submission.status = failure.status >= 400 && failure.status < 500 ? 'needs_review' : 'unknown';
      submission.error = { error: failure.message, ...(failure.code ? { code: failure.code } : {}) }; submission.result = null; submission.applying = false;
      try { save(c); } catch { submission.status = 'unknown'; throw httpError('扩展提交结果未保存，请核对原请求', 503); }
      throw failure;
    }
    submission.status = 'applied'; submission.result = result; submission.error = null; submission.applying = false;
    const message = c.messages.some(value => value.requestId === submission.request.requestId) ? null : { id: randomUUID(), role: 'operation', requestId: submission.request.requestId, kind: 'extensions', text: '已应用：' + submission.summary, action: submission.request.action, appliedVersion: result.version, operationId: result.operationId, impact: result.impact };
    if (message) c.messages.push(message);
    try { save(c); } catch {
      if (message) c.messages = c.messages.filter(value => value.id !== message.id);
      submission.status = 'unknown'; submission.result = null;
      submission.error = { error: '扩展服务可能已应用，但对话结果未保存；请核对原请求' };
      throw httpError(submission.error.error, 503);
    }
    if (notify) await onResolved(c, submission, result);
    return { ...result, message: result.action.type === 'mcp.generate' ? '已生成配置文件，仍需在客户端手动接入，不代表客户端已加载。' : result.action.type === 'mcp.probe' ? result.message : '用户已审阅，扩展变更已经保存。软件刷新和运行发现需要另行核对。' };
  }
  async function apply(c, pending, input) {
    if (input.action && canonicalJSON(input.action) !== canonicalJSON(pending.action)) throw httpError('扩展草稿发生变化，请重新预览', 409);
    if (input.approve !== true) {
      if (c.extensionSubmission?.id === pending.id) throw httpError('已提交的扩展操作不能取消副作用，请核对回执', 409);
      c.messages.push({ id: randomUUID(), role: 'operation', text: '已取消扩展草稿', kind: 'extensions' });
      return { ok: false, error: '用户取消了扩展草稿，没有写入或启动 MCP。' };
    }
    lock(c); pending.applying = true;
    try {
      let submission = c.extensionSubmission;
      if (submission?.id !== pending.id) {
        assertExtensionDraftAllowed(c);
        const before = c.extensionSubmission;
        submission = { id: pending.id, status: 'submitted', approvedAt: new Date().toISOString(), summary: pending.summary, plan: structuredClone(pending.plan), request: { requestId: pending.requestId, expectedVersion: pending.plan.expectedVersion, planId: pending.plan.planId, action: structuredClone(pending.action) }, result: null };
        c.extensionSubmission = submission;
        try { save(c); } catch { c.extensionSubmission = before; throw httpError('批准记录未保存，扩展操作尚未提交', 503); }
      }
      if (submission.status === 'applied') return submission.result;
      return await submit(c, submission);
    } finally { pending.applying = false; if (c.extensionSubmission) c.extensionSubmission.applying = false; applying.delete(c.id); }
  }
  async function recover(c, input) {
    if (!input || Object.keys(input).some(key => !['id', 'action'].includes(key)) || !['retry', 'acknowledge'].includes(input.action)) throw httpError('核对只接受 id 和 retry/acknowledge');
    const submission = c.extensionSubmission;
    if (!submission || submission.id !== input.id) throw httpError('扩展提交已变化，请刷新', 409);
    lock(c);
    try {
      if (input.action === 'acknowledge') {
        if (!['applied', 'needs_review'].includes(submission.status)) throw httpError('结果未知，请先核对原请求', 409);
        const before = submission.acknowledged; submission.acknowledged = true;
        try { save(c); } catch (failure) { submission.acknowledged = before; throw failure; }
        const result = submission.status === 'applied' ? submission.result : { ok: false, kind: 'extensions', status: 'needs_review', error: submission.error?.error || '请重新读取并预览；旧操作状态须按回执核对。' };
        await onResolved(c, submission, result); return result;
      }
      if (submission.acknowledged) throw httpError('已确认该提交，请重新读取后提出新变更', 409);
      if (submission.status === 'applied') { await onResolved(c, submission, submission.result); return submission.result; }
      return await submit(c, submission, true);
    } finally { submission.applying = false; applying.delete(c.id); }
  }
  return { apply, recover, isApplying };
}
