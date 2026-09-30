import { markdown, processMessage } from './components/ai-message.js';
import { selectField } from './components/select.js';
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const running = c => c && ['running', 'waiting'].includes(c.status);
export function createAIPage({ getToken, onChanged }) {
  const element = document.createElement('main'); element.className = 'ai-page';
  element.innerHTML = `<header class="topbar"><span>我的工作空间 <span class="slash">/</span> AI 对话</span></header>
    <div class="workspace ai-workspace">
    <div class="ai-layout"><aside class="ai-history"><div class="ai-history-heading"><h1>AI 对话</h1><p>先把事情说清楚，再一起推进</p></div><button class="secondary ai-new" type="button">＋ 新建对话</button><nav aria-label="历史对话" class="ai-history-list"></nav></aside>
    <section class="ai-chat" aria-label="AI 对话"><div class="ai-chat-toolbar"><span class="ai-chat-meta"></span><a class="text-button" href="#settings">AI 设置</a></div><div class="ai-messages"></div><div class="ai-pending"></div><p class="ai-error" role="alert"></p><span class="ai-status" role="status"></span><form class="ai-composer"><label class="sr-only" for="ai-message">发送消息</label><div class="ai-references"></div><div class="ai-mention-menu" hidden></div><textarea id="ai-message" rows="2" placeholder="@ 引用对话 · / 引用技能" maxlength="30000"></textarea><div class="ai-composer-footer"><div class="ai-model-holder">${selectField({name:'model',label:'模型',id:'ai-model',options:[{value:'',label:'正在读取模型…'}],compact:true,hideLabel:true})}</div><div class="ai-send-actions"><button class="ai-stop" type="button" aria-label="停止生成" title="停止生成" hidden>■</button><button class="primary ai-send" type="submit" aria-label="发送消息" title="发送消息"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-7 7 7-7 7 7"/></svg></button></div></div></form></section></div></div>`;
  const $ = s => element.querySelector(s);
  let visible = false, current = null, timer, polling = false, busy = false, lastMessages = '', pendingId = null, defaults = null, catalog = [], loadingModels = false, conversations = [], references = [], mentionOpen = false, skillCatalog = [], skills = [], mentionType = '@';
  const api = async (route, data) => {
    const res = await fetch('/api/ai' + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': getToken() }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const result = await res.json(); if (!res.ok) throw new Error(result.error || 'AI 请求失败'); return result;
  };
  const error = e => { $('.ai-error').textContent = e?.message || ''; };
  function paint() {
    const c = current;
    $('.ai-chat-meta').textContent = c ? `${c.backend === 'codex' ? 'Codex' : 'Qoder'}${c.config.effort ? ' · ' + c.config.effort : ''}` : defaults ? `${defaults.backend === 'codex' ? 'Codex' : 'Qoder'} · 新对话` : '正在读取设置';
    const messages = JSON.stringify(c?.messages || []);
    if (messages !== lastMessages || !$('.ai-messages').childElementCount) {
      const nearBottom = document.documentElement.scrollHeight - innerHeight - scrollY < 220;
      const disclosures = new Map([...$('.ai-messages').querySelectorAll('[data-disclosure]')].map(el => [el.dataset.disclosure,el.open]));
      lastMessages = messages;
      $('.ai-messages').innerHTML = c?.messages.length ? c.messages.map(m => m.role === 'process' ? processMessage(m) : `<article class="ai-message ai-${esc(m.role)}">${m.role === 'operation' ? '<div class="ai-message-label">工作台</div>' : ''}<div class="ai-message-text ${m.role === 'assistant' ? 'ai-markdown' : ''}">${m.role === 'assistant' ? markdown(m.text) : esc(m.text)}</div>${m.references?.length ? `<div class="ai-source-links">${m.references.map(r => `<button type="button" class="text-button" data-conversation="${esc(r.id)}">@ ${esc(r.title)}</button>`).join('')}</div>` : ''}${m.skills?.length ? `<div class="ai-source-links">${m.skills.map(s => `<span class="muted">/ ${esc(s.name)}</span>`).join('')}</div>` : ''}${m.action ? actionLinks(m.action) : ''}</article>`).join('') : `<div class="ai-welcome"><span class="ai-orbit">✳</span><h2>把想法变成下一步</h2><p>可以一起梳理项目、完善任务内容，或安排今天。<br>不清楚的地方先问你，变更审阅后再保存。</p><div class="ai-suggestions"><button type="button" data-prompt="先查看我的项目和任务，帮我梳理下一步。不要直接创建任务，有不清楚的先问我。">梳理项目</button><button type="button" data-prompt="帮我安排今天。先了解我的时间和优先级，再给出建议。">安排今天</button></div></div>`;
      $('.ai-messages').querySelectorAll('[data-disclosure]').forEach(el => { if (disclosures.has(el.dataset.disclosure)) el.open=disclosures.get(el.dataset.disclosure); });
      if (nearBottom && c?.messages.length && visible) requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
    }
    if ((c?.pending?.id || null) !== pendingId) { pendingId = c?.pending?.id || null; renderPending(c?.pending); }
    $('.ai-stop').hidden = !running(c);
    $('.ai-send').disabled = busy || running(c);
    $('.ai-new').disabled = busy;
    $('#ai-model').disabled = busy || running(c) || loadingModels;
    if (c && catalog.some(m => m.id === c.config.model)) $('#ai-model').value = c.config.model;
    $('.ai-status').textContent = c?.status === 'waiting' ? '等待你的回答或确认' : c?.status === 'running' ? c.activity || '正在思考…' : '';
    if (c?.error) $('.ai-error').textContent = c.error;
  }
  function actionLinks(action) {
    const list = action.type === 'batch' ? action.actions : [action];
    return list.filter(a => ['task.create', 'task.update'].includes(a.type) && a.id).map(a => `<a class="text-button" href="#task=${encodeURIComponent(a.id)}">查看任务</a>`).join('');
  }
  function renderPending(p) {
    if (!p) { $('.ai-pending').replaceChildren(); return; }
    if (p.type === 'permission') $('.ai-pending').innerHTML = `<div class="ai-card"><h3>Codex 请求确认</h3><p>${esc(p.question)}</p><pre class="ai-permission-details">${esc(p.details)}</pre><div class="ai-card-actions"><button type="button" class="secondary" data-reject>拒绝</button><button type="button" class="primary" data-apply>允许本次</button></div></div>`;
    else if (p.type === 'proxyChanges') $('.ai-pending').innerHTML = `<div class="ai-card"><h3>审阅代理变更</h3><p>${esc(p.summary)}</p>${(p.impact||[]).map(t=>`<p class="ai-impact">${esc(t)}</p>`).join('')}<details open><summary>配置详情</summary><pre class="ai-permission-details">${esc(JSON.stringify(p.action,null,2))}</pre></details>${p.requiresKey?'<label>API Key<input type="password" data-proxy-key autocomplete="new-password" placeholder="安全填写，不会进入对话" required></label>':''}<div class="ai-card-actions"><button type="button" class="secondary" data-reject>取消草稿</button><button type="button" class="primary" data-apply>应用变更</button></div><small>配置变化后需要重新核对。连接测试不发送推理请求。</small></div>`;
    else if (p.type === 'question') $('.ai-pending').innerHTML = `<form class="ai-answer-form ai-card"><h3>需要你补充</h3><p>${esc(p.question)}</p><label>你的回答<textarea name="answer" rows="3" required maxlength="10000"></textarea></label><button class="primary" type="submit">继续</button></form>`;
    else {
      const list = p.action.type === 'batch' ? p.action.actions : [p.action];
      $('.ai-pending').innerHTML = `<div class="ai-card"><h3>审阅变更</h3><p>${esc(p.summary)}</p>${p.impact.map(t => `<p class="ai-impact">${esc(t)}</p>`).join('')}<div class="ai-draft-fields">${list.map((a, i) => `<div class="ai-draft-item"><strong>${esc(actionLabel(a.type))}</strong>${Object.entries(a).filter(([k]) => ['title', 'name', 'notes', 'path'].includes(k)).map(([k, v]) => `<label>${{title:'任务标题',name:'项目名称',notes:'任务内容',path:'关联目录'}[k]}<${k === 'notes' ? 'textarea rows="4"' : 'input type="text"'} data-index="${i}" data-field="${k}" ${k === 'notes' ? '' : `value="${esc(v)}"`}>${k === 'notes' ? esc(v) + '</textarea>' : ''}</label>`).join('')}<details><summary>操作详情</summary><pre>${esc(JSON.stringify(a, null, 2))}</pre></details></div>`).join('')}</div><div class="ai-card-actions"><button type="button" class="secondary" data-reject>取消草稿</button><button type="button" class="primary" data-apply>应用变更</button></div><small>工作台发生变化时会要求重新核对。应用后可撤销最近一次操作。</small></div>`;
    }
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
    if (e.target.id !== 'ai-model' || !current) return;
    const id = current.id, model = $('#ai-model').value; busy = true; paint();
    try { const result = await api(`/conversations/${id}/model`, { model }); if (current?.id === id) current = result.conversation; error(null); }
    catch (e) { error(e); } finally { busy = false; paint(); }
  });
  async function list() {
    const r = await api('/conversations'); conversations = r.conversations;
    $('.ai-history-list').innerHTML = r.conversations.map(c => `<button type="button" data-conversation="${esc(c.id)}" class="${current?.id === c.id ? 'selected' : ''}"><span>${esc(c.title)}</span><small>${c.backend === 'codex' ? 'Codex' : 'Qoder'}${running(c) ? ' · 进行中' : ''}</small></button>`).join('');
  }
  async function refresh() {
    if (!visible || polling) return; polling = true;
    try { if (current) { const id = current.id, r = await api('/conversations/' + id); if (current?.id === id) { const changed = current.status !== r.conversation.status; current = r.conversation; paint(); if (changed) { await list(); onChanged?.(); } } } }
    catch (e) { error(e); } finally { polling = false; }
  }
  async function sendMessage(e) {
    e.preventDefault(); if (busy || running(current)) return;
    const text = $('#ai-message').value.trim(); if (!text) return;
    busy = true; error(null); paint();
    try {
      if (!current) current = (await api('/conversations', { model: $('#ai-model').value })).conversation;
      current = (await api(`/conversations/${current.id}/message`, { text, references: references.map(r => r.id), skills: skills.map(s => s.path) })).conversation;
      $('#ai-message').value = ''; resizeInput(); references = []; skills = []; paintReferences(); closeMentions(); await list();
    } catch (e) { error(e); } finally { busy = false; paint(); }
  }
  function paintReferences() { $('.ai-references').innerHTML = skills.map(s => `<span>/ ${esc(s.name)}<button type="button" data-remove-skill="${esc(s.path)}" aria-label="移除技能 ${esc(s.name)}">×</button></span>`).join('') + references.map(r => `<span>@ ${esc(r.title)}<button type="button" data-remove-reference="${esc(r.id)}" aria-label="移除引用 ${esc(r.title)}">×</button></span>`).join(''); }
  function closeMentions() { mentionOpen = false; $('.ai-mention-menu').hidden = true; }
  function renderMentions(query) {
    if (mentionType === '/') {
      const matches = skillCatalog.filter(s => !skills.some(p => p.path === s.path) && s.name.toLowerCase().includes(query.toLowerCase()));
      $('.ai-mention-menu').hidden = false;
      $('.ai-mention-menu').innerHTML = '<small>引用本机技能 · 最多 5 个</small>' + (matches.length ? matches.map(s => `<button type="button" data-skill="${esc(s.path)}"><span>${esc(s.name)}</span></button>`).join('') : `<p>${(current?.backend || defaults?.backend) === 'qoder' ? 'Qoder 暂不支持显式引用技能' : '没有匹配的技能，可在设置中刷新列表'}</p>`);
      return;
    }
    const matches = conversations.filter(c => c.id !== current?.id && c.messageCount && !references.some(r => r.id === c.id) && c.title.toLowerCase().includes(query.toLowerCase())).slice(0, 15);
    $('.ai-mention-menu').hidden = false;
    $('.ai-mention-menu').innerHTML = '<small>引用 Daylight 对话 · 最多 3 段 · 发送时读取快照</small>' + (matches.length ? matches.map(c => `<button type="button" data-reference="${esc(c.id)}"><span>${esc(c.title)}</span><small>${esc(c.backend)}</small></button>`).join('') : '<p>没有可引用的对话</p>');
  }
  function resizeInput() { const input = $('#ai-message'); input.style.height = 'auto'; input.style.height = Math.min(240, input.scrollHeight) + 'px'; }
  $('#ai-message').addEventListener('input', () => { resizeInput(); const text = $('#ai-message').value.slice(0, $('#ai-message').selectionStart), match = text.match(/(?:^|\s)([@/])([^@/\n]*)$/); if (match) { mentionOpen = true; mentionType = match[1]; renderMentions(match[2]); } else closeMentions(); });
  $('.ai-composer').addEventListener('submit', sendMessage);
  $('#ai-message').addEventListener('keydown', e => { if (e.isComposing) return; if (mentionOpen && e.key === 'Escape') { e.preventDefault(); closeMentions(); return; } if (mentionOpen && e.key === 'ArrowDown') { e.preventDefault(); $('.ai-mention-menu button')?.focus(); return; } if (mentionOpen && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('.ai-mention-menu button')?.click(); return; } if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void sendMessage(e); } });
  element.addEventListener('click', async e => {
    try {
      const b = e.target.closest('button'); if (!b) return;
      if (b.classList.contains('ai-new')) { if (busy) return; current = null; references = []; skills = []; paintReferences(); closeMentions(); pendingId = null; renderPending(null); error(null); paint(); await list(); await loadModels(); $('#ai-message').focus(); }
      else if (b.dataset.conversation) { if (busy) return; current = (await api('/conversations/' + b.dataset.conversation)).conversation; error(null); paint(); await list(); await loadModels(); }
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
      else if ((b.hasAttribute('data-apply') || b.hasAttribute('data-reject')) && current?.pending) {
        const p = current.pending, id = current.id; b.disabled = true;
        const action = p.action ? structuredClone(p.action) : undefined, list = action?.type === 'batch' ? action.actions : action ? [action] : [];
        element.querySelectorAll('[data-field]').forEach(input => { list[Number(input.dataset.index)][input.dataset.field] = input.value; });
        try { const r = await api(`/conversations/${id}/answer`, { id: p.id, approve: b.hasAttribute('data-apply'), action, ...(p.type==='proxyChanges'&&b.hasAttribute('data-apply')?{apiKey:element.querySelector('[data-proxy-key]')?.value||''}:{}) }); if (current?.id === id) { current = r.conversation; paint(); } onChanged?.(); }
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
  return { element, setVisible(value) { visible = value; element.hidden = !value; clearInterval(timer); if (value) { void list().catch(error); void refresh(); void loadModels(); timer = setInterval(refresh, 700); } } };
}
function actionLabel(type) { return ({'project.create':'创建项目','project.update':'修改项目','project.delete':'删除项目','task.create':'新增任务','task.update':'修改任务','task.status':'更新任务状态','task.delete':'删除任务','plan.add':'加入日期安排','plan.remove':'移出日期安排','plan.move':'调整顺序','plan.set':'更新日期安排',undo:'撤销最近操作'})[type] || type; }
