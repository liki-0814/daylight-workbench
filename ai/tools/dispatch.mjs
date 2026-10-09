import { randomUUID } from 'node:crypto';
import { localDate } from '../../public/model.js';
import { buildContext } from '../context.mjs';
import { httpError } from '../http.mjs';
import { validateAction, normalizeAction, impact } from '../drafts.mjs';
import { definitions } from './definitions.mjs';
import { assertFocusDraftAllowed } from '../focus-submissions.mjs';
import { assertExtensionDraftAllowed } from '../extensions-submissions.mjs';

export function createToolDispatch({ api, get, aiState, prepareAI, pending }) {
  async function tool(c, name, args = {}) {
    if (!definitions.some(t => t.name === name)) throw httpError('未知工作台工具');
    if (['daylight_get_extensions', 'daylight_diagnose_extensions'].includes(name)) {
      if (!args || Object.keys(args).length) throw httpError('扩展清单查询不接受参数');
      return api(name === 'daylight_get_extensions' ? 'extensions/state' : 'extensions/diagnostics');
    }
    if (name === 'daylight_get_extension') {
      if (!args || Object.keys(args).some(key => !['id', 'file'].includes(key)) || typeof args.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(args.id) || args.file !== undefined && typeof args.file !== 'string') throw httpError('需要真实扩展 ID 和可选文件路径');
      return api('extensions/objects/' + args.id, undefined, args.file ? { file: args.file } : undefined);
    }
    if (name === 'daylight_propose_extension_changes') {
      if (!args || Object.keys(args).some(key => !['summary', 'action'].includes(key)) || typeof args.summary !== 'string' || !args.summary.trim()) throw httpError('需要扩展变更说明与明确动作');
      assertExtensionDraftAllowed(c);
      const plan = await api('extensions/prepare', { action: args.action });
      assertExtensionDraftAllowed(c);
      if (plan.conflicts?.length) return { ok: false, status: 'conflict', ...plan };
      return pending(c, { type: 'extensionChanges', summary: args.summary, action: plan.normalizedAction, plan, requestId: randomUUID(), impact: plan.impact });
    }
    const reads = {daylight_get_calendar:'calendar',daylight_get_focus:'focus/state',daylight_get_focus_statistics:'focus/statistics',daylight_get_focus_sessions:'focus/sessions',daylight_get_task_focus_summary:'focus/task-summary'};
    if (reads[name]) {
      const definition=definitions.find(t=>t.name===name),allowed=Object.keys(definition.inputSchema.properties);
      if (!args || typeof args!=='object' || Array.isArray(args) || Object.keys(args).some(key=>!allowed.includes(key))) throw httpError('查询包含未知字段');
      const params=Object.fromEntries(Object.entries(args).filter(([key,value])=>value!==undefined&&!(key==='unassigned'&&value===false)).map(([key,value])=>[key,key==='unassigned'&&value===true?'1':value]));
      return api(reads[name],undefined,params);
    }
    if (name === 'daylight_propose_focus_changes') {
      if (!args || Object.keys(args).some(key=>!['summary','action'].includes(key)) || typeof args.summary!=='string' || !args.summary.trim()) throw httpError('需要专注动作和变更说明');
      assertFocusDraftAllowed(c);
      await api('focus/state');
      const prepared=await api('focus/prepare',{action:args.action});
      assertFocusDraftAllowed(c);
      return pending(c,{type:'focusChanges',summary:args.summary,action:prepared.normalizedAction,version:prepared.focusVersion,taskVersion:prepared.taskVersion,requestId:randomUUID(),...(prepared.expiresAt===undefined?{}:{expiresAt:prepared.expiresAt}),impact:prepared.impact});
    }
    if (name === 'daylight_get_configuration') return api('proxy/read', args);
    if (name === 'daylight_get_ai') return args.conversationId ? {conversation:get(args.conversationId)} : aiState();
    if (name === 'daylight_propose_ai_changes') {
      if(typeof args.summary!=='string'||!args.summary.trim())throw httpError('需要说明拟变更内容');
      const snapshot=aiState(), action=await prepareAI(args.action);
      return pending(c,{type:'aiChanges',summary:args.summary,action,version:snapshot.version,requestId:randomUUID(),impact:action.type==='ai.conversation.delete'?[`删除「${get(action.id).title}」的全部聊天记录，无法撤销。已创建的项目、任务及其他对话中的引用快照保留。`]:[]});
    }
    if (name === 'daylight_get_proxy') return api('proxy/state');
    if (name === 'daylight_discover_proxy_models') return api('proxy/discover', {sourceId:args.sourceId});
    if (name === 'daylight_get_proxy_requests') return api('proxy/requests', {limit:args.limit});
    if (name === 'daylight_get_proxy_login') return api('proxy/loginState', {sourceId:args.sourceId});
    if (name === 'daylight_test_proxy') return api('proxy/test', {sourceId:args.sourceId});
    if (name === 'daylight_propose_proxy_changes') {
      if(typeof args.summary !== 'string'||!args.summary.trim())throw httpError('需要说明拟变更内容');
      const snapshot=await api('proxy/state');
      const prepared=await api('proxy/prepare',{action:args.action});
      return pending(c,{type:'proxyChanges',summary:args.summary,...prepared,version:prepared.version||snapshot.version,requestId:randomUUID()});
    }
    if (name === 'daylight_get_context') return buildContext(c, {}, await api('state'));
    if (name === 'daylight_get_workspace') return api('state');
    if (name === 'daylight_ask_user') {
      if (typeof args.question !== 'string' || !args.question.trim()) throw httpError('问题不能为空');
      return { answer: await pending(c, { type: 'question', question: args.question }) };
    }
    if (typeof args.summary !== 'string' || !args.summary.trim()) throw httpError('需要说明拟变更内容');
    const snapshot = await api('state');
    const day = args.day || snapshot.localDate || localDate();
    args.action = normalizeAction(args.action);
    validateAction(snapshot.state, args.action, day);
    return pending(c, { type: 'changes', summary: args.summary, action: args.action, day, version: snapshot.version, requestId: randomUUID(), impact: impact(snapshot.state, args.action) });
  }
  return tool;
}
