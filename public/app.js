import { selectTasks } from './task-view.js';
import { parseRoute, taskRoute, viewProjectId } from './routes.js';
import { change, localDate } from './model.js';
import { selectField } from './components/select.js';
import { icon } from './components/icons.js';
import { actionButton } from './components/button.js';
import { sidebarContent, revealNavigationItem } from './components/sidebar.js';
import { disclosureSection } from './components/section.js';
import { settingsPage, mountSettingsPreferences } from './components/settings-page.js';
import { mountAISettings } from './ai-settings.js';
import { notesField, mountNotes } from './components/task-notes.js';
import { createTaskClient } from './task-client.js';
import { taskRow as renderTaskRow } from './components/task-row.js';
import { pageViews, isPage, sectionFor, esc, empty } from './app-helpers.js';

const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const toast = document.querySelector('#toast');
let heldTaskFocus = null;
let state, version, token, busy = false;
let view = 'all', query = '', doneExpanded = false, doneCollapseForQuery = null, modal = null, toastTimer;
let refreshing = false, taskReturn = null, aiActivity = '';
const formDrafts = new Map();
let aiPage;
const taskClient = createTaskClient({ getSnapshot: () => ({state, version}), getToken: () => token, onBusy(value) { if (value) heldTaskFocus = taskFocusTarget(); busy = value; render(); if (!value) heldTaskFocus = null; dialog.querySelectorAll('button[type=submit]').forEach(button => button.disabled = value || Boolean(modal?.needsRefresh)); }, onCommitted(result) { state = result.state; version = result.version; if (result.token) token = result.token; render(); if (!taskClient.getUndo()) toast.querySelector('[data-action=undo]')?.remove(); }, onConflict() { if (modal && modal.type !== 'choose') modal.needsRefresh = true; } });
let cliPage, extensionsPage;
let sidebarCollapsed = true;
try { sidebarCollapsed = localStorage.getItem('daylight-sidebar-expanded') !== 'true'; } catch {}
let showDoneEntry = true;
try { showDoneEntry = localStorage.getItem('daylight-task-done-entry') !== 'false'; } catch {}
let sidebarRoot, taskRoot, proxyPage, settingsRoot, updatePage, updaterReady = false, appRelease, releaseCheck, lastTaskView = 'all', sidebarMarkup = '';
const scrollPositions = { task: 0, proxy: 0, settings: 0, update: 0, ai: 0, cli: 0, extensions: 0 };
const pageLoads = new Map();
function ensurePage(key, load) {
  if (!pageLoads.has(key)) pageLoads.set(key, load().catch(error => { pageLoads.delete(key); throw error; }));
  return pageLoads.get(key);
}
function ensureProxy() {
  return ensurePage('proxy', async () => {
    const { createProxyPage } = await import('./proxy.js');
    proxyPage = createProxyPage({ getToken: () => token });
    app.append(proxyPage.element);
  });
}
function ensureUpdate() {
  return ensurePage('update', async () => {
    const { createUpdatePage } = await import('./update-page.js');
    updatePage = createUpdatePage({ getToken: () => token, getRelease: () => appRelease, refreshRelease: force => refreshAppRelease(force), notify, onChange: updater => { updaterReady = updater?.phase === 'ready'; syncUpdateBadge(); } });
    app.append(updatePage.element);
  });
}
function ensureCLI() {
  return ensurePage('cli', async () => {
    const { createCLIPage } = await import('./cli-config.js');
    cliPage = createCLIPage({ getToken: () => token });
    app.append(cliPage.element);
  });
}
function ensureExtensions() {
  return ensurePage('extensions', async () => {
    const { createExtensionsPage } = await import('./extensions/page.js');
    extensionsPage = createExtensionsPage({ getToken: () => token, onDiscuss(options) { navigate('ai'); void ensureAI().then(() => aiPage.openExtension(options)); } });
    app.append(extensionsPage.element);
  });
}
function ensureAI() {
  return ensurePage('ai', async () => {
    const { createAIPage } = await import('./ai.js');
    aiPage = createAIPage({ getToken: () => token, onChanged: change => change?.kind === 'extensions' ? extensionsPage?.controller.refresh(true) : refreshExternal() });
    app.append(aiPage.element);
  });
}
function opening(message) {
  if (!taskRoot) return;
  taskRoot.hidden = false;
  taskRoot.innerHTML = `<p class="loading">${esc(message)}</p>`;
}
function loadFailed(message, retry) {
  if (!taskRoot) return;
  taskRoot.hidden = false;
  taskRoot.innerHTML = `<div class="load-error"><h1>暂时无法打开此页面</h1><p>${esc(message)}</p><button class="secondary" type="button" data-retry>重试</button></div>`;
  taskRoot.querySelector('[data-retry]').onclick = retry;
}

function writeTaskURL(replace = false) {
  if (!isPage(view)) history[replace ? 'replaceState' : 'pushState'](null, '', '/' + taskRoute(view, doneExpanded ? 'done' : 'all', query));
}
function navigate(next, updateURL = true) {
  if (['today','calendar','focus'].includes(next)) next = 'all';
  if (busy || dialog.open) return;
  const previousSection = sectionFor(view), nextSection = sectionFor(next);
  if (previousSection !== nextSection) scrollPositions[previousSection] = window.scrollY;
  const keepNavFocus = sidebarRoot?.contains(document.activeElement);
  if (isPage(next) && !isPage(view)) taskReturn = { view, doneExpanded, query };
  if (!isPage(next)) {
    if (isPage(view) && taskReturn && next === lastTaskView) ({ view: next, doneExpanded, query } = taskReturn);
    else if (isPage(view)) { query = ''; doneExpanded = false; }
    lastTaskView = next;
  }
  view = next;
  if (updateURL) {
    if (isPage(next)) history.pushState(null, '', '/#' + next);
    else writeTaskURL();
  }
  render();
  if (previousSection !== nextSection) window.scrollTo(0, scrollPositions[nextSection]);
  if (keepNavFocus) [...sidebarRoot.querySelectorAll('[data-view]')].find(b => b.dataset.view === view)?.focus({ preventScroll: true });
}
function selection(status = 'open') {
  return { scope: 'all', status, query, ...(view === 'inbox' ? { unassigned: true } : state.projects.some(p => p.id === viewProjectId(view)) ? { projectId: viewProjectId(view) } : {}) };
}
function captureTaskDraft() { if (modal?.type === 'task' && modal.id && !modal.saved) { const form=dialog.querySelector('#task-form'); if (form) formDrafts.set(modal.id,{fields:[...new FormData(form)],version:formDrafts.get(modal.id)?.version ?? version}); } }
const project = task => state.projects.find(p => p.id === task.projectId);
const button = (action, label, symbol, extra = '', style = 'icon-button') => actionButton({label,symbol,variant:'icon',iconOnly:true,className:style,attrs:{'data-action':action,disabled:busy},extra});

function notify(message, undo = false) {
  clearTimeout(toastTimer);
  toast.innerHTML = `${icon('check')}<span>${esc(message)}</span>${undo ? '<button data-action="undo">撤销</button>' : ''}`;
  toast.classList.add('visible');
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 6500);
}

async function load() {
  const response = await fetch('/api/state');
  if (!response.ok) throw new Error('无法连接本地服务');
  ({ state, version, token } = await response.json());
}

async function save(next, message, allowUndo = true) {
  if (busy) return false;
  dialog.querySelector('.dialog-error')?.remove();
  try {
    const result = await taskClient.saveState(next, {allowUndo});
    notify(message, Boolean(taskClient.getUndo()));
    return true;
  } catch (error) {
    notify(error.message);
    if (dialog.open) {
      const warning = document.createElement('p'); warning.className = 'dialog-error'; warning.setAttribute('role', 'alert');
      warning.textContent = error.message + (modal?.needsRefresh ? '。当前输入已保留，请核对最新数据后再保存。' : '');
      (dialog.querySelector('.form-body') || dialog).append(warning);
    }
    return false;
  }
}

async function mutate(action, message) {
  if (busy) return;
  try { return await save(change(state, action, localDate()), message); }
  catch (error) { notify(error.message); return false; }
}

function sidebarOptions() { return { collapsed: sidebarCollapsed, state, view, busy, aiActivity, updateAvailable: appRelease?.status === 'available' || updaterReady }; }

function render() {
  if (!state) return;
  if (!['inbox', 'all', ...pageViews].includes(view) && !state.projects.some(p => p.id === viewProjectId(view))) { view = 'all'; query = ''; notify('项目已删除，已返回任务列表'); }
  if (!sidebarRoot) {
    sidebarRoot = document.createElement('aside'); sidebarRoot.className = 'sidebar';
    sidebarRoot.addEventListener('focusin', event => revealNavigationItem(event.target));
    taskRoot = document.createElement('main'); taskRoot.id = 'task-page';
    app.replaceChildren(sidebarRoot, taskRoot);
  }
  app.classList.toggle('sidebar-collapsed', sidebarCollapsed);
  const markup = sidebarContent(sidebarOptions());
  if (markup !== sidebarMarkup) {
    const scroll = sidebarRoot.scrollTop;
    sidebarRoot.innerHTML = markup; sidebarMarkup = markup;
    sidebarRoot.scrollTop = scroll;
  }
  sidebarRoot.querySelectorAll('[data-view]').forEach(button => {
    const active = button.dataset.view === 'all' ? !isPage(view) : button.dataset.view === view;
    button.classList.toggle('active', active);
    button.classList.toggle('parent-active', button.dataset.view === 'all' && state.projects.some(p => p.id === viewProjectId(view)));
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  taskRoot.hidden = isPage(view);
  cliPage?.setVisible(view === 'cli');
  updatePage?.setVisible(view === 'update');
  extensionsPage?.setVisible(view === 'extensions');
  proxyPage?.setSettingsVisible(view === 'settings');
  if (view === 'extensions') {
    proxyPage?.setVisible(false); aiPage?.setVisible(false); if (settingsRoot) settingsRoot.hidden = true;
    if (!extensionsPage) { opening('正在打开扩展管理…'); void ensureExtensions().then(() => { if (view === 'extensions') render(); }).catch(error => { notify(error.message); loadFailed(error.message, () => render()); }); return; }
    extensionsPage.updateRoute(parseRoute(location.hash, state)); extensionsPage.setVisible(true);
    document.title = 'Daylight · 扩展管理'; return;
  }
  if (view === 'update') {
    proxyPage?.setVisible(false); aiPage?.setVisible(false); if (settingsRoot) settingsRoot.hidden = true;
    if (!updatePage) { opening('正在打开更新…'); void ensureUpdate().then(() => { if (view === 'update') render(); }).catch(error => { notify(error.message); loadFailed(error.message, () => render()); }); return; }
    updatePage.setVisible(true);
    document.title = 'Daylight · 更新';
    return;
  }
  if (view === 'cli') {
    proxyPage?.setVisible(false);
    aiPage?.setVisible(false);
    if (settingsRoot) settingsRoot.hidden = true;
    if (!cliPage) { opening('正在打开 CLI 配置…'); void ensureCLI().then(() => { if (view === 'cli') render(); }).catch(error => { notify(error.message); loadFailed(error.message, () => render()); }); return; }
    cliPage.setVisible(true);
    document.title = 'Daylight · CLI 配置';
    return;
  }
  if (view === 'ai') {
    proxyPage?.setVisible(false);
    if (settingsRoot) settingsRoot.hidden = true;
    if (!aiPage) { opening('正在打开 AI 对话…'); void ensureAI().then(() => { if (view === 'ai') render(); }).catch(error => { notify(error.message); loadFailed(error.message, () => render()); }); return; }
    aiPage.setVisible(true); document.title = 'Daylight · AI 对话'; return;
  }
  aiPage?.setVisible(false);
  if (view === 'proxy') {
    if (settingsRoot) settingsRoot.hidden = true;
    if (!proxyPage) { opening('正在打开反向代理…'); void ensureProxy().then(() => { if (view === 'proxy') render(); }).catch(error => { notify(error.message); loadFailed(error.message, () => render()); }); return; }
    proxyPage.setVisible(true);
    document.title = 'Daylight · 反向代理';
    return;
  }
  if (view === 'settings') {
    proxyPage?.setVisible(false);
    if (!proxyPage) { opening('正在打开设置…'); void ensureProxy().then(() => { if (view === 'settings') render(); }).catch(error => { notify(error.message); loadFailed(error.message, () => render()); }); return; }
    if (!settingsRoot) {
      settingsRoot = document.createElement('main'); settingsRoot.id = 'settings-page'; settingsRoot.className = 'settings-page';
      settingsRoot.innerHTML = settingsPage; app.append(settingsRoot);
      mountAISettings(settingsRoot, () => token);
      mountSettingsPreferences(settingsRoot, {
        isDoneEntryVisible: () => showDoneEntry,
        onDoneEntryChange(value) {
          showDoneEntry = value;
          try { localStorage.setItem('daylight-task-done-entry', String(value)); } catch {}
          render();
        },
      });
      settingsRoot.querySelector('.ui-panel-stack').prepend(proxyPage.settingsElement);
    }
    settingsRoot.hidden = false;
    proxyPage.setSettingsVisible(true);
    document.title = 'Daylight · 设置';
    return;
  }
  proxyPage?.setVisible(false);
  if (settingsRoot) settingsRoot.hidden = true;
  document.title = 'Daylight · 任务管理';
  const currentProject = state.projects.find(p => p.id === viewProjectId(view));
  const openResult = selectTasks(state, selection('open'));
  const doneResult = selectTasks(state, selection('done'));
  const tasks = openResult.tasks, doneTasks = doneResult.tasks;
  const { open: openCount, done: doneCount } = openResult.counts;
  const heading = currentProject?.name || '任务';
  const rangeLabel = currentProject?.name || (view === 'inbox' ? '未归类' : '全部项目');
  const singleScope = Boolean(currentProject) || view === 'inbox';
  const groups = [];
  if (singleScope) {
    if (tasks.length) groups.push({ project: currentProject, items: tasks, showHeading: false });
  } else {
    for (const p of state.projects) {
      const items = tasks.filter(task => task.projectId === p.id);
      if (items.length) groups.push({ project: p, items, showHeading: true });
    }
    const unassigned = tasks.filter(task => task.projectId === null);
    if (unassigned.length) groups.push({ project: null, items: unassigned, showHeading: true });
  }
  const taskList = groups.map(group => `${group.showHeading ? `<h2 class="task-group-heading"><i class="dot ${esc(group.project?.color || 'neutral')}"></i><span>${esc(group.project?.name || '未归类')}</span><span data-count>${group.items.length} 项待办</span></h2>` : ''}${group.items.map(task => renderTaskRow(task, { busy })).join('')}`).join('');
  const doneOpen = doneExpanded || (Boolean(query) && doneCount > 0 && doneCollapseForQuery !== query);
  const doneDisclosure = showDoneEntry && doneCount ? disclosureSection({ id: 'task-done', title: `已完成 (${doneCount})`, className: 'task-done-disclosure', content: doneTasks.map(task => renderTaskRow(task, { busy })).join('') }) : '';
  const focusTarget = taskFocusTarget() || heldTaskFocus;
  taskRoot.innerHTML = `
    <header class="topbar"><span>我的工作空间 <span class="slash">/</span> 任务${currentProject ? ' / ' + esc(currentProject.name) : ''}</span><label class="search">${icon('search')}<input id="search" placeholder="搜索${esc(rangeLabel)}…" aria-label="搜索${esc(rangeLabel)}中的任务" value="${esc(query)}" autocomplete="off"><kbd>/</kbd></label></header>
    <div class="workspace task-workspace">
      <section class="page-heading"><div><h1>${esc(heading)}</h1><p>${openCount} 项待办${!singleScope && groups.length > 1 ? ` · ${groups.length} 个分组` : ''}${query ? ' · 搜索结果' : ''}</p></div>${actionButton({variant:'primary',symbol:'plus',label:'新建任务',attrs:{'data-action':'new'}})}</section>

      <div class="task-view-controls">
        ${selectField({ id: 'task-project-filter', name: 'task-filter', label: '项目筛选', hideLabel:true, value: view === 'all' ? '' : view === 'inbox' ? 'unassigned' : view, options: [{value:'',label:'全部项目'},{value:'unassigned',label:'未归类'},...state.projects.map(p=>({value:'project:'+p.id,label:p.name}))], compact:true })}
        ${actionButton({variant:'text',symbol:'plus',label:'新建项目',attrs:{'data-action':'new-project'}})}
      </div>
      ${query ? actionButton({variant:'text',label:'搜索全部任务',attrs:{'data-action':'search-all'}}) : ''}
      <section class="task-list-section" aria-label="任务列表">${tasks.length ? taskList : empty(query ? 'search' : view === 'inbox' ? 'inbox' : 'project')}</section>${doneDisclosure}
    </div>`;
  const doneDetails = taskRoot.querySelector('#task-done');
  if (doneDetails) {
    doneDetails.open = doneOpen;
    doneDetails.querySelector('summary').setAttribute('data-done-toggle', 'true');
    doneDetails.addEventListener('toggle', () => {
      doneExpanded = doneDetails.open;
      doneCollapseForQuery = doneDetails.open ? null : query;
      writeTaskURL(true);
    });
  }
  restoreTaskFocus(focusTarget);
}

// The task view is rebuilt after every action; keep keyboard focus on the control that was used instead of dropping it to <body>.
function taskFocusTarget() {
  const element = document.activeElement;
  if (!element || element === document.body || !taskRoot.contains(element) || element.id === 'search') return null;
  const select = element.closest('workbench-select');
  if(select) return {selector:`#${CSS.escape(select.id)} .select-trigger`};
  const attributes = ['data-action', 'data-id', 'data-tab', 'data-view', 'data-project', 'data-range', 'data-segment-value', 'data-done-toggle'].filter(name => element.hasAttribute(name));
  const selector = element.tagName.toLowerCase() + attributes.map(name => `[${name}="${CSS.escape(element.getAttribute(name))}"]`).join('');
  const row = element.closest('[data-task]')?.dataset.task;
  return { selector: attributes.length ? selector : '', row, label: element.getAttribute('aria-label') || '' };
}
function restoreTaskFocus(target) {
  if (!target) return;
  const next = (target.selector && taskRoot.querySelector(target.selector))
    || (target.row && taskRoot.querySelector(`[data-task="${CSS.escape(target.row)}"] .task-text`));
  next?.focus({ preventScroll: true });
}

function renderDialog() {
  if (!modal) return;
  if (modal.type === 'delete') {
    const isTask = modal.kind === 'task';
    const item = (isTask ? state.tasks : state.projects).find(item => item.id === modal.id);
    const count = isTask ? 0 : state.tasks.filter(t => t.projectId === modal.id).length;
    dialog.innerHTML = `<form id="delete-form"><div class="dialog-header"><h2 id="dialog-title">确认删除${isTask ? '这项任务' : '这个项目'}？</h2>${button('close', '关闭', 'close')}</div><div class="form-body"><p class="delete-name">${esc(isTask ? item?.title : item?.name)}</p><p class="field-note">${isTask ? '可在删除后的提示中撤销。' : `将同时删除项目下全部 ${count} 项任务（包括已完成任务）。不会删除本地目录或文件。可在删除后的提示中撤销。`}</p></div><div class="dialog-footer">${actionButton({label:'取消',attrs:{'data-action':'close',autofocus:true}})}${actionButton({variant:'danger',label:isTask?'确认删除任务':count?`删除项目及 ${count} 项任务`:'确认删除项目',attrs:{type:'submit'}})}</div></form>`;
  } else if (modal.type === 'project') {
    const p = state.projects.find(p => p.id === modal.id);
    dialog.innerHTML = `<form id="project-form"><div class="dialog-header"><div><h2 id="dialog-title">${p ? '编辑项目' : '新建项目'}</h2></div>${button('close', '关闭', 'close')}</div><div class="form-body"><label>项目名称<input name="name" required maxlength="200" placeholder="输入项目名称" value="${esc(p?.name || '')}" autofocus></label><label>本地项目目录 <span>选填</span><input name="path" maxlength="1000" placeholder="/Users/…" value="${esc(p?.path || '')}"></label><p class="field-note">目录仅作为关联信息，不会自动读取其中的文件。</p></div><div class="dialog-footer">${actionButton({label:'取消',attrs:{'data-action':'close'}})}${actionButton({variant:'primary',label:p?'保存修改':'创建项目',attrs:{type:'submit'}})}</div></form>`;
  } else {
    const savedTask = state.tasks.find(t => t.id === modal.id);
    const draft = formDrafts.get(modal.id);
    const t = savedTask && draft ? { ...savedTask, ...Object.fromEntries(draft.fields), projectId: Object.fromEntries(draft.fields).projectId || null } : savedTask;
    const taskView = isPage(view) ? lastTaskView : view;
    const projectId = t ? t.projectId : (modal.projectId || (state.projects.some(p => p.id === viewProjectId(taskView)) ? viewProjectId(taskView) : null));
    dialog.innerHTML = `<form id="task-form"><div class="dialog-header"><div><h2 id="dialog-title">${t ? '编辑任务' : '新建任务'}</h2></div>${button('close', '关闭', 'close')}</div><div class="form-body"><label>任务名称<input name="title" required maxlength="300" value="${esc(t?.title || '')}" placeholder="输入任务名称" autofocus></label>${selectField({ name: 'projectId', label: '所属项目', value: projectId || '', options: [{ value: '', label: '未归类 · 暂不归类' }, ...state.projects.map(p => ({ value: p.id, label: p.name }))] })}${notesField(t?.notes || '')}</div><div class="dialog-footer">${actionButton({label:'取消',attrs:{'data-action':'close'}})}<div class="footer-actions">${t ? actionButton({variant:'text',className:'danger-link',label:'删除任务',attrs:{'data-action':'delete-task','data-id':t.id}}) : ''}${actionButton({variant:'primary',label:t?'保存修改':'创建任务',attrs:{type:'submit'}})}</div></div></form>`;
  }
  const retained = formDrafts.get(modal.id);
  if (modal.type === 'task' && retained && retained.version !== version) {
    modal.needsRefresh = true;
    dialog.querySelector('[type="submit"]').disabled = true;
    dialog.querySelector('.form-body').insertAdjacentHTML('beforeend', '<p class="dialog-error" role="alert">编辑期间工作台已变化，输入已保留。请核对最新任务后再保存。<button type="button" class="text-button" data-action="discard-draft">读取最新任务（清除本地编辑草稿）</button></p>');
  }
  mountNotes(dialog);
}

function openModal(value) {
  modal = value;
  renderDialog();
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('[autofocus]')?.focus();
}

document.addEventListener('click', async event => {
  const brand = event.target.closest('.brand');
  if (brand && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate('all'); return; }
  const target = event.target.closest('button');
  if (!target || target.disabled || busy) return;
  if (target.dataset.view) { navigate(target.dataset.view); return; }
  const { action, id } = target.dataset;
  if (action && ![taskRoot, sidebarRoot, dialog, toast].some(root => root?.contains(target))) return;
  if (action === 'toggle-sidebar') {
    sidebarCollapsed = !sidebarCollapsed;
    try { localStorage.setItem('daylight-sidebar-expanded', String(!sidebarCollapsed)); } catch {}
    // Pointer toggles reveal the drawer; keyboard navigation remains immediate.
    app.classList.toggle('sidebar-motion', event.detail > 0);
    app.classList.toggle('sidebar-collapsed', sidebarCollapsed);
    const label = sidebarCollapsed ? '展开导航' : '收起导航';
    target.setAttribute('aria-expanded', String(!sidebarCollapsed));
    target.setAttribute('aria-label', label); target.title = label;
    sidebarMarkup = sidebarContent(sidebarOptions());
    target.focus({preventScroll:true}); return;
  }
  if (action === 'discard-draft') { formDrafts.delete(modal.id); modal.needsRefresh=false; renderDialog(); return; }
  if (action === 'search-all') { view='all'; lastTaskView=view; writeTaskURL(); render(); return; }
  if (action === 'new') openModal({ type: 'task' });
  if (action === 'edit') openModal({ type: 'task', id });
  if (action === 'delete-task' || action === 'delete-project') {
    if (modal?.needsRefresh) return;
    openModal({ type: 'delete', kind: action === 'delete-task' ? 'task' : 'project', id });
  }
  if (action === 'edit-project') openModal({ type: 'project', id });
  if (action === 'new-project') openModal({ type: 'project' });
  if (action === 'close') { captureTaskDraft(); dialog.close(); }
  if (action === 'clear-search') { query = ''; writeTaskURL(true); render(); }
  if (action === 'toggle') await mutate({ type: 'toggle', id }, state.tasks.find(t => t.id === id).status === 'done' ? '任务已恢复为待办' : '任务已完成');
  if (action === 'undo') { try { await taskClient.undo(); notify('已撤销上一次修改'); } catch(error) { notify(error.message); } }
  if (action === 'copy') {
    try { await navigator.clipboard.writeText(state.projects.find(p => p.id === id).path); notify('项目路径已复制'); }
    catch { notify('复制失败，可在项目详情中选择并复制路径'); }
  }
});

document.addEventListener('submit', async event => {
  if (!['task-form', 'project-form', 'delete-form'].includes(event.target.id)) return;
  event.preventDefault();
  if (busy || modal?.needsRefresh) return;
  if (event.target.id === 'delete-form') {
    if (await mutate({ type: `${modal.kind}.delete`, id: modal.id }, modal.kind === 'task' ? '任务已删除' : '项目已删除')) dialog.close();
    return;
  }
  const form = event.target, data = new FormData(form);
  if (form.id === 'task-form' && String(data.get('notes')).length > 10000) { notify('备注不能超过 10000 字符'); return; }
  const name = form.elements.namedItem(form.id === 'project-form' ? 'name' : 'title');
  if (!name.value.trim()) { name.setCustomValidity('请输入名称，不能只有空格'); name.reportValidity(); return; }
  let success;
  if (form.id === 'project-form') success = await mutate({ type: modal.id ? 'project.update' : 'project', id: modal.id || crypto.randomUUID(), name: data.get('name'), path: data.get('path') }, modal.id ? '项目修改已保存' : '项目已创建');
  else success = await mutate({ type: modal.id ? 'edit' : 'add', id: modal.id || crypto.randomUUID(), title: data.get('title'), projectId: data.get('projectId') || null, notes: data.get('notes') }, modal.id ? '修改已保存' : '任务已创建');
  if (success) { modal.saved = true; if (modal.id) formDrafts.delete(modal.id); dialog.close(); }
});

document.addEventListener('input', event => {
  event.target.setCustomValidity?.('');
  if (event.target.id !== 'search') return;
  const position = event.target.selectionStart;
  query = event.target.value;
  writeTaskURL(true);
  render();
  const input = document.querySelector('#search'); input.focus(); input.setSelectionRange(position, position);
});
document.addEventListener('change', event => {
  const control = event.target.matches('workbench-select') ? event.target.querySelector('input') : event.target;
  if (control.name === 'task-filter') { const value=control.value; navigate(value.startsWith('project:') ? value : value === 'unassigned' ? 'inbox' : 'all'); }
});
dialog.addEventListener('close', () => { if (dialog.open) return; if (modal?.type === 'task' && modal.id && !modal.saved) { const form=dialog.querySelector('#task-form'); if (form) formDrafts.set(modal.id,{fields:[...new FormData(form)],version:formDrafts.get(modal.id)?.version ?? version}); } modal = null; });
dialog.addEventListener('click', event => {
  if (event.target !== dialog || busy) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
});
document.addEventListener('keydown', event => {
  if (!state || busy) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (!document.querySelector('dialog[open]')) openModal({ type: 'task' }); }
  if ((event.metaKey || event.ctrlKey) && event.code === 'Comma') { event.preventDefault(); navigate('settings'); }
  if (event.key === '/' && !isPage(view) && !document.querySelector('dialog[open]') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) { event.preventDefault(); document.querySelector('#search')?.focus(); }
});
// Keep external skill writes visible without replacing an in-progress form.
const releaseIntervalMs = 6 * 60 * 60 * 1000;
function syncUpdateBadge() {
  const button = sidebarRoot?.querySelector('[data-view="update"]');
  if (!button) return;
  const existing = button.querySelector('[data-app-update]');
  if (appRelease?.status === 'available' || updaterReady) {
    if (existing) return;
    const badge = document.createElement('small');
    badge.dataset.appUpdate = '';
    badge.textContent = '有更新';
    button.append(badge);
  } else existing?.remove();
}
async function refreshAppRelease(force = false) {
  if (!token) return;
  if (releaseCheck) return releaseCheck;
  releaseCheck = (async () => {
    try {
      const response = await fetch(`/api/app/update${force ? '?refresh=1' : ''}`, { headers: { 'x-workbench-token': token }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('暂时无法检查更新');
      appRelease = await response.json();
    } catch {
      if (!appRelease) appRelease = { current: '', status: 'unavailable', latest: null, error: '暂时无法检查更新', checkedAt: new Date().toISOString() };
    } finally { releaseCheck = null; }
    syncUpdateBadge();
    void updatePage?.paint();
  })();
  return releaseCheck;
}
// The native updater checks in the background; reading the server's cached report is cheap and picks that up.
setInterval(() => { if (!document.hidden) void refreshAppRelease(); }, 5 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshAppRelease(); });

async function refreshExternal() {
  if (!state || busy || dialog.open || refreshing || document.hidden) return;
  const beforeVersion = version;
  refreshing = true;
  try {
    const response = await fetch('/api/state');
    if (!response.ok) return;
    const latest = await response.json();
    if (busy || dialog.open || version !== beforeVersion) return;
    token = latest.token;
    if (latest.version > version) {
      const search = document.activeElement?.id === 'search';
      const selection = search ? document.activeElement.selectionStart : 0;
      state = latest.state;
      version = latest.version;
      taskClient.invalidateUndo(); toast.querySelector('[data-action=undo]')?.remove();
      render();
      if (search) { const input = document.querySelector('#search'); input.focus(); input.setSelectionRange(selection, selection); }
      notify('已同步工作台的最新修改');
    }
  } catch { /* Keep the last saved view available while the local service restarts. */ }
  finally { refreshing = false; }
}
async function refreshAIActivity() {
  if (!aiPage || document.hidden) return;
  try { const r=await fetch('/api/ai/conversations',{headers:{'X-Workbench-Token':token}}); if (!r.ok) return; const data=await r.json(); const active=data.conversations.find(c=>c.status==='waiting') || data.conversations.find(c=>c.status==='running'); aiActivity=active ? active.status==='waiting'?'等待确认':'运行中' : ''; const badge=sidebarRoot?.querySelector('[data-ai-activity]'); if (badge) badge.textContent=aiActivity; } catch { /* Retry with the next visible refresh. */ }
}
setInterval(() => { void refreshExternal(); void refreshAIActivity(); }, 3000);
window.addEventListener('focus', refreshExternal);
document.addEventListener('visibilitychange', refreshExternal);

async function openDesktopRoute() {
  if (document.querySelector('dialog[open]') || busy || !state) return;
  await refreshExternal();
  if (document.querySelector('dialog[open]') || busy) return;
  const route = parseRoute(location.hash, state);
  if (route.page !== 'task') {
    if (route.page === 'proxy' || route.page === 'settings') await ensureProxy();
    if (route.page === 'update') await ensureUpdate();
    if (route.page === 'ai') await ensureAI();
    if (route.page === 'cli') await ensureCLI();
    if (route.page === 'extensions') await ensureExtensions();
    navigate(route.page, false);
    if (route.page === 'update' && route.check) { history.replaceState(null, '', '/#update'); void updatePage?.check(); }
    if (route.page === 'ai' && route.conversation) await aiPage.open({ conversation: route.conversation });
  } else {
    if (route.explicit || !sidebarRoot) { navigate(route.explicit ? route.view : 'all', false); doneExpanded = route.status === 'done'; query = route.query; lastTaskView = view; render(); }
    if (route.missing) notify(route.missing);
    if (route.taskId) openModal({ type:'task',id:route.taskId });
    else if (route.newTask || route.newProject) openModal({type:route.newProject ? 'project' : 'task'});
  }
}

window.addEventListener('hashchange', openDesktopRoute);
window.addEventListener('popstate', openDesktopRoute);

try {
  if (location.pathname === '/proxy.html') history.replaceState(null, '', `/${location.hash || '#proxy'}`);
  await load();
  const openingRoute = parseRoute(location.hash, state);
  if (openingRoute.page === 'task') {
    view = openingRoute.explicit ? openingRoute.view : 'all';
    doneExpanded = openingRoute.status === 'done';
    query = openingRoute.query || '';
    lastTaskView = view;
  }
  else if (openingRoute.page !== 'task') view = openingRoute.page;
  render();
  void refreshAppRelease(); await openDesktopRoute();
}
catch (error) { app.innerHTML = `<div class="load-error"><h1>暂时无法打开工作台</h1><p>${esc(error.message)}。请确认本地服务正在运行。</p><a href="/">重新连接</a></div>`; }
