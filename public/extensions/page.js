import { createExtensionsClient } from './client.js';
import { createExtensionsController } from './controller.js';
import { extensionPlanContent } from './review.js';
import { extensionsRoute } from '../routes.js';
import { escapeButtonText as esc, actionButton } from '../components/button.js';
import { sectionHeading, refreshButton, setRefreshState } from '../components/section.js';
import { segmentedControl, mountSegmentedControl } from '../components/segmented-control.js';
import { createDialogShell } from '../components/dialog-shell.js';
import { selectField } from '../components/select.js';

const categories = [
  { value: 'skills', label: 'Skills', collection: 'skills', title: '主目录 Skills', action: '新建 Skill' },
  { value: 'mcp', label: 'MCP 服务', collection: 'servers', title: 'MCP 主配置', action: '新建 MCP 服务' },
  { value: 'clients', label: '接入软件', collection: 'clients', title: '软件接入方式', action: '重新扫描软件' },
];
const bindingLabel = { native: '共享目录原生读取', managed: '链接由 Daylight 管理', existing: '已有正确链接', conflict: '同名位置冲突，未改动', not_connected: '勾选后预览接入' };
const textField = (name, label, value = '', attrs = '') => `<label>${label}<input name="${name}" value="${esc(value)}" ${attrs}></label>`;
const refText = refs => Object.entries(refs || {}).map(([key, ref]) => key + '=' + ref).join('\n');
const parseRefs = text => Object.fromEntries(text.split('\n').filter(line => line.trim()).map(line => { const at = line.indexOf('='); if (at < 1) throw new Error('环境变量引用每行填写 名称=环境变量名'); return [line.slice(0, at).trim(), line.slice(at + 1).trim()]; }));

export function createExtensionsPage({ getToken, onDiscuss, onChanged }) {
  const client = createExtensionsClient({ getToken }), controller = createExtensionsController({ client, onChanged });
  const element = document.createElement('main'); element.className = 'extensions-page'; element.hidden = true;
  element.innerHTML = `<header class="topbar"><span>我的工作空间 <span class="slash">/</span> 扩展管理</span></header><div class="workspace extensions-workspace"><section class="page-heading"><div><h1>扩展管理</h1><p>管理 ~/.agents 下的 Skills 与 MCP，并连接到本机 AI 软件。</p></div>${refreshButton({ ariaLabel: '重新扫描扩展', attrs: { 'data-extension-refresh': true } })}</section><div class="extension-tabs"></div><div class="extension-toolbar"><label class="extension-search"><span class="sr-only">搜索扩展</span><input type="search" placeholder="搜索名称、用途或路径" aria-label="搜索扩展"></label><div class="extension-software-filter"><span>软件</span>${selectField({ id: 'extensions-client-filter', name: 'client', label: '按软件筛选', compact: true, hideLabel: true, options: [{ value: '', label: '全部软件' }, { value: 'codex', label: 'Codex' }, { value: 'qoder', label: 'Qoder' }, { value: 'pi', label: 'Pi' }] })}</div><label class="extension-problem-filter"><input type="checkbox" data-problems>仅看问题</label><button class="secondary extension-category-action" type="button" data-create>新建 Skill</button></div><p class="extension-error" role="alert" data-error></p><div data-submission aria-live="polite"></div><div class="extension-browser"><section class="extension-list" aria-label="扩展清单"></section><aside class="extension-detail" aria-label="扩展详情" hidden></aside></div></div>`;
  const $ = selector => element.querySelector(selector);
  let route = { tab: 'skills', query: '' }, state, readFailure, selected, detailTicket = 0, visible = false, tabsDispose, shell, probeTimer, detailKey = '', submitting = false, bindingPreviewing = false;
  const category = () => categories.find(item => item.value === route.tab) || categories[0];
  function bindingControl(skill, binding, compact = false) {
    const software = state.clients.find(item => item.id === binding.clientId);
    const native = software.skillMode === 'nativeRoot', conflict = binding.state === 'conflict';
    const checked = ['native', 'managed', 'existing'].includes(binding.state);
    const note = conflict ? bindingLabel.conflict : native ? '共享目录原生读取，无需链接' : bindingLabel[binding.state];
    return `<label class="extension-binding-control" title="${esc(note)}"><input type="checkbox" data-binding-toggle data-skill="${esc(skill.id)}" data-client="${esc(binding.clientId)}" aria-label="${esc(skill.name + ' · ' + software.name)}" ${checked ? 'checked' : ''} ${native || conflict || bindingPreviewing ? 'disabled' : ''}><span>${esc(software.name)}${!compact ? `<small>${esc(note)}</small>` : native ? '<small>共享目录</small>' : conflict ? '<small>冲突</small>' : ''}</span></label>`;
  }
  function bindingRow(skill, binding, showSkillName = false) {
    const software = state.clients.find(item => item.id === binding.clientId);
    const legacy = software.skillMode === 'nativeRoot' && ['existing', 'managed'].includes(binding.state);
    return `<div class="extension-binding"><div>${showSkillName ? `<a href="${extensionsRoute({ tab: 'skills', id: skill.id })}">${esc(skill.name)}</a>` : ''}${bindingControl(skill, binding)}<small>客户端加载尚未核对</small>${legacy ? `<small>旧链接：${esc(binding.target)}。移除后仍可读取共享来源。</small>` : ''}</div>${legacy ? `<button type="button" class="text-button" data-binding="disconnect" data-skill="${esc(skill.id)}" data-client="${esc(binding.clientId)}" data-include-existing>移除旧链接</button>` : binding.state === 'existing' ? `<button type="button" class="text-button" data-binding="adopt" data-skill="${esc(skill.id)}" data-client="${esc(binding.clientId)}">预览接管链接</button>` : ''}</div>`;
  }
  function findBindingControl(data, area) {
    return [...$(area === 'list' ? '.extension-list' : '.extension-detail').querySelectorAll('[data-binding-toggle]')].find(input => input.dataset.skill === data.skill && input.dataset.client === data.client);
  }
  async function toggleBinding(input) {
    if (bindingPreviewing) return;
    const skill = state.skills.find(item => item.id === input.dataset.skill), binding = skill?.bindings.find(item => item.clientId === input.dataset.client);
    if (!binding) return;
    const connected = ['managed', 'existing'].includes(binding.state);
    input.checked = connected;
    const data = { ...input.dataset }, area = input.closest('.extension-list') ? 'list' : 'detail';
    const restore = () => {
      bindingPreviewing = false; renderList(); if (selected) renderDetail();
      if (visible) findBindingControl(data, area)?.focus();
    };
    bindingPreviewing = true; input.disabled = true; setError(null);
    try {
      await preview({ type: connected ? 'binding.disconnect' : 'binding.connect', id: skill.id, clientId: binding.clientId, ...(binding.state === 'existing' ? { includeExisting: true } : {}) }, { title: connected ? '确认移除软件链接' : '确认接入软件', onClose: restore });
    } catch (error) { restore(); setError(error); }
  }
  function setError(error) { $('[data-error]').textContent = error?.message || ''; }
  function changeRoute(next, replace = false) {
    route = { ...route, ...next };
    history[replace ? 'replaceState' : 'pushState'](null, '', '/' + extensionsRoute(route)); renderTabs(); renderList(); void loadDetail();
  }
  function renderTabs() {
    const restoreFocus=$('#extensions-tabs')?.contains(document.activeElement); tabsDispose?.(); $('.extension-tabs').innerHTML = segmentedControl({ id: 'extensions-tabs', label: '扩展分类', value: route.tab, options: categories });
    tabsDispose = mountSegmentedControl($('#extensions-tabs'), { onChange: tab => changeRoute({ tab, id: null, operation: null, file: null }) });
    if(restoreFocus)$('#extensions-tabs [aria-checked="true"]').focus();
    $('[data-create]').textContent = category().action;
    $('#extensions-client-filter').value = route.client || ''; $('[data-problems]').checked = !!route.problems; $('.extension-search input').value = route.query || '';
  }
  function renderList() {
    if (!state) { $('.extension-list').innerHTML = `<p class="extension-empty">${readFailure ? '扩展来源读取失败。请重新扫描后再试。' : '正在读取扩展来源…'}</p>`; return; }
    const needle = (route.query || '').toLowerCase();
    const focus = $('.extension-list').contains(document.activeElement) ? document.activeElement?.dataset : null;
    const list = state[category().collection];
    const filtered = list.filter(item => {
      const matchesText = !needle || [item.name, item.description, item.relativePath, item.command, item.url, item.note].filter(Boolean).join(' ').toLowerCase().includes(needle);
      const matchesSoftware = !route.client || (route.tab === 'skills'
        ? item.bindings.some(binding => binding.clientId === route.client && binding.state !== 'not_connected')
        : route.tab === 'clients' ? item.id === route.client : state.clients.some(client => client.id === route.client && client.mcpMode !== 'unsupported'));
      const matchesProblems = !route.problems || item.valid === false || route.tab === 'clients' && !item.installed || item.bindings?.some(binding => binding.state === 'conflict') || state.diagnostics.some(problem => problem.id === item.id);
      return matchesText && matchesSoftware && matchesProblems;
    });
    $('.extension-list').innerHTML = `<div class="extension-list-heading"><h2>${category().title}</h2><span>${filtered.length} 项</span></div>${filtered.map(item => {
      const active = item.id === route.id;
      const summary = route.tab === 'skills' ? item.valid ? item.description : item.problem : route.tab === 'mcp' ? (item.enabled ? '主配置启用' : '主配置禁用') + ' · ' + item.transport : item.note;
      return `<div class="extension-row ${active ? 'selected' : ''}"><button type="button" class="extension-row-open" data-extension-id="${esc(item.id)}" ${active ? 'aria-current="true"' : ''}><span class="extension-row-copy"><strong>${esc(item.name)}</strong><span>${esc(summary)}</span>${item.relativePath ? `<small>skills/${esc(item.relativePath)}</small>` : ''}</span></button><div class="extension-row-status">${route.tab === 'skills' ? item.bindings.map(binding => bindingControl(item, binding, true)).join('') : route.tab === 'mcp' ? `<span>${item.lastProbe?.stale ? "配置已变更 · 上次" : ""}${({succeeded:'握手成功',failed:'检测失败',running:'正在检测',cancelled:'已取消',timed_out:'检测超时'})[item.lastProbe?.status] || '尚未检测'}</span>` : `<span>${item.installed ? '发现可执行文件' : '未发现可执行文件'}</span><span>加载结果未核对</span>`}</div></div>`;
    }).join('')}${!filtered.length ? '<p class="extension-empty">没有匹配项。可调整搜索或筛选。</p>' : ''}${state.diagnostics.length ? `<details class="extension-static-diagnostics"><summary>静态问题 ${state.diagnostics.length} 项</summary>${state.diagnostics.map(problem => `<p>${esc(problem.message)}${problem.path ? ' · ' + esc(problem.path) : ''}${problem.skippedBranches > 1 ? ' · 共 ' + problem.skippedBranches + ' 处分支' : ''}</p>`).join('')}</details>` : ''}`;
    if (focus?.bindingToggle !== undefined) findBindingControl(focus, 'list')?.focus();
    else if (focus?.extensionId) [...element.querySelectorAll('[data-extension-id]')].find(item => item.dataset.extensionId === focus.extensionId)?.focus();
  }
  async function loadDetail() {
    const id = route.operation || route.id;
    if (!id) { detailTicket++; selected = null; $('.extension-detail').hidden = true; detailKey = ''; return; }
    const key = [route.tab, id, state?.version, route.file].join(':'); if (key === detailKey) return;
    const ticket = ++detailTicket; $('.extension-detail').hidden = false; $('.extension-detail').innerHTML = '<p>正在读取详情…</p>';
    try {
      const value = route.operation ? await client.operation(id) : await client.detail(id, route.file);
      if (ticket !== detailTicket || !visible) return; selected = value; detailKey = key; renderDetail();
    } catch (error) { if (ticket !== detailTicket) return; $('.extension-detail').innerHTML = `<p role="alert">${esc(error.message)}</p><button type="button" class="text-button" data-close-detail>返回清单</button>`; }
  }
  function renderDetail() {
    const item = selected; if (!item) return;
    const heading = sectionHeading({ title: item.name || '操作回执', actions: actionButton({ label: '返回清单', variant: 'secondary', attrs: { 'data-close-detail': true } }) });
    let content;
    if (route.operation) content = `<p>状态：${esc(item.status)}</p><p>${esc(item.error || '')}</p><code>${esc(item.requestId)}</code><div class="extension-actions"><button type="button" class="secondary" data-restore-operation="${esc(item.requestId)}" ${item.status === 'applied' && item.steps.length ? '' : 'disabled'}>预览恢复修改前内容</button></div><details><summary>操作与步骤</summary><pre>${esc(JSON.stringify(item, null, 2))}</pre></details>`;
    else if (item.kind === 'skill') content = `<p>${esc(item.description || item.problem)}</p><p class="extension-source">主来源：skills/${esc(item.relativePath)}</p><div class="extension-actions"><button type="button" class="secondary" data-edit>编辑文件</button><button type="button" class="text-button" data-discuss>让 AI 解释或修改</button></div><section><h3>软件接入</h3>${item.bindings.map(binding => bindingRow(item, binding)).join('')}</section><p>MCP 依赖：${item.dependencies === null ? '未声明' : item.dependencies.length ? item.dependencies.map(id => esc(state.servers.find(server => server.id === id)?.name || id + '（不存在）')).join('、') : '明确声明为空'}</p>${selectField({ id: 'extension-file-select', name: 'file', label: '查看 Skill 文件', value: item.file, compact: true, options: item.files.filter(file => !file.linked).map(file => ({ value: file.path, label: file.path })) })}<pre class="extension-source-content">${esc(item.content || '（空文件）')}</pre><button type="button" class="text-button danger-button" data-archive>归档主 Skill，影响使用它的软件</button>`;
    else if (item.kind === 'mcp') content = `<p>${item.transport === 'stdio' ? '本地命令（stdio）' : 'HTTP 服务'} · ${item.enabled ? '主配置启用' : '主配置禁用'}</p><p>保存配置不会启动服务。客户端接入与检测结果分别核对。</p><div class="extension-actions"><button type="button" class="secondary" data-edit>编辑配置</button><button type="button" class="secondary" data-probe ${item.enabled ? '' : 'disabled'}>测试连接</button><button type="button" class="text-button" data-discuss>让 AI 诊断或修改</button></div><div data-probe-result role="status">${item.lastProbe?`<p>${item.lastProbe.stale ? "配置已变化，以下为上次配置的检测结果：" : ""}${esc(item.lastProbe.message)}${item.lastProbe.toolCount!==null?' 工具数：'+item.lastProbe.toolCount:''}</p>`:''}</div><dl>${Object.entries(item).filter(([key]) => ['id', 'command', 'args', 'cwd', 'url', 'envRefs', 'headerRefs'].includes(key)).map(([key, value]) => `<dt>${esc(({ envRefs: '环境变量引用', headerRefs: '请求头引用', command: '命令', args: '参数', cwd: '工作目录', url: '端点', id: 'ID' })[key])}</dt><dd>${esc(typeof value === 'object' ? JSON.stringify(value, null, 2) : value)}</dd>`).join('')}</dl><p>声明依赖的 Skills：${item.dependencies.length ? item.dependencies.map(skill => esc(skill.name)).join('、') : '未发现明确声明；其他依赖未知'}</p><a href="${extensionsRoute({ tab: 'clients' })}" class="text-button">查看客户端配置生成和接入</a><button type="button" class="text-button danger-button" data-archive>归档 MCP 主配置</button>`;
    else content = `<p>${esc(item.note)}</p><dl><dt>软件主目录</dt><dd>${esc(item.root)}</dd><dt>软件 Skills 目录</dt><dd>${esc(item.skillsRoot)}</dd><dt>Daylight 管理的共享来源</dt><dd>${esc(state.root)}/skills</dd></dl><p>${esc(item.refresh)}</p><p>${item.installed ? '发现可执行文件：' + esc(item.executable) : '未发现可执行文件；安装与登录仍由软件自身管理。'}</p><p>当前未运行客户端发现检测。</p><div class="extension-actions">${item.mcpMode !== 'unsupported' ? `<button type="button" class="secondary" data-generate>预览生成 MCP 配置</button>` : ''}<button type="button" class="text-button" data-discuss>让 AI 解释接入情况</button>${item.id === 'pi' ? '<a class="text-button" href="#cli">Pi 模型配置</a>' : ''}</div><h3>Skill 接入</h3>${item.skills.map(skill => bindingRow(skill, skill.binding, true)).join('') || '<p>主目录暂无 Skill。</p>'}${item.generated ? `<h3>MCP 适配文件</h3><p>${item.generated.current ? '与主配置一致' : '主配置已变化或格式不能生成，请重新核对'}</p><code>${esc(item.generated.path)}</code><p>${esc(item.integration)}</p><pre>${esc(item.generated.content)}</pre>` : `<p>${item.mcpMode === 'unsupported' ? esc(item.note) : '尚未生成 MCP 适配文件；生成后仍需在客户端接入。'}</p>`}`;
    $('.extension-detail').innerHTML = heading + content;
    if (item.kind === 'mcp' && item.lastProbe?.status === 'running') watchProbe(item.lastProbe.id);
  }
  function openShell(title, content, onClose = () => {}) {
    shell?.dispose(); shell = createDialogShell({ title, onClose }); shell.element.classList.add('extension-dialog'); shell.setContent(content); shell.open(); return shell;
  }
  async function preview(action, { title, onClose } = {}) {
    const plan = await client.prepare(action);
    if (!visible) { onClose?.(); return; }
    const dialog = openShell(title || (action.type === 'mcp.probe' ? '确认检测 MCP 连接' : '预览扩展变更'), `${extensionPlanContent(plan)}<p class="extension-error" role="alert" data-dialog-error></p><div class="dialog-footer"><button type="button" class="secondary" data-preview-cancel>取消</button><button type="button" class="primary" data-preview-apply ${plan.conflicts.length ? 'disabled' : ''}>${action.type === 'mcp.probe' ? '确认并检测' : '应用变更'}</button></div>`, onClose);
    dialog.element.querySelector('[data-preview-cancel]').onclick = () => dialog.close();
    dialog.element.querySelector('[data-preview-apply]').onclick = async () => {
      dialog.setBusy(true); dialog.element.querySelector('[data-preview-apply]').disabled = true;
      try { const result = await controller.submit(plan); if (result.probeId) watchProbe(result.probeId); detailKey = ''; await loadDetail(); dialog.setBusy(false); dialog.close(); }
      catch (error) { dialog.element.querySelector('[data-dialog-error]').textContent = error.message + '；输入与原请求已保留。'; }
      finally { dialog.setBusy(false); dialog.element.querySelector('[data-preview-apply]').disabled = false; }
    };
  }
  function watchProbe(id) {
    clearTimeout(probeTimer);
    async function poll() {
      if (!visible) return;
      try {
        const probe = await client.probe(id), output = selected?.kind==='mcp'&&selected.id===probe.serverId?$('[data-probe-result]'):null;
        if (output) output.innerHTML = `<p>${probe.configRevision !== selected.revision ? "配置已变化，以下为上次配置的检测结果：" : ""}${esc(probe.message)}${probe.toolCount !== null ? ' 工具数：' + probe.toolCount : ''}</p>${probe.status === 'running' ? '<button type="button" class="text-button" data-cancel-probe>取消检测</button>' : ''}`;
        output?.querySelector('[data-cancel-probe]')?.addEventListener('click', () => void client.cancelProbe(id).then(poll).catch(setError));
        if (probe.status === 'running') probeTimer = setTimeout(poll, 500);
      } catch (error) { setError(error); }
    }
    void poll();
  }
  function edit(create = false) {
    const item = create ? null : selected, isMcp = create ? route.tab === 'mcp' : item.kind === 'mcp', key = create ? 'new:' + route.tab : item.id + ':' + (item.file || ''), draft = controller.drafts.get(key);
    const form = isMcp ? `<p>只保存 ~/.agents 下的主配置。凭据请填环境变量名。</p><div class="extension-form-grid">${textField('id', '稳定 ID', item?.id, 'required maxlength="80" ' + (item ? 'readonly' : ''))}${textField('name', '服务名称', item?.name, 'required maxlength="200"')}</div>${selectField({ id: 'extension-transport', name: 'transport', label: '连接方式', value: item?.transport || 'stdio', options: [{ value: 'stdio', label: '本地命令（stdio）' }, { value: 'http', label: 'HTTP 服务' }] })}<div data-stdio-fields>${textField('command', '可执行命令', item?.command, 'placeholder="如 node 或 /绝对路径/程序"')}<label>参数（每行一项）<textarea name="args" rows="3">${esc((item?.args || []).join('\n'))}</textarea></label>${textField('cwd', '工作目录（可选）', item?.cwd)}<label>环境变量引用（每行 名称=环境变量名）<textarea name="envRefs" rows="3" placeholder="API_TOKEN=API_TOKEN">${esc(refText(item?.envRefs))}</textarea></label></div><div data-http-fields>${textField('url', 'HTTP 端点', item?.url, 'type="url" placeholder="https://example.com/mcp"')}<label>请求头引用（每行 请求头=环境变量名）<textarea name="headerRefs" rows="3" placeholder="Authorization=MCP_AUTH_HEADER">${esc(refText(item?.headerRefs))}</textarea></label></div><label class="extension-checkbox"><input type="checkbox" name="enabled" ${item?.enabled !== false ? 'checked' : ''}>主配置启用（客户端生效需重新接入或刷新）</label>` : create ? `${textField('directory', 'Skill 名称 / 目录', '', 'required pattern="[a-z0-9][a-z0-9-]{0,63}" placeholder="如 review-code"')}<label>用途说明<textarea name="description" required rows="2" placeholder="什么时候使用这个 Skill"></textarea></label><label>操作说明<textarea name="body" rows="10" placeholder="写下使用步骤和约束"></textarea></label>` : `<p>编辑主来源 ${esc(item.relativePath)}/${esc(item.file)}，不会执行其中的脚本。</p><label>文件内容<textarea name="content" rows="16" spellcheck="false" required>${esc(item.content)}</textarea></label>`;
    const dialog = openShell(create ? isMcp ? '新建 MCP 服务' : '新建 Skill' : '编辑主来源', `<form class="extension-editor">${form}<p class="extension-error" role="alert" data-dialog-error></p><p class="extension-draft-note" role="status">未保存内容在切换页面后保留。</p><div class="dialog-footer"><button type="button" class="secondary" data-editor-cancel>取消</button><button type="submit" class="primary">保存主来源</button></div></form>`);
    const editor = dialog.element.querySelector('form');
    if (draft) for (const [name, value] of Object.entries(draft)) { const control = editor.elements[name]; if (control) control.type === 'checkbox' ? control.checked = value : control.value = value; }
    if (isMcp) editor.querySelector('#extension-transport').value = editor.elements.transport.value;
    const saveDraft = () => controller.drafts.set(key, Object.fromEntries([...editor.elements].filter(field => field.name).map(field => [field.name, field.type === 'checkbox' ? field.checked : field.value])));
    const toggleTransport = () => { if (isMcp) { const http = editor.elements.transport.value === 'http'; editor.querySelector('[data-stdio-fields]').hidden = http; editor.querySelector('[data-http-fields]').hidden = !http; } };
    toggleTransport(); editor.addEventListener('input', saveDraft); editor.addEventListener('change', () => { saveDraft(); toggleTransport(); });
    editor.querySelector('[data-editor-cancel]').onclick = () => dialog.close();
    editor.onsubmit = async event => {
      event.preventDefault(); if (submitting) return; saveDraft(); const values = controller.drafts.get(key); let action;
      try {
        if (isMcp) action = { type: 'mcp.save', server: { id: values.id, name: values.name, enabled: values.enabled, transport: values.transport, ...(values.transport === 'stdio' ? { command: values.command, args: values.args.split('\n').filter(Boolean), ...(values.cwd ? { cwd: values.cwd } : {}), envRefs: parseRefs(values.envRefs) } : { url: values.url, headerRefs: parseRefs(values.headerRefs) }) } };
        else if (create) action = { type: 'skill.create', directory: values.directory, content: '---\nname: ' + JSON.stringify(values.directory) + '\ndescription: ' + JSON.stringify(values.description) + '\n---\n\n' + values.body + '\n' };
        else action = { type: 'skill.update', id: item.id, file: item.file, content: values.content };
        submitting = true; dialog.setBusy(true); editor.querySelector('[type=submit]').disabled = true;
        const plan = await client.prepare(action); if (plan.conflicts.length) throw new Error(plan.conflicts.join('；'));
        const result = await controller.submit(plan); controller.drafts.delete(key); dialog.setBusy(false); dialog.close();
        changeRoute({ id: isMcp ? action.server.id : create ? result.changedIds[0] : item.id, operation: null });
      } catch (error) { editor.querySelector('[data-dialog-error]').textContent = error.message; }
      finally { submitting = false; dialog.setBusy(false); editor.querySelector('[type=submit]').disabled = false; }
    };
  }
  const unsubscribe = controller.subscribe(value => {
    state = value.snapshot; readFailure = value.failure; setError(value.failure); setRefreshState($('[data-extension-refresh]'), { loading: value.loading }); renderList();
    const record = value.submission;
    $('[data-submission]').innerHTML = record ? `<div class="extension-receipt"><span>${record.status === 'applied' ? '变更已保存。客户端刷新与加载结果需另行核对。' : record.status === 'needs_review' ? '需要重新预览：' + esc(record.error) : '提交结果待核对：请使用原请求，避免重复写入。'}</span><div>${record.status === 'submitted' || record.status === 'unknown' ? '<button type="button" class="secondary" data-retry-submission>核对原请求</button>' : '<button type="button" class="text-button" data-clear-submission>关闭提示</button>'}<a class="text-button" href="${extensionsRoute({ tab: route.tab, operation: record.request.requestId })}">查看回执</a></div></div>` : '';
    if (visible) void loadDetail();
  });
  $('.extension-search input').addEventListener('input', event => changeRoute({ query: event.target.value }, true));
  $('#extensions-client-filter').addEventListener('change', event => changeRoute({ client: event.target.value || null }));
  $('[data-problems]').addEventListener('change', event => changeRoute({ problems: event.target.checked }));
  element.addEventListener('change', event => {
    if (event.target.matches('#extension-file-select')) {
      const id = route.id; route.file = event.target.value; detailKey = '';
      void loadDetail().then(() => { if (visible && route.id === id) $('#extension-file-select .select-trigger')?.focus(); });
    }
    else if (event.target.matches('[data-binding-toggle]')) void toggleBinding(event.target);
  });
  element.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button) return;
    try {
      if (button.dataset.extensionId) changeRoute({ id: button.dataset.extensionId, operation: null, file: null });
      else if (button.hasAttribute('data-close-detail')) changeRoute({ id: null, operation: null, file: null });
      else if (button.hasAttribute('data-extension-refresh')) await controller.refresh(true);
      else if (button.hasAttribute('data-create')) route.tab === 'clients' ? await controller.refresh(true) : edit(true);
      else if (button.hasAttribute('data-edit')) edit();
      else if (button.dataset.binding) await preview({ type: 'binding.' + button.dataset.binding, id: button.dataset.skill || selected.id, clientId: button.dataset.client, ...(button.hasAttribute('data-include-existing') ? { includeExisting: true } : {}) });
      else if (button.hasAttribute('data-archive')) await preview({ type: selected.kind === 'skill' ? 'skill.archive' : 'mcp.archive', id: selected.id });
      else if (button.hasAttribute('data-generate')) await preview({ type: 'mcp.generate', clientId: selected.id });
      else if (button.hasAttribute('data-probe')) await preview({ type: 'mcp.probe', id: selected.id });
      else if (button.dataset.restoreOperation) await preview({ type: 'operation.restore', operationId: button.dataset.restoreOperation });
      else if (button.hasAttribute('data-retry-submission')) { button.disabled = true; await controller.retry(); }
      else if (button.hasAttribute('data-clear-submission')) controller.clearSubmission();
      else if (button.hasAttribute('data-discuss')) onDiscuss({ reference: { id: selected.id, kind: selected.kind, version: selected.version, name: selected.name }, returnHash: extensionsRoute(route), prompt: selected.kind === 'skill' ? '请解释这个 Skill 的用途和接入情况。如需修改，先给我审阅草稿。' : '请检查这个扩展的配置和接入情况。实际检测或修改前先给我审阅草稿。' });
    } catch (error) { setError(error); } finally { button.disabled = false; }
  });
  renderTabs();
  return { element, controller, updateRoute(value) { route = { ...value }; detailKey = ''; renderTabs(); renderList(); if (visible) void loadDetail(); }, setVisible(value) { const changed = visible !== value; visible = value; element.hidden = !value; if (!changed) return; controller.setVisible(value); if (!value) { detailTicket++; clearTimeout(probeTimer); shell?.close(); } else { void loadDetail(); const record = controller.getSubmission(); if (record?.result?.probeId) watchProbe(record.result.probeId); } }, dispose() { unsubscribe(); controller.dispose(); tabsDispose?.(); shell?.dispose(); clearTimeout(probeTimer); element.remove(); } };
}
