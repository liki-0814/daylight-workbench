import { randomUUID } from 'node:crypto';
import { httpError } from './http.mjs';

export const hasUnresolvedFocusSubmission = c => ['submitted', 'unknown'].includes(c.focusSubmission?.status);
export function assertFocusDraftAllowed(c) {
  if (hasUnresolvedFocusSubmission(c) || c.focusSubmission?.applying) throw httpError('上次专注提交尚待核对，请重试原请求后再提出新操作', 409, { code: 'FOCUS_SUBMISSION_UNRESOLVED' });
}

export function createFocusSubmissions({ api, save, onResolved = () => {} }) {
  const applying = new Set();
  const isApplying = c => applying.has(c.id);
  const lock = c => { if (isApplying(c)) throw httpError('正在核对专注提交，请等待结果', 409, { code: 'FOCUS_SUBMISSION_APPLYING' }); applying.add(c.id); };
  const resultMessage = submission => ({ id: randomUUID(), role: 'operation', requestId: submission.request.requestId, text: '已应用：' + submission.summary, action: submission.request.action, appliedVersion: submission.result.appliedVersion ?? submission.result.version, kind: 'focus' });
  async function submit(c, submission, notify = false) {
    submission.applying = true;
    let applied;
    try {
      applied = await api('focus/actions', submission.request);
      if (!applied || applied.ok !== true || !Number.isInteger(applied.version) || !Number.isInteger(applied.appliedVersion)) throw httpError('专注服务响应无法核对，请重试原请求', 502);
    } catch (error) {
      submission.status = error.status >= 400 && error.status < 500 ? 'needs_review' : 'unknown';
      submission.result = null;
      submission.error = { error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.status ? { status: error.status } : {}), ...(error.version !== undefined ? { version: error.version } : {}), ...(error.details ? { details: error.details } : {}) };
      if (submission.status === 'needs_review') {
        try { submission.latestState = await api('focus/state'); } catch { submission.latestState = null; }
      }
      submission.applying = false;
      try { save(c); }
      catch { submission.status = 'unknown'; throw httpError('提交结果未能保存，请保留原请求并核对', 503, { code: 'FOCUS_SUBMISSION_SAVE_FAILED' }); }
      throw error;
    }
    submission.status = 'applied'; submission.result = applied; submission.error = null; submission.latestState = null; submission.applying = false;
    const alreadyLogged = c.messages.some(message => message.role === 'operation' && message.requestId === submission.request.requestId);
    const message = alreadyLogged ? null : resultMessage(submission);
    if (message) c.messages.push(message);
    try { save(c); }
    catch {
      if (message) c.messages = c.messages.filter(value => value.id !== message.id);
      submission.status = 'unknown'; submission.result = null;
      submission.error = { code: 'FOCUS_SUBMISSION_SAVE_FAILED', error: '服务可能已应用，但对话结果未保存；请核对原请求' };
      throw httpError(submission.error.error, 503, { code: submission.error.code });
    }
    const result = { ok: true, status: 'applied', kind: 'focus', ...applied, action: submission.request.action, message: '用户已确认，专注操作已经保存成功。计时记录不会自动完成任务。' };
    if (notify) await onResolved(c, submission, result);
    return result;
  }
  async function apply(c, p, input) {
    if (input.action && JSON.stringify(input.action) !== JSON.stringify(p.action)) throw httpError('专注草稿不能改写，请取消后重新提出', 409);
    if (input.approve !== true) {
      if (c.focusSubmission?.id === p.id) throw httpError('该请求已批准提交，不能取消副作用，请核对原请求', 409);
      c.messages.push({ id: randomUUID(), role: 'operation', text: '已取消专注草稿', kind: 'focus' });
      return { ok: false, error: '用户取消了专注草稿，没有提交专注写入。' };
    }
    lock(c); p.applying = true;
    try {
      let submission = c.focusSubmission;
      if (submission?.id !== p.id) {
        assertFocusDraftAllowed(c);
        const request = { requestId: p.requestId, expectedVersion: p.version, ...(['focus.start', 'focus.switch'].includes(p.action.type) ? { expectedTaskVersion: p.taskVersion } : {}), ...(p.expiresAt !== undefined ? { expiresAt: p.expiresAt } : {}), action: structuredClone(p.action) };
        const before = c.focusSubmission;
        submission = { id: p.id, status: 'submitted', approvedAt: new Date().toISOString(), summary: p.summary, ...(p.impact ? { impact: structuredClone(p.impact) } : {}), request, result: null, applying: false };
        c.focusSubmission = submission; p.submitted = true;
        try { save(c); }
        catch { c.focusSubmission = before; p.submitted = false; throw httpError('批准记录未能保存，专注操作尚未提交', 503, { code: 'FOCUS_APPROVAL_SAVE_FAILED' }); }
      }
      if (submission.status === 'applied') return { ok: true, status: 'applied', kind: 'focus', ...submission.result };
      return await submit(c, submission);
    } finally { p.applying = false; if (c.focusSubmission) c.focusSubmission.applying = false; applying.delete(c.id); }
  }
  async function recover(c, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['id', 'action'].includes(key)) || !['retry', 'acknowledge'].includes(input.action) || typeof input.id !== 'string') throw httpError('核对只接受 id 和 retry/acknowledge');
    const submission = c.focusSubmission;
    if (!submission || submission.id !== input.id) throw httpError('专注提交已变化，请重新读取', 409);
    lock(c);
    try {
      if (input.action === 'acknowledge') {
        if (!['applied', 'needs_review'].includes(submission.status)) throw httpError('未知提交必须先核对原请求，不能直接取消', 409);
        const previous = submission.acknowledged;
        submission.acknowledged = true;
        const message = submission.status === 'needs_review' && !c.messages.some(value => value.requestId === submission.request.requestId) ? { id: randomUUID(), role: 'operation', requestId: submission.request.requestId, text: '已核对专注提交：' + (submission.error?.error || '原请求需要重新审阅') + '。此结果不能证明旧请求从未执行。', kind: 'focus', action: submission.request.action } : null;
        if (message) c.messages.push(message);
        try { save(c); } catch (error) { submission.acknowledged = previous; if (message) c.messages = c.messages.filter(value => value.id !== message.id); throw error; }
        await onResolved(c, submission, submission.status === 'applied' ? { ok: true, status: 'applied', kind: 'focus', ...submission.result } : { ok: false, status: 'needs_review', kind: 'focus', error: submission.error?.error || '原请求需要重新审阅；不能证明旧请求未执行。' });
        return { ok: true, acknowledged: true };
      }
      if (submission.acknowledged) throw httpError('该提交已确认，请读取当前状态后提出新操作', 409);
      if (submission.status === 'applied') { const result = { ok: true, status: 'applied', kind: 'focus', ...submission.result }; await onResolved(c, submission, result); return result; }
      return await submit(c, submission, true);
    } finally { submission.applying = false; applying.delete(c.id); }
  }
  return { apply, recover, isApplying };
}
