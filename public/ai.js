import { actionLinks } from './components/action-links.js';
import { conversationRoute } from './routes.js';
import { markdown, processMessage } from './components/ai-message.js';
import { selectField } from './components/select.js';
import { focusDraftCard, focusSubmissionCard } from './focus/draft-card.js';
import { extensionDraftCard, extensionSubmissionCard } from './extensions/review.js';
import { extensionsRoute } from './routes.js';
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const running = c => c && ['running', 'waiting'].includes(c.status);
export function createAIPage({ getToken, onChanged }) {
  const element = document.createElement('main'); element.className = 'ai-page';
  element.innerHTML = `<header class="topbar"><span>我的工作空间 <span class="slash">/</span> AI 对话</span></header>
    <div class="workspace ai-workspace">
    <div class="ai-layout"><aside class="ai-history"><div class="ai-history-heading"><div class="ai-history-title"><h1>AI 对话</h1><button class="ai-new" type="button" aria-label="新建对话" title="新建对话">＋</button></div><p>先把事情说清楚，再一起推进</p></div><div class="ai-history-filters"><button type="button" data-history-filter="all" class="chosen">全部</button><button type="button" data-history-filter="related">当前关联</button></div><nav aria-label="历史对话" class="ai-history-list"></nav></aside>
    <section class="ai-chat" aria-label="AI 对话"><div class="ai-chat-toolbar"><div><span class="ai-chat-meta"></span><div class="ai-association"></div></div><div class="ai-toolbar-actions"><button type="button" class="text-button" data-bind-scope>关联对象</button><a class="text-button ai-return" href="#tasks">返回任务</a><a class="text-button" href="#settings">AI 设置</a></div></div><div class="ai-scope-editor" hidden></div><div class="ai-messages"></div><div class="ai-pending"></div><p class="ai-error" role="alert"></p><span class="ai-status" role="status"></span><form class="ai-composer"><label class="sr-only" for="ai-message">发送消息</label><div class="ai-references"></div><div class="ai-mention-menu" hidden></div><textarea id="ai-message" rows="2" placeholder="@ 引用项目、任务或对话 · / 引用技能" maxlength="30000"></textarea><div class="ai-composer-footer"><div class="ai-model-holder">${selectField({name:'model',label:'模型',id:'ai-model',options:[{value:'',label:'正在读取模型…'}],compact:true,hideLabel:true})}</div><div class="ai-send-actions"><button class="ai-stop" type="button" aria-label="停止生成" title="停止生成" hidden>■</button><button class="primary ai-send" type="submit" aria-label="发送消息" title="发送消息"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-7 7 7-7 7 7"/></svg></button></div></div></form></section></div></div>`;
  element.insertAdjacentHTML('beforeend', `<dialog class="ai-delete-dialog" aria-labelledby="ai-delete-title"><form><div class="dialog-header"><h2 id="ai-delete-title">删除这段对话？</h2></div><div class="form-body"><p class="delete-name"></p><p class="field-note">全部聊天记录将被删除，无法撤销。已创建的项目、任务和其他对话中的引用快照会保留。</p><p class="dialog-error" role="alert"></p></div><div class="dialog-footer"><button type="button" class="secondary" data-delete-cancel autofocus>取消</button><button type="submit" class="secondary danger-button">删除对话</button></div></form></dialog>`);
  const $ = s => element.querySelector(s);
  let deleteTarget = null, deleting = false, historyMarkup = '', lastHistoryRead = 0;
  function resetConversation() {
    current=null; viewContext=undefined; selectedScope={kind:'workspace'}; pendingId=null; lastMessages='';
    history.replaceState(null,'','/#ai'); restoreComposer(); closeMentions(); renderPending(null); error(null); paint();
  }
  $('[data-delete-cancel]').addEventListener('click',()=>$('.ai-delete-dialog').close());
  $('.ai-delete-dialog').addEventListener('cancel',e=>{if(deleting)e.preventDefault();});
  $('.ai-delete-dialog').addEventListener('close',()=>{deleteTarget=null;});
  $('.ai-delete-dialog form').addEventListener('submit',async e=>{
    e.preventDefault(); if(deleting||!deleteTarget)return;
    const target=deleteTarget; deleting=true;
    $('.ai-delete-dialog').querySelectorAll('button').forEach(b=>b.disabled=true);
    try {
      if(!target.request){const snapshot=await api('/state');target.request={requestId:crypto.randomUUID(),expectedVersion:snapshot.version,action:{type:'ai.conversation.delete',id:target.id,expectedUpdatedAt:target.updatedAt}};}
      await api('/actions',target.request);
      composerDrafts.delete(target.id);
      references=references.filter(r=>r.id!==target.id);
      for(const draft of composerDrafts.values())draft.references=draft.references.filter(r=>r.id!==target.id);
      if(current?.id===target.id)resetConversation(); else paintReferences();
      $('.ai-delete-dialog').close(); await list(); onChanged?.();
      if(!current)$('#ai-message').focus();
    } catch(e) { $('.ai-delete-dialog .dialog-error').textContent=e.message; }
    finally {deleting=false;$('.ai-delete-dialog').querySelectorAll('button').forEach(b=>b.disabled=false);}
  });
  let visible = false, current = null, timer, polling = false, busy = false, lastMessages = '', pendingId = null, defaults = null, catalog = [], loadingModels = false, conversations = [], references = [], mentionOpen = false, skillCatalog = [], skills = [], mentionType = '@';
  let selectedScope = {kind:'workspace'}, extensionReferences = [], objectReferences = [], workspace = {projects:[],tasks:[]}, historyFilter = 'all', returnHash = '#tasks', viewContext, opening = 0, openingReference = false;
  const composerDrafts = new Map();
  const draftKey = () => current?.id || 'new:' + selectedScope.kind + ':' + (selectedScope.id || '');
  function saveComposer() { composerDrafts.set(draftKey(), {text:$('#ai-message').value,references:[...references],skills:[...skills],objectReferences:[...objectReferences],extensionReferences:[...extensionReferences]}); }
  function restoreComposer() { const draft=composerDrafts.get(draftKey()); $('#ai-message').value=draft?.text || ''; references=draft?.references || []; skills=draft?.skills || []; objectReferences=draft?.objectReferences || []; extensionReferences=draft?.extensionReferences || []; paintReferences(); resizeInput(); }
  async function loadWorkspace() { const r=await fetch('/api/state'); const data=await r.json(); if (!r.ok) throw new Error(data.error); workspace=data.state; }
  const objectLabel = ref => ref.kind === 'project' ? workspace.projects.find(p=>p.id===ref.id)?.name || '项目已删除' : workspace.tasks.find(t=>t.id===ref.id)?.title || '任务已删除';
  const api = async (route, data) => {
    const res = await fetch('/api/ai' + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': getToken() }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const result = await res.json(); if (!res.ok) throw Object.assign(new Error(result.error || 'AI 请求失败'),{...result,status:res.status}); return result;
  };
  const error = e => { $('.ai-error').textContent = e?.message || ''; };
  function paint() {
    const c = current;
    const scope = c?.scope || selectedScope;
    const label = c?.scopeInfo?.label || (scope.kind === 'workspace' ? '工作台' : objectLabel(scope));
    const exists = c?.scopeInfo?.exists ?? (scope.kind === 'workspace' || workspace[scope.kind === 'project' ? 'projects' : 'tasks'].some(o=>o.id===scope.id));
    $('.ai-association').innerHTML = scope.kind === 'workspace' ? '<span class="muted">通用对话</span>' : `${exists ? `<a href="#${scope.kind}=${encodeURIComponent(scope.id)}">${esc(label)}</a>` : `<span class="muted">${esc(label)}</span>`}${c?.scopeInfo?.projectName ? `<small> · ${esc(c.scopeInfo.projectName)}</small>` : ''}`;
    $('.ai-return').href=returnHash; $('.ai-return').textContent=returnHash.startsWith('#extensions')?'返回扩展管理':'返回任务';
    $('[data-bind-scope]').disabled=busy || openingReference || running(c);
    $('.ai-chat-meta').textContent = c ? `${c.backend === 'codex' ? 'Codex' : 'Qoder'}${c.config.effort ? ' · ' + c.config.effort : ''}` : defaults ? `${defaults.backend === 'codex' ? 'Codex' : 'Qoder'} · 新对话` : '正在读取设置';
    const messages = JSON.stringify(c?.messages || []);
    if (messages !== lastMessages || !$('.ai-messages').childElementCount) {
      const nearBottom = document.documentElement.scrollHeight - innerHeight - scrollY < 220;
      const disclosures = new Map([...$('.ai-messages').querySelectorAll('[data-disclosure]')].map(el => [el.dataset.disclosure,el.open]));
      lastMessages = messages;
      $('.ai-messages').innerHTML = c?.messages.length ? c.messages.map(m => m.role === 'process' ? processMessage(m) : `<article class="ai-message ai-${esc(m.role)}">${m.role === 'operation' ? '<div class="ai-message-label">工作台</div>' : ''}<div class="ai-message-text ${m.role === 'assistant' ? 'ai-markdown' : ''}">${m.role === 'assistant' ? markdown(m.text) : esc(m.text)}</div>${m.references?.length ? `<div class="ai-source-links">${m.references.map(r => `<button type="button" class="text-button" data-conversation="${esc(r.id)}">@ ${esc(r.title)}</button>`).join('')}</div>` : ''}${m.context?.objectReferences?.length ? `<div class="ai-source-links">${m.context.objectReferences.map(r=>`<a class="text-button" href="#${r.kind}=${encodeURIComponent(r.id)}">@ ${esc(r.label)}</a>`).join('')}</div>` : ''}${m.context?.extensionReferences?.length ? `<div class="ai-source-links">${m.context.extensionReferences.map(ref=>`<a class="text-button" href="${extensionsRoute({tab:ref.kind==='mcp'?'mcp':ref.kind==='client'?'clients':'skills',id:ref.id})}">扩展 · ${esc(ref.name || ref.id)}</a>`).join('')}</div>` : ''}${m.skills?.length ? `<div class="ai-source-links">${m.skills.map(s => `<span class="muted">/ ${esc(s.name)}</span>`).join('')}</div>` : ''}${m.action ? actionLinks(m.action,m.day) : ''}</article>`).join('') : `<div class="ai-welcome"><span class="ai-orbit">✳</span><h2>把想法变成下一步</h2><p>可以一起梳理项目、完善任务内容，或安排今天。<br>不清楚的地方先问你，变更审阅后再保存。</p><div class="ai-suggestions"><button type="button" data-prompt="先查看我的项目和任务，帮我梳理下一步。不要直接创建任务，有不清楚的先问我。">梳理项目</button><button type="button" data-prompt="帮我安排今天。先了解我的时间和优先级，再给出建议。">安排今天</button></div></div>`;
      $('.ai-messages').querySelectorAll('[data-disclosure]').forEach(el => { if (disclosures.has(el.dataset.disclosure)) el.open=disclosures.get(el.dataset.disclosure); });
      if (nearBottom && c?.messages.length && visible) requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
    }
    const pendingKey=JSON.stringify([c?.pending?.id || null, ...['focusSubmission','extensionSubmission'].map(key=>c?.[key]&&!c[key].acknowledged?[c[key].id,c[key].status,c[key].error,c[key].result]:null)]);
    if (pendingKey !== pendingId) { pendingId = pendingKey; renderPending(c?.pending); }
    $('.ai-stop').hidden = !running(c);
    $('.ai-send').disabled = busy || openingReference || running(c);
    $('.ai-new').disabled = busy || openingReference;
    $('#ai-model').disabled = busy || openingReference || running(c) || loadingModels;
    if (c && catalog.some(m => m.id === c.config.model)) $('#ai-model').value = c.config.model;
    $('.ai-status').textContent = openingReference ? '正在关联扩展…' : c?.status === 'waiting' ? '等待你的回答或确认' : c?.status === 'running' ? c.activity || '正在思考…' : '';
    if (c?.error) $('.ai-error').textContent = c.error;
  }
  function renderPending(p) {
    const submission=current?.focusSubmission, recovery=submission&&!submission.acknowledged?focusSubmissionCard(submission,workspace):'', extension=current?.extensionSubmission, extensionRecovery=extensionSubmissionCard(extension);
    if (extensionRecovery && (!p || p.type==='extensionChanges'&&p.id===extension.id)) { $('.ai-pending').innerHTML=recovery+extensionRecovery; return; }
    if (p?.type==='extensionChanges') { $('.ai-pending').innerHTML=recovery+extensionRecovery+extensionDraftCard(p); return; }
    if (recovery && (!p || p.type==='focusChanges'&&p.id===submission.id)) { $('.ai-pending').innerHTML=extensionRecovery+recovery; return; }
    if (p?.type==='focusChanges') { $('.ai-pending').innerHTML=extensionRecovery+recovery+focusDraftCard(p,workspace); return; }
    if (!p) { $('.ai-pending').innerHTML=extensionRecovery; return; }
    if (p.type === 'permission') $('.ai-pending').innerHTML = `<div class="ai-card"><h3>${current?.backend === 'qoder' ? 'Qoder' : 'Codex'} 请求确认</h3><p>${esc(p.question)}</p><pre class="ai-permission-details">${esc(p.details)}</pre><div class="ai-card-actions"><button type="button" class="secondary" data-reject>拒绝</button><button type="button" class="primary" data-apply>允许本次</button></div></div>`;
    else if (['proxyChanges','aiChanges'].includes(p.type)) $('.ai-pending').innerHTML = `<div class="ai-card"><h3>审阅配置变更</h3><p>${esc(p.summary)}</p>${(p.impact||[]).map(t=>`<p class="ai-impact">${esc(t)}</p>`).join('')}<details open><summary>配置详情</summary><pre class="ai-permission-details">${esc(JSON.stringify(p.action,null,2))}</pre></details>${(p.requiresKeys?.length?p.requiresKeys:p.requiresKey?[{id:'default',label:'API Key'}]:[]).map(k=>`<label>${esc(k.label)}<input type="password" data-proxy-key-id="${esc(k.id)}" autocomplete="new-password" placeholder="安全填写，不会进入对话" required></label>`).join('')}<div class="ai-card-actions"><button type="button" class="secondary" data-reject>取消草稿</button><button type="button" class="primary" data-apply>应用变更</button></div><small>配置变化后需要重新核对。连接测试不发送推理请求。</small></div>`;
    else if (p.type === 'question') $('.ai-pending').innerHTML = `<form class="ai-answer-form ai-card"><h3>需要你补充</h3><p>${esc(p.question)}</p><label>你的回答<textarea name="answer" rows="3" required maxlength="10000"></textarea></label><button class="primary" type="submit">继续</button></form>`;
    else {
      const list = p.action.type === 'batch' ? p.action.actions : [p.action];
      $('.ai-pending').innerHTML = `<div class="ai-card"><h3>审阅变更</h3><p>${esc(p.summary)}</p>${p.impact.map(t => `<p class="ai-impact">${esc(t)}</p>`).join('')}<div class="ai-draft-fields">${list.map((a, i) => `<div class="ai-draft-item"><strong>${esc(actionLabel(a.type))}</strong>${Object.entries(a).filter(([k]) => ['title', 'name', 'notes', 'path'].includes(k)).map(([k, v]) => `<label>${{title:'任务标题',name:'项目名称',notes:'任务内容',path:'关联目录'}[k]}<${k === 'notes' ? 'textarea rows="4"' : 'input type="text"'} data-index="${i}" data-field="${k}" ${k === 'notes' ? '' : `value="${esc(v)}"`}>${k === 'notes' ? esc(v) + '</textarea>' : ''}</label>`).join('')}${['task.create','task.update'].includes(a.type) ? `<div class="ai-draft-project">${selectField({name:'draft-project-'+i,label:'所属项目',value:(a.projectId === undefined ? workspace.tasks.find(t=>t.id===a.id)?.projectId : a.projectId) || '',options:[{value:'',label:'未归类'},...workspace.projects.map(p=>({value:p.id,label:p.name}))]})}</div>` : ''}<p class="muted">${esc(a.type==='task.status' ? '状态：'+ ({todo:'待办',active:'进行中',done:'已完成'}[a.status] || a.status) : a.type==='plan.reschedule' ? '改期：'+a.fromDay+' → '+a.toDay : a.type.startsWith('plan.') ? '安排日期：'+(a.day || p.day) : a.type==='task.create'&&a.planDay ? '安排日期：'+a.planDay : '')}</p><details><summary>操作详情</summary><pre>${esc(JSON.stringify(a, null, 2))}</pre></details></div>`).join('')}</div><div class="ai-card-actions"><button type="button" class="secondary" data-reject>取消草稿</button><button type="button" class="primary" data-apply>应用变更</button></div><small>工作台发生变化时会要求重新核对。应用后可撤销最近一次操作。</small></div>`;
    }
    if(extensionRecovery) $('.ai-pending').insertAdjacentHTML('afterbegin',extensionRecovery);
    if(current?.focusSubmission && !current.focusSubmission.acknowledged) $('.ai-pending').insertAdjacentHTML('afterbegin',focusSubmissionCard(current.focusSubmission,workspace));
  }
  async function loadModels() {
    loadingModels = true; paint();
    try {
      defaults = (await api('/settings')).settings;
      const backend = current?.backend || defaults.backend, config = current?.config || defaults[backend];
      const id = current?.id;
      const result = await api('/discover', { backend, path: config.path });
      if (current?.id !== id) return;
      catalog = result.models; skillCatalog = result.skills || [];
      $('.ai-model-holder').innerHTML = selectField({name:'model',label:'模型',id:'ai-model',value:config.model,options:[{value:'',label:'选择模型'},...catalog.map(m => ({value:m.id,label:m.name || m.id}))],compact:true,hideLabel:true});
    } catch (e) { error(e); } finally { loadingModels = false; paint(); }
  }
  element.addEventListener('change', async e => {
    const control=e.target.matches('workbench-select') ? e.target.querySelector('input') : e.target;
    if (control.name?.startsWith('draft-project-')) { control.dataset.edited='1'; return; }
    if (e.target.id !== 'ai-model' || !current) return;
    const id = current.id, model = $('#ai-model').value; busy = true; paint();
    try { const result = await api(`/conversations/${id}/model`, { model }); if (current?.id === id) current = result.conversation; error(null); }
    catch (e) { error(e); } finally { busy = false; paint(); }
  });
  async function list() {
    const scope=current?.scope || selectedScope;
    const params=historyFilter === 'related' ? '?' + new URLSearchParams({scope:scope.kind,...(scope.id ? {scopeId:scope.id} : {}),related:'1'}) : '';
    const all = await api('/conversations'); conversations=all.conversations;
    const ids=new Set(conversations.map(c=>c.id));
    const retained=references.filter(r=>ids.has(r.id));
    if(retained.length!==references.length){references=retained;paintReferences();}
    for(const draft of composerDrafts.values())draft.references=draft.references.filter(r=>ids.has(r.id));
    const r = params ? await api('/conversations'+params) : all;
    const markup = r.conversations.map(c => `<div class="ai-history-item ${current?.id === c.id ? 'selected' : ''}"><button type="button" class="ai-history-open" data-conversation="${esc(c.id)}" ${current?.id===c.id?'aria-current="true"':''} title="${esc(c.title)}"><span>${esc(c.title)}</span><small>${c.backend === 'codex' ? 'Codex' : 'Qoder'}${running(c) ? (c.status === 'waiting' ? ' · 等待确认' : ' · 运行中') : ''}${c.scopeInfo?.kind !== 'workspace' ? ' · ' + esc(c.scopeInfo?.label || '') : ''}</small></button><button type="button" class="ai-history-action" data-delete-conversation="${esc(c.id)}" aria-label="删除对话：${esc(c.title)}" title="${running(c)?'请先结束生成或待确认内容':'删除对话'}" ${running(c)?'disabled':''}>⋯</button></div>`).join('') || `<p class="ai-history-empty">${historyFilter==='related'?'暂无相关对话':'还没有对话，点击 ＋ 开始'}</p>`;
    if(markup!==historyMarkup){historyMarkup=markup;$('.ai-history-list').innerHTML=markup;}
    lastHistoryRead=Date.now();
  }
  async function refresh() {
    if (!visible || polling) return; polling = true; const refreshingId=current?.id;
    try { if (current) { const id = current.id, r = await api('/conversations/' + id); if (current?.id === id) { const changed = current.status !== r.conversation.status; current = r.conversation; paint(); if (changed) { await list(); onChanged?.(); } } } if(Date.now()-lastHistoryRead>3000)await list(); }
    catch (e) { if(e.status===404&&current&&current.id===refreshingId){composerDrafts.delete(current.id);resetConversation();await list();onChanged?.();}else error(e); } finally { polling = false; }
  }
  async function sendMessage(e) {
    e.preventDefault(); if (busy || openingReference || running(current)) return;
    const text = $('#ai-message').value.trim(); if (!text) return;
    busy = true; error(null); paint();
    try {
      if (!current) { const key=draftKey(); current = (await api('/conversations', { model: $('#ai-model').value, scope:selectedScope })).conversation; const draft=composerDrafts.get(key); if (draft) composerDrafts.set(current.id,draft); }
      current = (await api(`/conversations/${current.id}/message`, { text, references: references.map(r => r.id), skills: skills.map(s => s.path), objectReferences:objectReferences.map(({kind,id})=>({kind,id})), extensionReferences:extensionReferences.map(({kind,id,version})=>({kind,id,version})), ...(viewContext ? {viewContext} : {}) })).conversation;
      composerDrafts.delete(draftKey()); $('#ai-message').value = ''; resizeInput(); references = []; skills = []; objectReferences=[]; extensionReferences=[]; viewContext=undefined; history.replaceState(null,'','/#ai&conversation='+encodeURIComponent(current.id)); paintReferences(); closeMentions(); await list();
    } catch (e) { error(e); } finally { busy = false; paint(); }
  }
  function paintReferences() { $('.ai-references').innerHTML = extensionReferences.map(ref=>`<span>扩展 · ${esc(ref.name || ref.id)}<button type="button" data-remove-extension="${esc(ref.id)}" aria-label="移除扩展引用">×</button></span>`).join('') + skills.map(s => `<span>/ ${esc(s.name)}<button type="button" data-remove-skill="${esc(s.path)}" aria-label="移除技能 ${esc(s.name)}">×</button></span>`).join('') + objectReferences.map(r=>`<span>@ ${esc(objectLabel(r))}<button type="button" data-remove-object="${esc(r.kind+':'+r.id)}" aria-label="移除对象引用">×</button></span>`).join('') + references.map(r => `<span>@ ${esc(r.title)}<button type="button" data-remove-reference="${esc(r.id)}" aria-label="移除引用 ${esc(r.title)}">×</button></span>`).join(''); }
  function closeMentions() { mentionOpen = false; $('.ai-mention-menu').hidden = true; }
  function renderMentions(query) {
    if (mentionType === '/') {
      const matches = skillCatalog.filter(s => !skills.some(p => p.path === s.path) && s.name.toLowerCase().includes(query.toLowerCase()));
      $('.ai-mention-menu').hidden = false;
      $('.ai-mention-menu').innerHTML = '<small>引用本机技能 · 最多 5 个</small>' + (matches.length ? matches.map(s => `<button type="button" data-skill="${esc(s.path)}"><span>${esc(s.name)}</span></button>`).join('') : '<p>没有匹配的技能，可在设置中刷新列表</p>');
      return;
    }
    const needle=query.toLowerCase();
    const objects = [...workspace.projects.map(p=>({kind:'project',id:p.id,label:p.name,detail:p.path || p.id})),...workspace.tasks.map(t=>({kind:'task',id:t.id,label:t.title,detail:workspace.projects.find(p=>p.id===t.projectId)?.name || '未归类'}))].filter(r=>!objectReferences.some(ref=>ref.kind===r.kind&&ref.id===r.id) && (r.label+' '+r.detail).toLowerCase().includes(needle)).slice(0,12);
    const matches = conversations.filter(c => c.id !== current?.id && c.messageCount && !references.some(r => r.id === c.id) && c.title.toLowerCase().includes(needle)).slice(0,10);
    $('.ai-mention-menu').hidden = false;
    $('.ai-mention-menu').innerHTML = '<small>项目 / 任务 · 最多 5 个；历史对话 · 最多 3 段</small>' + objects.map(r=>`<button type="button" data-object-kind="${r.kind}" data-object-id="${esc(r.id)}"><span>${r.kind==='project'?'项目':'任务'} · ${esc(r.label)}</span><small>${esc(r.detail)}</small></button>`).join('') + matches.map(c => `<button type="button" data-reference="${esc(c.id)}"><span>对话 · ${esc(c.title)}</span><small>${esc(c.backend)}</small></button>`).join('') + (!objects.length&&!matches.length ? '<p>没有匹配的对象或对话</p>' : '');
  }
  function resizeInput() { const input = $('#ai-message'); input.style.height = 'auto'; input.style.height = Math.min(240, input.scrollHeight) + 'px'; }
  $('#ai-message').addEventListener('input', () => { resizeInput(); const text = $('#ai-message').value.slice(0, $('#ai-message').selectionStart), match = text.match(/(?:^|\s)([@/])([^@/\n]*)$/); if (match) { mentionOpen = true; mentionType = match[1]; renderMentions(match[2]); } else closeMentions(); });
  $('.ai-composer').addEventListener('submit', sendMessage);
  $('#ai-message').addEventListener('keydown', e => { if (e.isComposing) return; if (mentionOpen && e.key === 'Escape') { e.preventDefault(); closeMentions(); return; } if (mentionOpen && e.key === 'ArrowDown') { e.preventDefault(); $('.ai-mention-menu button')?.focus(); return; } if (mentionOpen && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('.ai-mention-menu button')?.click(); return; } if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void sendMessage(e); } });
  element.addEventListener('click', async e => {
    try {
      const b = e.target.closest('button'); if (!b) return;
      if(b.dataset.deleteConversation) {
        if(busy||deleting)return;
        const target=(await api('/conversations/'+b.dataset.deleteConversation)).conversation;
        if(running(target))throw new Error('请先结束生成或处理待确认内容');
        deleteTarget={id:target.id,title:target.title,updatedAt:target.updatedAt};
        $('.ai-delete-dialog .delete-name').textContent=target.title;
        $('.ai-delete-dialog .dialog-error').textContent='';$('.ai-delete-dialog').showModal();
      }
      else if (b.classList.contains('ai-new')) { if (busy || openingReference) return; saveComposer(); resetConversation(); await list(); await loadModels(); $('#ai-message').focus(); }
      else if (b.dataset.conversation) { if (busy || openingReference) return; saveComposer(); current = (await api('/conversations/' + b.dataset.conversation)).conversation; selectedScope=current.scope || {kind:'workspace'}; viewContext=undefined; restoreComposer(); history.replaceState(null,'','/#ai&conversation='+encodeURIComponent(current.id)); error(null); paint(); await list(); await loadModels(); }
      else if (b.dataset.historyFilter) { historyFilter=b.dataset.historyFilter; element.querySelectorAll('[data-history-filter]').forEach(el=>el.classList.toggle('chosen',el===b)); await list(); }
      else if (b.hasAttribute('data-bind-scope')) { await loadWorkspace(); const scope=current?.scope || selectedScope; $('.ai-scope-editor').hidden=false; $('.ai-scope-editor').innerHTML=selectField({name:'ai-scope-choice',label:'主关联（历史内容仍保留，跨项目建议新建对话）',value:scope.kind==='workspace'?'':scope.kind+':'+scope.id,options:[{value:'',label:'通用对话'},...workspace.projects.map(p=>({value:'project:'+p.id,label:'项目 · '+p.name})),...workspace.tasks.map(t=>({value:'task:'+t.id,label:'任务 · '+t.title+' / '+(workspace.projects.find(p=>p.id===t.projectId)?.name || '未归类')}))]})+'<button type="button" class="small-button" data-save-scope>保存关联</button>'; }
      else if (b.hasAttribute('data-save-scope')) { const value=element.querySelector('[name="ai-scope-choice"]').value; const split=value.indexOf(':'); const scope=value?{kind:value.slice(0,split),id:value.slice(split+1)}:{kind:'workspace'}; if (current) current=(await api('/conversations/'+current.id+'/scope',{scope,expectedScopeVersion:current.scopeVersion || 0})).conversation; selectedScope=scope; $('.ai-scope-editor').hidden=true; await loadWorkspace(); paint(); await list(); }
      else if (b.dataset.objectId) { if (objectReferences.length>=5) throw new Error('一次最多引用 5 个对象'); objectReferences.push({kind:b.dataset.objectKind,id:b.dataset.objectId}); $('#ai-message').value=$('#ai-message').value.replace(/(^|\s)@[^@\n]*$/,'$1'); closeMentions(); paintReferences(); resizeInput(); $('#ai-message').focus(); }
      else if (b.dataset.removeExtension) { extensionReferences=extensionReferences.filter(ref=>ref.id!==b.dataset.removeExtension); paintReferences(); }
      else if (b.dataset.removeObject) { objectReferences=objectReferences.filter(r=>r.kind+':'+r.id!==b.dataset.removeObject); paintReferences(); }
      else if (b.dataset.skill) {
        const skill = skillCatalog.find(s => s.path === b.dataset.skill);
        if (skill && skills.length < 5 && !skills.some(s => s.path === skill.path)) skills.push(skill);
        $('#ai-message').value = $('#ai-message').value.replace(/(^|\s)\/[^/\n]*$/, '$1');
        closeMentions(); paintReferences(); resizeInput(); $('#ai-message').focus();
      }
      else if (b.dataset.removeSkill) { skills = skills.filter(s => s.path !== b.dataset.removeSkill); paintReferences(); }
      else if (b.dataset.reference) {
        const ref = conversations.find(c => c.id === b.dataset.reference);
        if (ref && references.length < 3 && !references.some(r => r.id === ref.id)) references.push({ id: ref.id, title: ref.title });
        $('#ai-message').value = $('#ai-message').value.replace(/(^|\s)@[^@\n]*$/, '$1');
        closeMentions(); paintReferences(); resizeInput(); $('#ai-message').focus();
      }
      else if (b.dataset.removeReference) { references = references.filter(r => r.id !== b.dataset.removeReference); paintReferences(); }
      else if (b.dataset.prompt) { $('#ai-message').value = b.dataset.prompt; resizeInput(); $('#ai-message').focus(); }
      else if (b.classList.contains('ai-stop') && current) { current = (await api(`/conversations/${current.id}/cancel`, {})).conversation; paint(); }
      else if (b.dataset.extensionSubmission && current?.extensionSubmission) {
        const id=current.id; b.disabled=true;
        try { const r=await api(`/conversations/${id}/extension-submission`,{id:b.dataset.submissionId,action:b.dataset.extensionSubmission}); if(current?.id===id){current=r.conversation;paint();} onChanged?.({kind:'extensions'}); } finally {b.disabled=false;}
      }
      else if (b.dataset.focusSubmission && current?.focusSubmission) {
        const id=current.id; b.disabled=true;
        try { const r=await api(`/conversations/${id}/focus-submission`,{id:b.dataset.submissionId,action:b.dataset.focusSubmission});if(current?.id===id){current=r.conversation;paint();}onChanged?.({kind:'focus'}); }
        finally {b.disabled=false;}
      }
      else if ((b.hasAttribute('data-apply') || b.hasAttribute('data-reject')) && current?.pending) {
        const p = current.pending, id = current.id; b.disabled = true;
        const action = p.action ? structuredClone(p.action) : undefined, list = action?.type === 'batch' ? action.actions : action ? [action] : [];
        element.querySelectorAll('[name^="draft-project-"][data-edited]').forEach(input=>{list[Number(input.name.slice(14))].projectId=input.value || null;});
        element.querySelectorAll('[data-field]').forEach(input => { list[Number(input.dataset.index)][input.dataset.field] = input.value; });
        try { const r = await api(`/conversations/${id}/answer`, { id: p.id, approve: b.hasAttribute('data-apply'), action, ...(p.type==='proxyChanges'&&b.hasAttribute('data-apply')?{apiKeys:Object.fromEntries([...element.querySelectorAll('[data-proxy-key-id]')].map(input=>[input.dataset.proxyKeyId,input.value]))}:{}) }); if (current?.id === id) { current = r.conversation; paint(); } if(!['focusChanges','extensionChanges'].includes(p.type))await loadWorkspace(); onChanged?.(p.type==='extensionChanges'?{kind:'extensions'}:p.type==='focusChanges'?{kind:'focus'}:undefined); }
        finally { b.disabled = false; }
      }
    } catch (e) { error(e); }
  });
  element.addEventListener('submit', async e => {
    if (!e.target.matches('.ai-answer-form')) return; e.preventDefault();
    const button = e.target.querySelector('button'); button.disabled = true;
    try { const id = current.id; const r = await api(`/conversations/${id}/answer`, { id: current.pending.id, answer: new FormData(e.target).get('answer') }); if (current?.id === id) { current = r.conversation; paint(); } }
    catch (e) { error(e); } finally { button.disabled = false; }
  });
  paint();
  return { element, async open(options = {}) {
    const ticket=++opening; saveComposer(); openingReference=!!options.extensionReferences; paint();
    try {
    if (options.returnHash) returnHash=options.returnHash;
    await loadWorkspace();
    const next=options.conversation ? (await api('/conversations/'+options.conversation)).conversation : null;
    if (ticket!==opening) return;
    if(options.extensionReferences && current?.id===next?.id)saveComposer();
    current=next; selectedScope=next?.scope || options.scope || {kind:'workspace'}; viewContext=options.viewContext;
    pendingId=null; lastMessages=''; $('.ai-scope-editor').hidden=true;
    restoreComposer();
    if(options.extensionReferences) { for(const ref of options.extensionReferences) if(!extensionReferences.some(value=>value.id===ref.id)) { if(extensionReferences.length>=5)throw new Error('一次最多引用 5 个扩展');extensionReferences.push(ref); } if(options.prompt&&!$('#ai-message').value.trim())$('#ai-message').value=options.prompt;paintReferences();resizeInput(); }
    error(null); paint(); await list(); await loadModels(); $('#ai-message').focus();
    } catch (e) { if (ticket!==opening) return; current=null; selectedScope={kind:'workspace'}; pendingId=null; renderPending(null); paint(); error(e); await list().catch(error); }
    finally { if(ticket===opening){openingReference=false;paint();} }
  }, async openExtension({reference,returnHash,prompt}) { return this.open({conversation:current?.id,scope:current?.scope || selectedScope,returnHash,prompt,extensionReferences:[reference]}); }, setVisible(value) { if(!value&&visible)saveComposer(); visible = value; element.hidden = !value; clearInterval(timer); if (value) { void loadWorkspace().catch(error); void list().catch(error); void refresh(); void loadModels(); timer = setInterval(refresh, 700); } } };
}
function actionLabel(type) { return ({'project.create':'创建项目','project.update':'修改项目','project.delete':'删除项目','task.create':'新增任务','task.update':'修改任务','task.status':'更新任务状态','task.delete':'删除任务','plan.add':'加入日期安排','plan.remove':'移出日期安排','plan.reschedule':'跨日改期','plan.move':'调整顺序','plan.set':'更新日期安排',undo:'撤销最近操作'})[type] || type; }
