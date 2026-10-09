import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeScope, scopeInfo, relatedReasons } from './context.mjs';
import { isActive } from './run-manager.mjs';
import { httpError } from './http.mjs';
import { hasUnresolvedFocusSubmission } from './focus-submissions.mjs';
import { hasUnresolvedExtensionSubmission } from './extensions-submissions.mjs';

export function createConversations({ store, providers, api, isRunning, isFocusApplying = () => false, isExtensionApplying = () => false }) {
  const catalogs = store.read('catalogs.json', {}), discoveries = new Map();
  async function discover(backend, config, force = false) {
    const key = JSON.stringify([backend, config.path || '']);
    if (!force && catalogs[key] && (backend !== 'qoder' || Array.isArray(catalogs[key].skills))) return catalogs[key];
    if (discoveries.has(key)) return discoveries.get(key);
    const pending = providers[backend].discover(config, store.workspace(backend)).then(result => {
      const cached = { ...result, discoveredAt: new Date().toISOString() };
      for (const alias of Object.keys(catalogs)) if (JSON.parse(alias)[0] === backend && result.path && catalogs[alias].path === result.path) catalogs[alias] = cached;
      catalogs[key] = cached;
      if (result.path) catalogs[JSON.stringify([backend, result.path])] = cached;
      store.write('catalogs.json', catalogs);
      return cached;
    }).finally(() => discoveries.delete(key));
    discoveries.set(key, pending); return pending;
  }
  const get = id => { const c = store.conversations.get(id); if (!c) throw httpError('对话不存在', 404); return c; };
  function save(c) { store.save(c); }
  function aiState() {
    const conversations=[...store.conversations.values()].map(c=>({id:c.id,title:c.title,backend:c.backend,config:c.config,scope:c.scope||{kind:'workspace'},status:c.status,updatedAt:c.updatedAt,messageCount:c.messages.length}));
    const settings=structuredClone(store.settings);
    const version=createHash('sha256').update(JSON.stringify({settings,conversations:conversations.map(({status,updatedAt,messageCount,...metadata})=>metadata)})).digest('hex');
    return{version,settings,conversations};
  }
  async function newConversation(input={}) {
    const backend=store.settings.backend,config=structuredClone(store.settings[backend]);
    if(input.model&&input.model!==config.model){config.model=input.model;config.effort='';config.contextWindow=null;}
    if(!config.model)throw httpError('请先在设置中选择并保存 AI 模型');
    const catalog=await discover(backend,config),model=catalog.models.find(m=>m.id===config.model);
    if(!model)throw httpError('所选模型当前不可用，请在设置中重新检测');
    if(config.effort&&!model.efforts.includes(config.effort))throw httpError('所选模型不支持该思考强度，请重新设置');
    if(config.contextWindow&&!model.contextWindows?.length&&model.maxInputTokens&&config.contextWindow>model.maxInputTokens)throw httpError('上下文窗口超过模型已知上限');
    if(config.contextWindow&&model.contextWindows?.length&&!model.contextWindows.includes(config.contextWindow))throw httpError('该模型不支持指定的上下文档位');
    const scope=normalizeScope(input.scope,(await api('state')).state);
    return{id:randomUUID(),scope,scopeVersion:0,title:'新对话',backend,config,sessionId:null,status:'idle',messages:[],pending:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  }
  async function prepareAI(action) {
    const fields={'ai.settings':['type','settings'],'ai.conversation.create':['type','scope'],'ai.conversation.model':['type','id','model'],'ai.conversation.scope':['type','id','scope'],'ai.conversation.delete':['type','id','expectedUpdatedAt']};
    if(!action||!fields[action.type]||Object.keys(action).some(k=>!fields[action.type].includes(k)))throw httpError('AI 管理操作或字段无效');
    const a=structuredClone(action);
    if(a.type==='ai.settings')a.settings=validateSettings(a.settings);
    else if(a.type==='ai.conversation.create')await newConversation(a);
    else {
      const target=get(a.id);
      if(isActive(target)||isRunning(target.id))throw httpError('请先结束目标对话的生成或待确认内容',409);
      if(a.type==='ai.conversation.delete') {
        if (hasUnresolvedExtensionSubmission(target) || isExtensionApplying(target)) throw httpError('扩展提交尚待核对，不能删除对话', 409, { code: 'EXTENSION_SUBMISSION_UNRESOLVED' });
        if (hasUnresolvedFocusSubmission(target) || isFocusApplying(target)) throw httpError('专注提交尚待核对，不能删除对话', 409, { code: 'FOCUS_SUBMISSION_UNRESOLVED' });
        if(typeof a.expectedUpdatedAt!=='string'||a.expectedUpdatedAt!==target.updatedAt)throw httpError('对话内容已变化，请重新读取并确认删除',409);
      }
      else if(a.type==='ai.conversation.scope')a.scope=normalizeScope(a.scope,(await api('state')).state);
      else if(!(await discover(target.backend,target.config)).models.some(m=>m.id===a.model))throw httpError('模型不可用');
    }
    return a;
  }
  async function applyAI(p) {
    const receipts=store.read('management-receipts.json',[]),receipt=receipts.find(r=>r.id===p.requestId);
    if(receipt){if(JSON.stringify(receipt.action)!==JSON.stringify(p.action))throw httpError('请求已用于其他操作',409);return receipt.result;}
    if(aiState().version!==p.version)throw httpError('AI 设置或会话已变化，请重新核对',409);
    const action=await prepareAI(p.action);
    const created=action.type==='ai.conversation.create'?await newConversation(action):null;
    if(aiState().version!==p.version)throw httpError('AI 设置或会话已变化，请重新核对',409);
    if(action.type==='ai.settings'){store.write('settings.json',action.settings);store.settings=action.settings;}
    else if(created)save(created);
    else {
      const target=get(action.id);
      if(isActive(target)||isRunning(target.id))throw httpError('目标会话正在运行',409);
      if(action.type==='ai.conversation.delete') {
        if (hasUnresolvedExtensionSubmission(target) || isExtensionApplying(target)) throw httpError('扩展提交尚待核对，不能删除对话', 409, { code: 'EXTENSION_SUBMISSION_UNRESOLVED' });
        if (hasUnresolvedFocusSubmission(target) || isFocusApplying(target)) throw httpError('专注提交尚待核对，不能删除对话', 409, { code: 'FOCUS_SUBMISSION_UNRESOLVED' });
        if(target.updatedAt!==action.expectedUpdatedAt)throw httpError('对话内容已变化，请重新读取并确认删除',409);
        store.remove(target.id);
      }
      else if(action.type==='ai.conversation.model'){target.config.model=action.model;target.config.effort='';target.config.contextWindow=null;}
      else {target.scope=action.scope;target.scopeVersion=(target.scopeVersion||0)+1;}
      if(action.type!=='ai.conversation.delete')save(target);
    }
    const result={ok:true,status:'applied',action,...(created?{conversationId:created.id}:{})};
    store.write('management-receipts.json',[...receipts,{id:p.requestId,action:p.action,result}].slice(-100));
    return result;
  }

  async function list(url) {
    const workspace = await api('state');
    const target = url.searchParams.has('scope') ? normalizeScope({ kind: url.searchParams.get('scope'), id: url.searchParams.get('scopeId') }, workspace.state, false) : null;
    const related = url.searchParams.get('related') === '1';
    const conversations = [...store.conversations.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(c => {
      const reasons = target ? relatedReasons(c, target, workspace.state) : [];
      const { messages, ...rest } = c;
      return { ...rest, scope: c.scope || { kind: 'workspace' }, scopeVersion: c.scopeVersion || 0, scopeInfo: scopeInfo(c.scope, workspace.state), messageCount: messages.length, relatedReasons: reasons };
    }).filter(c => !target || (related ? c.relatedReasons.length : c.scope.kind === target.kind && c.scope.id === target.id));
    return { conversations };
  }
  async function detail(c) {
    return { ...c, scope: c.scope || { kind: 'workspace' }, scopeVersion: c.scopeVersion || 0, scopeInfo: scopeInfo(c.scope, (await api('state')).state) };
  }
  async function setScope(c, input) {
    if (isRunning(c.id) || isActive(c)) throw httpError('请先结束当前生成或处理待确认内容', 409);
    const scope = normalizeScope(input.scope, (await api('state')).state);
    if (isRunning(c.id) || isActive(c)) throw httpError('对话正在运行', 409);
    const revision = c.scopeVersion || 0;
    if (!Number.isInteger(input.expectedScopeVersion) || input.expectedScopeVersion < 0) throw httpError('需要 expectedScopeVersion');
    if (input.expectedScopeVersion !== revision) {
      if (revision !== input.expectedScopeVersion + 1 || JSON.stringify(c.scope) !== JSON.stringify(scope)) throw httpError('会话关联已变化，请重新读取', 409);
    } else { c.scope = scope; c.scopeVersion = revision + 1; save(c); }
  }
  async function setModel(c, input) {
    if (isRunning(c.id)) throw httpError('请先停止生成再切换模型', 409);
    const catalog = await discover(c.backend, c.config);
    if (isRunning(c.id)) throw httpError('对话正在运行，请稍后再切换', 409);
    if (!catalog.models.some(m => m.id === input.model)) throw httpError('模型不可用');
    c.config.model = input.model; c.config.effort = ''; c.config.contextWindow = null;
    save(c);
  }
  function settings(input) {
    if (input) { store.settings = validateSettings(input); store.write('settings.json', store.settings); }
    return { settings: store.settings };
  }
  return { get, save, aiState, newConversation, prepareAI, applyAI, discover, list, detail, setScope, setModel, settings };
}

export function validateSettings(input) {
  if (!['codex', 'qoder'].includes(input.backend)) throw httpError('请选择 Codex 或 Qoder');
  const next = { backend: input.backend };
  for (const backend of ['codex', 'qoder']) {
    const s = input[backend] || {};
    if (s.path && (!path.isAbsolute(s.path) || /[\r\n]/.test(s.path))) throw httpError('CLI 路径必须为绝对路径');
    if (typeof s.model !== 'string' || s.model.length > 200) throw httpError('模型名称无效');
    if (s.effort && !['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(s.effort)) throw httpError('思考强度无效');
    if (s.accessMode !== undefined && !['standard', 'full'].includes(s.accessMode)) throw httpError('访问模式无效');
    next[backend] = { path: s.path || '', model: s.model.trim(), effort: s.effort || '', contextWindow: positive(s.contextWindow), accessMode: s.accessMode || 'standard' };
    if (backend === 'qoder') next[backend].maxOutputTokens = positive(s.maxOutputTokens);
  }
  return next;
}
function positive(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); if (!Number.isSafeInteger(n) || n <= 0 || n > 10_000_000) throw httpError('Token 数必须为 1–10000000 的整数'); return n; }
