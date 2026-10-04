import { randomUUID } from 'node:crypto';
import { localDate } from '../../public/model.js';
import { buildContext } from '../context.mjs';
import { httpError } from '../http.mjs';
import { validateAction, normalizeAction, impact } from '../drafts.mjs';
import { definitions } from './definitions.mjs';

export function createToolDispatch({ api, get, aiState, prepareAI, pending }) {
  async function tool(c, name, args = {}) {
    if (!definitions.some(t => t.name === name)) throw httpError('未知工作台工具');
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
