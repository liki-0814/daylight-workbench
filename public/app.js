import { selectTasks } from './task-view.js';
import { parseRoute, taskRoute, calendarRoute, focusRoute, conversationRoute, viewProjectId } from './routes.js';
import { change, localDate } from './model.js';
import { selectField } from './components/select.js';
import { icon } from './components/icons.js';
import { actionButton } from './components/button.js';
import { sidebarContent } from './components/sidebar.js';
import { taskRangeTabs } from './components/task-range-tabs.js';
import { settingsPage } from './components/settings-page.js';
import { createProxyPage } from './proxy.js';
import { createCLIPage } from './cli-config.js';
import { createExtensionsPage } from './extensions/page.js';
import { createAIPage } from './ai.js';
import { mountAISettings } from './ai-settings.js';
import { notesField, mountNotes } from './components/task-notes.js';
import { createTaskClient } from './task-client.js';
import { createCalendarPage } from './calendar/page.js';
import { taskRow as renderTaskRow } from './components/task-row.js';
import { createTaskPicker } from './components/task-picker.js';
import { createDialogShell } from './components/dialog-shell.js';
import { createFocusClient } from './focus/client.js';
import { createFocusController } from './focus/controller.js';
import { createFocusWidget } from './focus/widget.js';
import { createFocusPanel } from './focus/panel.js';
import { createTodaySummary } from './focus/today-summary.js';
import { createTaskSummary } from './focus/task-summary.js';
import { createStatisticsPage } from './focus/statistics-page.js';
import { mountFocusSettings } from './focus/settings.js';

const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const toast = document.querySelector('#toast');
let state, version, token, busy = false, today = localDate();
let view = 'all', query = '', tab = 'open', modal = null, toastTimer;
let refreshing = false, taskReturn = null, aiActivity = '';
const formDrafts = new Map();
let aiPage, calendarPage, focusController, focusClient, focusWidget, todayPanel, todaySummary, statisticsPage, focusSettings, taskSummary, switchShell, pickerShell, picker, legacyPicker;
let focusSelection = {};
let calendar = { month: today.slice(0, 7), selectedDay: today, status: 'open', query: '', projectId: null, unassigned: false };
const taskClient = createTaskClient({ getSnapshot: () => ({state, version}), getToken: () => token, onBusy(value) { busy = value; render(); dialog.querySelectorAll('button[type=submit]').forEach(button => button.disabled = value || Boolean(modal?.needsRefresh)); }, onCommitted(result) { state = result.state; version = result.version; if (result.token) token = result.token; render(); if (!taskClient.getUndo()) toast.querySelector('[data-action=undo]')?.remove(); }, onConflict() { if (modal && modal.type !== 'choose') modal.needsRefresh = true; } });
let cliPage, extensionsPage;
let sidebarRoot, taskRoot, proxyPage, settingsRoot, lastTaskView = 'all', sidebarMarkup = '';
const pageViews = ['proxy', 'settings', 'ai', 'cli', 'focus', 'extensions'];
const isPage = value => pageViews.includes(value);
const sectionFor = value => isPage(value) ? value : 'task';
const scrollPositions = { task: 0, proxy: 0, settings: 0, ai: 0, cli: 0, focus: 0, extensions: 0 };

function writeTaskURL(replace = false) {
  if (!isPage(view)) history[replace ? 'replaceState' : 'pushState'](null, '', '/' + (view === 'calendar' ? calendarRoute(calendar) : taskRoute(view, tab, query)));
}
function navigate(next, updateURL = true) {
  if (busy || dialog.open) return;
  const previousSection = sectionFor(view), nextSection = sectionFor(next);
  if (previousSection !== nextSection) scrollPositions[previousSection] = window.scrollY;
  const keepNavFocus = sidebarRoot?.contains(document.activeElement);
  if (isPage(next) && !isPage(view)) taskReturn = { view, tab, query, calendar: {...calendar} };
  if (!isPage(next)) {
    if (isPage(view) && taskReturn && next === lastTaskView) ({ view: next, tab, query, calendar } = taskReturn);
    else { query = ''; tab = 'open'; }
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
function selection(status = tab) {
  return { scope: view === 'today' ? 'today' : 'all', status, day: today, query, ...(view === 'inbox' ? { unassigned: true } : state.projects.some(p => p.id === viewProjectId(view)) ? { projectId: viewProjectId(view) } : {}) };
}
function captureTaskDraft() { if (modal?.type === 'task' && modal.id && !modal.saved) { const form=dialog.querySelector('#task-form'); if (form) formDrafts.set(modal.id,{fields:[...new FormData(form)],version:formDrafts.get(modal.id)?.version ?? version}); } }
function startDiscussion(scope) {
  captureTaskDraft();
  const returnHash = (isPage(view) ? lastTaskView : view) === 'calendar' ? calendarRoute(calendar) : taskRoute(isPage(view) ? lastTaskView : view, tab, query);
  if (dialog.open) dialog.close();
  navigate('ai');
  history.replaceState(null, '', '/' + conversationRoute(scope));
  void aiPage.open({ scope, returnHash, ...(scope.kind === 'workspace' ? { viewContext: { scope: 'today', day: today } } : {}) });
}
async function showRelated(scope) {
  try {
    const params = new URLSearchParams({ scope: scope.kind, scopeId: scope.id, related: '1' });
    const response = await fetch('/api/ai/conversations?' + params, { headers: { 'X-Workbench-Token': token } });
    const data = await response.json(); if (!response.ok) throw new Error(data.error);
    if (dialog.open) { captureTaskDraft(); dialog.close(); }
    openModal({ type: 'related', scope, conversations: data.conversations });
  } catch (e) { notify(e.message); }
}

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const project = task => state.projects.find(p => p.id === task.projectId);
const todayIds = () => state.plans[today] || [];
const remaining = tasks => tasks.filter(t => t.status !== 'done');
const selectedTasks = () => todayIds().map(id => state.tasks.find(t => t.id === id)).filter(Boolean);
const oldTasks = () => {
  const oldIds = new Set(Object.entries(state.plans).filter(([d]) => d < today).flatMap(([, ids]) => ids));
  return state.tasks.filter(t => oldIds.has(t.id) && !todayIds().includes(t.id) && t.status !== 'done');
};
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
    notify(message + (result.warnings?.length ? '，计时状态待恢复' : ''), Boolean(taskClient.getUndo()));
    return true;
  } catch (error) {
    notify(error.message);
    if (dialog.open) {
      const warning = document.createElement('p'); warning.className = 'dialog-error'; warning.setAttribute('role', 'alert');
      warning.textContent = error.message + (modal?.needsRefresh ? '。当前输入已保留，请核对最新数据后再保存。' : '');
      (dialog.querySelector('.form-body') || dialog).append(warning);
    }
    return false;
  } finally { if (modal?.type === 'choose') renderDialog(); }
}

async function mutate(action, message) {
  if (busy) return;
  try { return await save(change(state, action, today), message); }
  catch (error) { notify(error.message); return false; }
}

function taskRow(task, {reorder=false, choose=false, grouped=false} = {}) {
  const ids = remaining(selectedTasks()).map(item => item.id);
  return renderTaskRow(task, {project:project(task), busy, context:{reorder,choose,grouped,planned:todayIds().includes(task.id),showProject:view==='today'||!state.projects.some(project=>project.id===viewProjectId(view)),first:ids[0]===task.id,last:ids.at(-1)===task.id}});
}

function openTaskPicker({targetDay, onChoose, mode='plan'}) {
  if (document.querySelector('dialog[open]')) return;
  picker?.dispose(); pickerShell?.dispose();
  picker = createTaskPicker({getState:()=>state,targetDay,mode,onChoose});
  pickerShell = createDialogShell({title:mode==='focus'?'选择专注任务':'选择 '+targetDay+' 的任务',description:mode==='focus'?'计时使用已保存任务，不自动开始任务或加入今天。':'加入日期不改变任务所属项目和执行状态。',onClose(){picker?.dispose();}});
  pickerShell.setContent(picker.element); pickerShell.open();
}


function openFocusStatistics(taskId) {
  captureTaskDraft(); if (dialog.open) dialog.close();
  focusSelection = taskId ? {taskId} : {};
  navigate('focus'); statisticsPage?.updateRoute(focusSelection);
  history.replaceState(null,'','/'+focusRoute(focusSelection));
}
function confirmTaskCompletion(id) {
  return focusController?.getSnapshot().current?.taskId !== id || window.confirm('完成任务将结束相关专注计时，是否继续？');
}
async function startFocus(taskId) {
  const task = state.tasks.find(task=>task.id===taskId);
  if (!task || task.status==='done') throw new Error('请选择真实且未完成的任务开始专注');
  const snapshot = focusController.getSnapshot(), selectedTaskVersion=version;
  if (snapshot.current) {
    if(snapshot.current.taskId===taskId && snapshot.current.phase==='work') { notify('这项任务已有正在进行的专注'); return false; }
    captureTaskDraft(); if(dialog.open) dialog.close(); pickerShell?.close();
    return new Promise(resolve=>{
      switchShell?.dispose(); let settled=false;
      const finish=value=>{if(!settled){settled=true;resolve(value);}};
      switchShell=createDialogShell({title:'切换专注任务',description:'这会提前结束当前计时，再开始新一轮；不会完成任何任务。',onClose(){finish(false);}});
      switchShell.setContent(`<p>当前：${esc(snapshot.current.taskTitleSnapshot||'短休息')}</p><p>新专注：${esc(task.title)}</p><div class="focus-actions">${actionButton({label:'结束当前并开始新轮',variant:'primary',attrs:{'data-focus-switch':true}})}${actionButton({label:'取消',attrs:{'data-dialog-close':true}})}</div><p data-focus-switch-error role="alert"></p>`);
      switchShell.element.querySelector('[data-focus-switch]').addEventListener('click',async event=>{
        event.target.disabled=true;switchShell.setBusy(true);
        try { await focusController.act({type:'focus.switch',sessionId:snapshot.current.id,phase:'work',taskId},{taskVersion:selectedTaskVersion});finish(true);switchShell.setBusy(false);switchShell.close();notify('已切换专注任务'); }
        catch(error) { switchShell.element.querySelector('[data-focus-switch-error]').textContent=error.message;event.target.disabled=false;switchShell.setBusy(false); }
      });
      if(!switchShell.open()) {finish(false);notify('请先关闭当前对话框');}
    });
  }
  await focusController.act({type:'focus.start',phase:'work',taskId},{taskVersion:version});notify('专注已开始');return true;
}
function openFocusPicker() {
  openTaskPicker({targetDay:today,mode:'focus',onChoose:async id=>{pickerShell?.close();try{return await startFocus(id);}catch(error){notify(error.message);return false;}}});
}
function initializeFocus() {
  focusClient=createFocusClient({getToken:()=>token});focusController=createFocusController({client:focusClient,getToken:async({refresh}={})=>{if(refresh){const response=await fetch('/api/state');if(!response.ok)throw new Error('无法读取服务凭证');const latest=await response.json();token=latest.token;}return token;}});
  const options={controller:focusController,getSuggestedTask:()=>state.tasks.find(task=>task.status==='active'),onStartTask:startFocus,onChooseTask:openFocusPicker,openTask:id=>{if(!state.tasks.some(task=>task.id===id)){notify('任务不存在或已删除');return;}if(document.querySelector('dialog[open]')){notify('请先关闭当前对话框');return;}openModal({type:'task',id});},onStatistics:()=>openFocusStatistics(),notify};
  focusWidget=createFocusWidget(options);document.body.append(focusWidget.element);
  todayPanel=createFocusPanel(options);todaySummary=createTodaySummary({client:focusClient,controller:focusController,onStatistics:()=>openFocusStatistics()});
}


function empty(kind) {
  const content = {
    today: ['sun', '今天暂无任务', '从已有任务中选择，或新建任务加入今天。', '<button class="primary" data-action="choose">从项目中选择' + icon('arrow') + '</button>'],
    done: ['check', '暂无已完成任务', '已完成的任务会显示在这里，可恢复为待办。', ''],
    inbox: ['inbox', '未归类为空', '未关联项目的任务显示在这里。', '<button class="primary" data-action="new">新建任务' + icon('plus') + '</button>'],
    search: ['search', '没有找到匹配的任务', '试试其他关键词，或清空搜索。', '<button class="small-button" data-action="clear-search">清空搜索</button>'],
    project: ['folder', '暂无任务', '点击“新建任务”添加任务。', '<button class="primary" data-action="new">新建任务' + icon('plus') + '</button>'],
  }[kind];
  return `<div class="empty"><h3>${content[1]}</h3><p>${content[2]}</p>${content[3]}</div>`;
}

function render() {
  if (!state) return;
  if (!['today', 'inbox', 'all', 'done', 'calendar', ...pageViews].includes(view) && !state.projects.some(p => p.id === viewProjectId(view))) { view = 'all'; query = ''; notify('项目已删除，已返回任务列表'); }
  if (!sidebarRoot) {
    sidebarRoot = document.createElement('aside'); sidebarRoot.className = 'sidebar';
    taskRoot = document.createElement('main'); taskRoot.id = 'task-page';
    app.replaceChildren(sidebarRoot, taskRoot);
  }
  const markup = sidebarContent({ state, day: today, view, busy, aiActivity });
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
  taskRoot.hidden = isPage(view) || view === 'calendar';
  calendarPage?.setVisible(view === 'calendar');
  statisticsPage?.setVisible(view === 'focus');
  focusSettings?.setVisible(view === 'settings');
  todaySummary?.setVisible(view === 'today' && !query);
  cliPage?.setVisible(view === 'cli');
  extensionsPage?.setVisible(view === 'extensions');
  if (view === 'extensions') {
    proxyPage?.setVisible(false); aiPage?.setVisible(false); if (settingsRoot) settingsRoot.hidden = true;
    if (!extensionsPage) { extensionsPage = createExtensionsPage({ getToken: () => token, onDiscuss(options) { navigate('ai'); void aiPage.openExtension(options); } }); app.append(extensionsPage.element); }
    extensionsPage.updateRoute(parseRoute(location.hash, state)); extensionsPage.setVisible(true);
    document.title = 'Daylight · 扩展管理'; return;
  }
  if (view === 'cli') {
    proxyPage?.setVisible(false);
    aiPage?.setVisible(false);
    if (settingsRoot) settingsRoot.hidden = true;
    if (!cliPage) { cliPage = createCLIPage({ getToken: () => token }); app.append(cliPage.element); }
    cliPage.setVisible(true);
    document.title = 'Daylight · CLI 配置';
    return;
  }
  if (view === 'ai') {
    proxyPage?.setVisible(false);
    if (settingsRoot) settingsRoot.hidden = true;
    if (!aiPage) { aiPage = createAIPage({ getToken: () => token, onChanged: change => change?.kind === 'extensions' ? extensionsPage?.controller.refresh(true) : change?.kind === 'focus' ? focusController?.refresh() : refreshExternal() }); app.append(aiPage.element); }
    aiPage.setVisible(true); document.title = 'Daylight · AI 对话'; return;
  }
  aiPage?.setVisible(false);
  if (view === 'proxy') {
    if (settingsRoot) settingsRoot.hidden = true;
    if (!proxyPage) { proxyPage = createProxyPage({ getToken: () => token }); app.append(proxyPage.element); }
    proxyPage.setVisible(true);
    document.title = 'Daylight · 反向代理';
    return;
  }
  if (view === 'settings') {
    proxyPage?.setVisible(false);
    if (!settingsRoot) {
      settingsRoot = document.createElement('main'); settingsRoot.id = 'settings-page'; settingsRoot.className = 'settings-page';
      settingsRoot.innerHTML = settingsPage; app.append(settingsRoot);
      mountAISettings(settingsRoot, () => token);
      focusSettings=mountFocusSettings(settingsRoot.querySelector('.ui-panel-stack'),{controller:focusController,notify});
    }
    settingsRoot.hidden = false;
    document.title = 'Daylight · 设置';
    return;
  }
  proxyPage?.setVisible(false);
  if (settingsRoot) settingsRoot.hidden = true;
  if (view === 'focus') {
    if (!statisticsPage) { statisticsPage=createStatisticsPage({client:focusClient,controller:focusController,getTaskSnapshot:()=>({state,version}),onRoute(hash){focusSelection=parseRoute(hash,state);history.replaceState(null,'','/'+hash);},openTask:id=>openModal({type:'task',id}),notify}); app.append(statisticsPage.element); statisticsPage.updateRoute(focusSelection); }
    statisticsPage.updateState(); statisticsPage.setVisible(true);document.title='Daylight · 专注统计';return;
  }
  if (view === 'calendar') {
    if (!calendarPage) { calendarPage = createCalendarPage({getTaskSnapshot:()=>({state,version}),taskClient,openTask:(id,options={})=>openModal({type:'task',id,...options}),openPicker:openTaskPicker,confirmTaskCompletion,onRoute(hash,{replace,route}){calendar={...route};history[replace?'replaceState':'pushState'](null,'','/'+hash);},notify}); app.append(calendarPage.element); }
    calendarPage.updateRoute(calendar); calendarPage.setVisible(true); document.title='Daylight · 日历'; return;
  }
  document.title = 'Daylight · 任务管理';
  const currentProject = state.projects.find(p => p.id === viewProjectId(view));
  const result = selectTasks(state, selection());
  const tasks = result.tasks, { open: openCount, done: doneCount } = result.counts;
  const active = state.tasks.find(t => t.status === 'active');
  const heading = currentProject?.name || '任务';
  const rangeLabel = currentProject?.name || (view === 'inbox' ? '未归类' : view === 'today' ? '今天' : '全部项目');
  const old = oldTasks();
  const grouped = view === 'all';
  const taskList = grouped ? [...state.projects.map(p => ({...p, tasks:tasks.filter(t=>t.projectId===p.id)})), {id:null,name:'未归类',color:'neutral',tasks:tasks.filter(t=>t.projectId===null)}].filter(p=>p.tasks.length).map(p=>`<section class="task-project-group"><div class="task-group-heading"><button data-view="${esc(p.id === null ? 'inbox' : 'project:'+p.id)}"><i class="dot ${esc(p.color)}"></i><strong>${esc(p.name)}</strong><span>${p.tasks.length}</span>${icon('arrow')}</button></div>${p.tasks.map(t=>taskRow(t,{grouped:true})).join('')}</section>`).join('') : tasks.map(t=>taskRow(t,{reorder:view==='today'&&!query})).join('');
  taskRoot.innerHTML = `
    <header class="topbar"><span>我的工作空间 <span class="slash">/</span> ${view === 'today' ? '今天' : '任务'}${currentProject ? ' / ' + esc(currentProject.name) : ''}</span><label class="search">${icon('search')}<input id="search" placeholder="搜索${esc(rangeLabel)}…" aria-label="搜索${esc(rangeLabel)}中的${tab === 'done' ? '已完成' : '待办'}任务" value="${esc(query)}" autocomplete="off"><kbd>/</kbd></label></header>
    <div class="workspace task-workspace ${view === 'today' ? 'today-workspace' : ''}">
      <section class="page-heading"><div><h1>${esc(heading)}</h1><p>${openCount} 项待办 · ${doneCount} 项已完成${query ? ' · 当前范围搜索结果' : ''}</p></div>${view === 'today' ? `<div class="date-stamp"><strong>${new Date().getDate()}</strong><span>${new Intl.DateTimeFormat('zh-CN', { month: 'long', weekday: 'long' }).format(new Date())}</span></div>` : `<button class="primary" data-action="new">${icon('plus')}新建任务</button>`}</section>
      <div class="task-view-controls">${taskRangeTabs({ view })}<button class="text-button" data-action="new-project">${icon('plus')}新建项目</button></div>
      ${currentProject ? `<div class="project-path">${icon('folder')}<span>${esc(currentProject.path || '未关联本地目录')}</span>${currentProject.path ? button('copy', '复制项目路径', 'copy', `data-id="${esc(currentProject.id)}"`) : ''}<button class="small-button" data-action="edit-project" data-id="${esc(currentProject.id)}">编辑项目</button><button class="small-button" data-action="related" data-kind="project" data-id="${esc(currentProject.id)}">相关对话</button><button class="small-button" data-action="discuss" data-kind="project" data-id="${esc(currentProject.id)}">新建项目对话</button><details class="project-operations"><summary>更多</summary><button class="danger-link" data-action="delete-project" data-id="${esc(currentProject.id)}">删除项目</button></details></div>` : ''}
      ${query ? '<button class="text-button" data-action="search-all">搜索全部任务（保留状态）</button>' : ''}
      <div class="content-grid single"><section class="task-column">
      ${active && view === 'today' && !query ? `<div class="focus-card"><div class="focus-label"><span class="pulse"></span>当前正在做</div><div class="focus-title">${esc(active.title)}</div><div class="focus-bottom"><span>${esc(project(active)?.name || '未归类')}</span><button class="small-button" data-action="toggle" data-id="${esc(active.id)}">${icon('check')}完成</button></div></div>` : ''}
      ${old.length && view === 'today' && !query ? `<div class="carryover"><span>${old.length} 项之前安排的任务尚未完成</span><button data-action="leftovers">重新选择 ${icon('arrow')}</button></div>` : ''}
      <section class="task-panel"><div class="panel-header"><div class="tabs" role="group" aria-label="任务状态"><button class="${tab === 'open' ? 'chosen' : ''}" data-tab="open">待办<span>${openCount}</span></button><button class="${tab === 'done' ? 'chosen' : ''}" data-tab="done">已完成<span>${doneCount}</span></button></div>${view !== 'today' ? `${selectField({ name: 'task-filter', label: '项目筛选', hideLabel:true, value: view === 'all' ? '' : view === 'inbox' ? 'unassigned' : view, options: [{value:'',label:'全部项目'},{value:'unassigned',label:'未归类'},...state.projects.map(p=>({value:'project:'+p.id,label:p.name}))], compact:true })}${currentProject || view === 'inbox' ? '<button class="text-button" data-view="all">清除项目筛选</button>' : ''}` : ''}${view === 'today' ? `<div class="task-toolbar"><button class="text-button" data-action="discuss" data-kind="workspace">安排今天</button><button class="text-button" data-action="choose">${icon('plus')}选择任务</button></div>` : ''}</div>
      <div class="task-list">${tasks.length ? taskList : empty(query ? 'search' : tab === 'done' ? 'done' : view === 'today' ? 'today' : view === 'inbox' ? 'inbox' : 'project')}</div>
      ${tab === 'open' ? '<button class="add-row" data-action="new">' + icon('plus') + '添加任务</button>' : ''}</section>
      ${view === 'today' ? '<p class="quiet-note">未加入今天的任务可在“任务”中查看。</p>' : ''}
      </section></div><footer class="workspace-footer"><span>本地任务管理</span><span>${state.projects.length} 个项目 · ${state.tasks.length} 项任务</span></footer>
    </div>`;
  if(view==='today'&&!query&&todayPanel){ const column=taskRoot.querySelector('.task-column');column.prepend(todaySummary.element);column.prepend(todayPanel.element); }
}

function renderDialog() {
  if (!modal) return;
  taskSummary?.dispose();taskSummary=null;
  if (modal.type === 'related') {
    dialog.innerHTML = `<div class="dialog-header"><h2 id="dialog-title">相关对话</h2>${button('close','关闭','close')}</div><div class="related-conversations">${modal.conversations.map(c => `<a href="#ai&conversation=${encodeURIComponent(c.id)}" data-open-conversation="${esc(c.id)}"><strong>${esc(c.title)}</strong><small>${esc(c.backend)} · ${esc(c.relatedReasons.join(' / '))}${['running','waiting'].includes(c.status) ? ' · ' + (c.status === 'waiting' ? '等待确认' : '运行中') : ''}</small></a>`).join('') || '<p class="muted">暂无相关对话</p>'}</div><div class="dialog-footer"><button class="primary" data-action="discuss" data-kind="${modal.scope.kind}" data-id="${esc(modal.scope.id)}">新建对话</button></div>`;
  } else if (modal.type === 'delete') {
    const isTask = modal.kind === 'task';
    const item = (isTask ? state.tasks : state.projects).find(item => item.id === modal.id);
    const count = isTask ? 0 : state.tasks.filter(t => t.projectId === modal.id).length;
    dialog.innerHTML = `<form id="delete-form"><div class="dialog-header"><h2 id="dialog-title">确认删除${isTask ? '这项任务' : '这个项目'}？</h2>${button('close', '关闭', 'close')}</div><div class="form-body"><p class="delete-name">${esc(isTask ? item?.title : item?.name)}</p><p class="field-note">${isTask ? '删除后会同时移除各日期中的安排。可在删除后的提示中撤销。' : `将同时删除项目下全部 ${count} 项任务（包括已完成任务）及其各日期安排。不会删除本地目录或文件。可在删除后的提示中撤销。`}</p></div><div class="dialog-footer"><button type="button" class="secondary" data-action="close" autofocus>取消</button><button type="submit" class="secondary danger-button">${isTask ? '确认删除任务' : count ? `删除项目及 ${count} 项任务` : '确认删除项目'}</button></div></form>`;
  } else if (modal.type === 'choose') {
    legacyPicker?.dispose();
    dialog.innerHTML = `<div class="dialog-header"><div><h2 id="dialog-title">${modal.old ? '重新安排未完成任务' : '选择今日任务'}</h2><p>加入今天不会改变任务所属的项目。</p></div>${button('close','关闭','close')}</div><div data-legacy-picker></div><div class="dialog-footer"><span class="muted">已安排 ${remaining(selectedTasks()).length} 项任务</span><button class="primary" data-action="close">完成选择</button></div>`;
    legacyPicker = createTaskPicker({getState:()=>modal?.old ? {...state,tasks:oldTasks()} : state,targetDay:today,onChoose:id=>mutate({type:'plan',id},'已加入今天')});
    dialog.querySelector('[data-legacy-picker]').append(legacyPicker.element);
  } else if (modal.type === 'project') {
    const p = state.projects.find(p => p.id === modal.id);
    dialog.innerHTML = `<form id="project-form"><div class="dialog-header"><div><h2 id="dialog-title">${p ? '编辑项目' : '新建项目'}</h2></div>${button('close', '关闭', 'close')}</div><div class="form-body"><label>项目名称<input name="name" required maxlength="200" placeholder="输入项目名称" value="${esc(p?.name || '')}" autofocus></label><label>本地项目目录 <span>选填</span><input name="path" maxlength="1000" placeholder="/Users/…" value="${esc(p?.path || '')}"></label><p class="field-note">目录仅作为关联信息，不会自动读取其中的文件。</p></div><div class="dialog-footer"><button type="button" class="secondary" data-action="close">取消</button><button class="primary" type="submit">${p ? '保存修改' : '创建项目'}</button></div></form>`;
  } else {
    const savedTask = state.tasks.find(t => t.id === modal.id);
    const draft = formDrafts.get(modal.id);
    const t = savedTask && draft ? { ...savedTask, ...Object.fromEntries(draft.fields), projectId: Object.fromEntries(draft.fields).projectId || null } : savedTask;
    const taskView = isPage(view) ? lastTaskView : view;
    const projectId = t ? t.projectId : (modal.projectId || (state.projects.some(p => p.id === viewProjectId(taskView)) ? viewProjectId(taskView) : null));
    dialog.innerHTML = `<form id="task-form"><div class="dialog-header"><div><h2 id="dialog-title">${t ? '编辑任务' : '新建任务'}</h2></div>${button('close', '关闭', 'close')}</div><div class="form-body"><label>任务名称<input name="title" required maxlength="300" value="${esc(t?.title || '')}" placeholder="输入任务名称" autofocus></label>${selectField({ name: 'projectId', label: '所属项目', value: projectId || '', options: [{ value: '', label: '未归类 · 暂不归类' }, ...state.projects.map(p => ({ value: p.id, label: p.name }))] })}${notesField(t?.notes || '')}${!t ? `<label class="checkbox-field"><input type="checkbox" name="${modal.planDay || taskView === 'calendar' ? 'planDay' : 'today'}" value="${esc(modal.planDay || calendar.selectedDay)}" ${modal.planDay || taskView === 'calendar' || taskView === 'today' ? 'checked' : ''}>${modal.planDay || taskView === 'calendar' ? '安排到 ' + esc(modal.planDay || calendar.selectedDay) : '同时加入今天'}</label>` : ''}</div><div class="dialog-footer"><button type="button" class="secondary" data-action="close">取消</button><div class="footer-actions">${t ? `<button type="button" class="danger-link" data-action="delete-task" data-id="${esc(t.id)}">删除任务</button>` : ''}<button class="primary" type="submit">${t ? '保存修改' : '创建任务'}</button></div></div></form>`;
  }
  if (modal.type === 'task' && modal.id) {
    dialog.querySelector('.dialog-footer')?.insertAdjacentHTML('beforebegin', `<div class="task-conversation-actions"><button type="button" class="small-button" data-action="related" data-kind="task" data-id="${esc(modal.id)}">相关对话</button><button type="button" class="small-button" data-action="discuss" data-kind="task" data-id="${esc(modal.id)}">讨论这项任务</button><small>讨论使用已保存的任务内容</small></div>`);
  }
  const retained = formDrafts.get(modal.id);
  if (modal.type === 'task' && retained && retained.version !== version) {
    modal.needsRefresh = true;
    dialog.querySelector('[type="submit"]').disabled = true;
    dialog.querySelector('.form-body').insertAdjacentHTML('beforeend', '<p class="dialog-error" role="alert">编辑期间工作台已变化，输入已保留。请核对最新任务后再保存。<button type="button" class="text-button" data-action="discard-draft">读取最新任务（清除本地编辑草稿）</button></p>');
  }
  mountNotes(dialog);
  if(modal.type==='task'&&modal.id&&focusController){taskSummary=createTaskSummary({taskId:modal.id,client:focusClient,controller:focusController,onStartTask:startFocus,onStatistics:openFocusStatistics,notify,getTask:()=>state.tasks.find(task=>task.id===modal?.id),hasUnsavedEdits(){const saved=state.tasks.find(task=>task.id===modal.id),form=dialog.querySelector('#task-form');return form.elements.title.value!==saved.title||form.elements.notes.value!==saved.notes||form.elements.projectId.value!==(saved.projectId||'');}});dialog.querySelector('.dialog-footer').before(taskSummary.element);}
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
  if (event.target.closest('[data-open-conversation]')) { dialog.close(); return; }
  const target = event.target.closest('button');
  if (!target || target.disabled || busy) return;
  if (target.dataset.view) { navigate(target.dataset.view); return; }
  if (target.dataset.tab) { tab = target.dataset.tab; writeTaskURL(); render(); return; }
  const { action, id } = target.dataset;
  if (action && ![taskRoot, sidebarRoot, dialog, toast].some(root => root?.contains(target))) return;
  if (action === 'discard-draft') { formDrafts.delete(modal.id); modal.needsRefresh=false; renderDialog(); return; }
  if (action === 'discuss') { startDiscussion({kind:target.dataset.kind,...(id ? {id} : {})}); return; }
  if (action === 'related') { void showRelated({kind:target.dataset.kind,id}); return; }
  if (action === 'search-all') { view='all'; lastTaskView=view; writeTaskURL(); render(); return; }
  if (action === 'new') openModal({ type: 'task' });
  if (action === 'edit') openModal({ type: 'task', id });
  if (action === 'choose' || action === 'leftovers') openModal({ type: 'choose', old: action === 'leftovers' });
  if (action === 'delete-task' || action === 'delete-project') {
    if (modal?.needsRefresh) return;
    openModal({ type: 'delete', kind: action === 'delete-task' ? 'task' : 'project', id });
  }
  if (action === 'edit-project') openModal({ type: 'project', id });
  if (action === 'new-project') openModal({ type: 'project' });
  if (action === 'close') { captureTaskDraft(); dialog.close(); }
  if (action === 'clear-search') { query = ''; writeTaskURL(true); render(); }
  if (action === 'toggle' && (state.tasks.find(task=>task.id===id).status==='done'||confirmTaskCompletion(id))) await mutate({ type: 'toggle', id }, state.tasks.find(t => t.id === id).status === 'done' ? '任务已恢复为待办' : '任务已完成');
  if (action === 'start') await mutate({ type: 'start', id }, state.tasks.find(t => t.id === id).status === 'active' ? '任务已暂停' : '已设为当前任务，并加入今天');
  if (action === 'plan' || action === 'unplan') await mutate({ type: action, id }, action === 'plan' ? '已加入今天' : '已移出今天，任务仍保留');
  if (action === 'up' || action === 'down') await mutate({ type: 'move', id, direction: action === 'up' ? -1 : 1 }, '已调整任务顺序');
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
  else if (!modal.id && (modal.planDay || (!isPage(view) ? view : lastTaskView)==='calendar')) {
    try { await taskClient.act({type:'task.create',id:crypto.randomUUID(),title:data.get('title'),projectId:data.get('projectId')||null,notes:data.get('notes'),...(data.has('planDay')?{planDay:String(data.get('planDay'))}:{})});notify('任务已创建',Boolean(taskClient.getUndo()));success=true; }
    catch(error) { notify(error.message);const warning=document.createElement('p');warning.className='dialog-error';warning.setAttribute('role','alert');warning.textContent=error.message;form.querySelector('.form-body').append(warning);success=false; }
  }
  else success = await mutate({ type: modal.id ? 'edit' : 'add', id: modal.id || crypto.randomUUID(), title: data.get('title'), projectId: data.get('projectId') || null, notes: data.get('notes'), today: data.has('today'), ...(data.has('planDay') ? {planDay: String(data.get('planDay'))} : {}) }, modal.id ? '修改已保存' : '任务已创建');
  if (success) { modal.saved = true; if (modal.id) formDrafts.delete(modal.id); dialog.close(); }
});

document.addEventListener('input', event => {
  event.target.setCustomValidity?.('');
  if (event.target.matches('[data-picker-search]')) { const position=event.target.selectionStart; modal.query=event.target.value; renderDialog(); const input=dialog.querySelector('[data-picker-search]'); input.focus(); input.setSelectionRange(position,position); return; }
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
  if (control.name === 'picker-project') { modal.projectId=control.value; renderDialog(); }
});
dialog.addEventListener('close', () => { if (dialog.open) return; taskSummary?.dispose();taskSummary=null;legacyPicker?.dispose();legacyPicker=null; if (modal?.type === 'task' && modal.id && !modal.saved) { const form=dialog.querySelector('#task-form'); if (form) formDrafts.set(modal.id,{fields:[...new FormData(form)],version:formDrafts.get(modal.id)?.version ?? version}); } modal = null; });
dialog.addEventListener('click', event => {
  if (event.target !== dialog || busy) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
});
document.addEventListener('keydown', event => {
  if (!state || busy) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (!document.querySelector('dialog[open]')) openModal({ type: 'task' }); }
  if ((event.metaKey || event.ctrlKey) && event.code === 'Comma') { event.preventDefault(); navigate('settings'); }
  if (event.key === '/' && !isPage(view) && !document.querySelector('dialog[open]') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) { event.preventDefault(); (view === 'calendar' ? calendarPage.element.querySelector('[data-calendar-search]') : document.querySelector('#search'))?.focus(); }
});
setInterval(() => {
  if (localDate() !== today && !busy) { today = localDate(); render(); if (modal?.type === 'choose') renderDialog(); notify('新的一天，今天的安排已更新'); }
}, 30000);

// Keep external skill writes visible without replacing an in-progress form.
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
    if(route.page==='focus')focusSelection=route;
    navigate(route.page, false);if(route.page==='focus')statisticsPage?.updateRoute(route);
    if (route.page === 'ai' && (route.conversation || route.scope)) await aiPage.open({ conversation: route.conversation, scope: route.scope });
  } else {
    if (route.explicit || !sidebarRoot) { if(route.view==='calendar') calendar={...calendar,...route}; navigate(route.explicit ? route.view : 'all', false); tab=route.status; query=route.query; lastTaskView=view; render(); if(route.view==='calendar') writeTaskURL(true); }
    if (route.missing) notify(route.missing);
    if (route.taskId) openModal({ type:'task',id:route.taskId });
    else if (route.newTask || route.newProject) openModal({type:route.newProject ? 'project' : 'task',...(route.view==='calendar'?{planDay:calendar.selectedDay}:{})});
  }
}

window.addEventListener('hashchange', openDesktopRoute);
window.addEventListener('popstate', openDesktopRoute);

try {
  if (location.pathname === '/proxy.html') history.replaceState(null, '', `/${location.hash || '#proxy'}`);
  await load(); initializeFocus(); await openDesktopRoute();
}
catch (error) { app.innerHTML = `<div class="load-error"><h1>暂时无法打开工作台</h1><p>${esc(error.message)}。请确认本地服务正在运行。</p><a href="/">重新连接</a></div>`; }
