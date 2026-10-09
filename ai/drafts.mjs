import { randomUUID } from 'node:crypto';
import { applyAction } from '../agent-api.mjs';
import { httpError } from './http.mjs';
import { isCivilDate } from '../core/date.js';

export function createDrafts({ api, applyAI, save, focusSubmissions, extensionSubmissions }) {
  async function apply(c, p, input) {
    let result;
    if (p.type === 'focusChanges') return focusSubmissions.apply(c, p, input);
    if (p.type === 'extensionChanges') return extensionSubmissions.apply(c, p, input);
    if(p.type === 'aiChanges' && input.approve === true) {
      if(input.action&&JSON.stringify(input.action)!==JSON.stringify(p.action))throw httpError('AI 草稿发生变化，请重新生成',409);
      p.applying=true;
      try {result=await applyAI(p);c.messages.push({id:randomUUID(),role:'operation',text:'已应用：'+p.summary,action:p.action});}
      finally {p.applying=false;}
    } else if(p.type === 'proxyChanges' && input.approve === true) {
      if(input.action&&JSON.stringify(input.action)!==JSON.stringify(p.action))throw httpError('代理草稿发生变化，请重新生成',409);
      p.applying=true;
      try {
        const applied=await api('proxy/apply',{requestId:p.requestId,expectedVersion:p.version,action:p.action,...(input.apiKey?{apiKey:input.apiKey}:{}),...(input.apiKeys?{apiKeys:input.apiKeys}:{})});
        result={ok:true,status:applied.login?.status||'applied',action:applied.action,...(applied.login?{login:applied.login}:{}),message:applied.login?'网页登录已启动，请按返回状态提示用户完成授权，再检查登录状态。':'用户已确认，配置变更实际完成。凭据不返回给模型。'};
        c.messages.push({id:randomUUID(),role:'operation',text:'已应用：'+p.summary,action:applied.action});
      } finally {p.applying=false;}
    } else if (input.approve === true) {
      const action = input.action || p.action;
      if (p.submitted && JSON.stringify(action) !== JSON.stringify(p.action)) throw httpError('上次提交结果未知，只能重试原操作或重新读取核对', 409);
      p.applying = true;
      try {
      if (!p.submitted) {
        const s = await api('state'); if (s.version !== p.version) throw httpError('工作台已发生变化，请取消此草稿并重新生成', 409);
        validateAction(s.state, action, p.day); p.action = action; p.submitted = true; save(c);
      }
      const applied = await api('actions', { requestId: p.requestId, expectedVersion: p.version, day: p.day, action: p.action }); result = { ok: true, status: 'applied', message: '用户已经在界面确认并应用，变更已经实际保存成功。请明确告知已完成，不要再说尚未保存或等待应用。', version: applied.version, action: p.action }; }
      finally { p.applying = false; }
      c.messages.push({ id: randomUUID(), role: 'operation', text: '已应用：' + p.summary, action: p.action, day: p.day, appliedVersion: result.version });
    } else { result = { ok: false, error: '用户取消了草稿，请先询问或修改方案，不要重复提交。' }; c.messages.push({ id: randomUUID(), role: 'operation', text: '已取消变更草稿' }); }
    return result;
  }
  return { apply };
}

export function validateAction(state, action, day) {
  if (!isCivilDate(day)) throw httpError('日期无效');
  if (action?.type === 'undo') return;
  applyAction(state, action, day);
}
export function impact(state, action) {
  const list = action.type === 'batch' ? action.actions : [action];
  return list.flatMap(a => {
    if (a.type === 'project.delete') { const p = state.projects.find(p => p.id === a.id); return [`删除项目「${p?.name || a.id}」及其 ${state.tasks.filter(t => t.projectId === a.id).length} 个任务（包括已完成任务），本地目录不会删除。`]; }
    if (a.type === 'plan.reschedule') return [`将任务「${state.tasks.find(t => t.id === a.id)?.title || a.id}」从 ${a.fromDay} 改到 ${a.toDay}，其余安排和执行状态不变。`];
    if (a.type === 'task.create' && a.planDay) return [`新任务安排到 ${a.planDay}。`];
    if (a.type.startsWith('plan.') && a.day) return [`日期安排：${a.day}。`];
    return [];
  });
}
export function normalizeAction(action) {
  if (!action || typeof action !== 'object') return action;
  const a = structuredClone(action);
  if (a.type === 'batch' && Array.isArray(a.actions)) a.actions = a.actions.map(normalizeAction);
  if (['task.create', 'project.create'].includes(a.type) && !a.id) a.id = randomUUID();
  return a;
}
