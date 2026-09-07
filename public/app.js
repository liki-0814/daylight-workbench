import { change, localDate } from './model.js';
import { selectField } from './components/select.js';

const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const toast = document.querySelector('#toast');
let state, version, token, busy = false, day = localDate();
let view = 'today', query = '', tab = 'open', modal = null, undoState = null, toastTimer;
let refreshing = false;

const paths = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  inbox: '<path d="M4 4h16l2 11v5H2v-5L4 4Z"/><path d="M2 15h6l2 3h4l2-3h6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3 7V4h6l2 3h10v13H3V7Z"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  play: '<path d="m8 5 11 7-11 7V5Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  disk: '<path d="M4 4h14l3 3v14H3V4h1Z"/><path d="M7 4v6h10V4M7 21v-7h10v7"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.folder}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const project = task => state.projects.find(p => p.id === task.projectId);
const todayIds = () => state.plans[day] || [];
const remaining = tasks => tasks.filter(t => t.status !== 'done');
const selectedTasks = () => todayIds().map(id => state.tasks.find(t => t.id === id)).filter(Boolean);
const matches = t => !query || `${t.title} ${t.notes} ${project(t)?.name || ''}`.toLowerCase().includes(query.toLowerCase());
const oldTasks = () => {
  const oldIds = new Set(Object.entries(state.plans).filter(([d]) => d < day).flatMap(([, ids]) => ids));
  return state.tasks.filter(t => oldIds.has(t.id) && !todayIds().includes(t.id) && t.status !== 'done');
};
const button = (action, label, symbol, extra = '', style = 'icon-button') => `<button type="button" class="${style}" data-action="${action}" ${extra} title="${esc(label)}" aria-label="${esc(label)}" ${busy ? 'disabled' : ''}>${icon(symbol)}</button>`;

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
  const before = structuredClone(state);
  busy = true;
  render();
  dialog.querySelectorAll('button[type="submit"]').forEach(b => b.disabled = true);
  try {
    const response = await fetch('/api/state', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token, 'If-Match': String(version) }, body: JSON.stringify(next),
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 409) {
        await load(); undoState = null;
        if (modal && modal.type !== 'choose') modal.needsRefresh = true;
      }
      throw new Error(result.error || '保存失败，请重试');
    }
    state = result.state;
    version = result.version;
    undoState = allowUndo ? before : null;
    notify(message, allowUndo);
    return true;
  } catch (error) {
    notify(error.message);
    if (dialog.open) {
      const warning = document.createElement('p');
      warning.className = 'dialog-error';
      warning.setAttribute('role', 'alert');
      warning.textContent = error.message + (modal?.needsRefresh ? '。当前输入已保留，请复制需要的内容，关闭后重新打开以核对最新数据。' : '');
      (dialog.querySelector('.form-body') || dialog).append(warning);
    }
    return false;
  } finally {
    busy = false;
    render();
    dialog.querySelectorAll('button[type="submit"]').forEach(b => b.disabled = Boolean(modal?.needsRefresh));
    if (modal?.type === 'choose') renderDialog();
  }
}

async function mutate(action, message) {
  if (busy) return;
  try { return await save(change(state, action, day), message); }
  catch (error) { notify(error.message); return false; }
}

function taskRow(t, { reorder = false, choose = false } = {}) {
  const p = project(t), planned = todayIds().includes(t.id), done = t.status === 'done';
  const ids = remaining(selectedTasks()).map(item => item.id);
  return `<div class="task-row ${done ? 'done' : ''} ${t.status === 'active' ? 'is-active' : ''}" data-task="${esc(t.id)}">
    ${choose ? `<span class="project-square ${p?.color || 'neutral'}">${icon('folder')}</span>` : `<button class="check-button" data-action="toggle" data-id="${esc(t.id)}" aria-label="${done ? '恢复' : '完成'}：${esc(t.title)}" ${busy ? 'disabled' : ''}>${done ? icon('check') : ''}</button>`}
    <button class="task-text" data-action="edit" data-id="${esc(t.id)}" title="编辑任务">
      <span class="task-title">${esc(t.title)}</span>
      <span class="task-meta"><i class="dot ${p?.color || 'neutral'}"></i>${esc(p?.name || '收件箱')}${t.status === 'active' ? '<b>进行中</b>' : ''}</span>
    </button>
    <div class="task-actions">
    ${choose ? `<button class="small-button ${planned ? 'selected' : ''}" data-action="plan" data-id="${esc(t.id)}" ${planned || busy ? 'disabled' : ''}>${icon(planned ? 'check' : 'plus')}${planned ? '已加入' : '加入今天'}</button>` : `${!done ? button('start', t.status === 'active' ? '暂停任务' : '开始任务', t.status === 'active' ? 'pause' : 'play', `data-id="${esc(t.id)}"`) : ''}
    ${reorder && !done ? `<div class="order-buttons">${button('up', '上移', 'up', `data-id="${esc(t.id)}" ${ids[0] === t.id ? 'disabled' : ''}`)}${button('down', '下移', 'down', `data-id="${esc(t.id)}" ${ids.at(-1) === t.id ? 'disabled' : ''}`)}</div>` : ''}
    ${!done ? (planned ? button('unplan', '移出今天', 'close', `data-id="${esc(t.id)}"`) : `<button class="small-button" data-action="plan" data-id="${esc(t.id)}" ${busy ? 'disabled' : ''}>${icon('plus')}今天</button>`) : ''}`}
    </div>
  </div>`;
}

function projectCard(p) {
  const tasks = state.tasks.filter(t => t.projectId === p.id), count = tasks.filter(t => t.status === 'done').length;
  return `<article class="project-card">
    <div class="project-card-top"><span class="project-square ${p.color}">${icon('folder')}</span><span class="muted">${remaining(tasks).length} 项待办</span></div>
    <button class="project-name" data-view="${esc(p.id)}">${esc(p.name)}${icon('arrow')}</button>
    <div class="project-progress" aria-label="已完成 ${count} 项，共 ${tasks.length} 项"><progress max="${tasks.length || 1}" value="${count}"></progress><span>${count} / ${tasks.length}</span></div>
    <div class="path-line" title="${esc(p.path)}">${icon('folder')}<span>${esc(p.path.split('/').filter(Boolean).at(-1) || '未关联目录')}</span>${p.path ? button('copy', '复制项目路径', 'copy', `data-id="${esc(p.id)}"`) : ''}</div>
  </article>`;
}

function empty(kind) {
  const content = {
    today: ['sun', '今天暂无任务', '从已有任务中选择，或新建任务加入今天。', '<button class="primary" data-action="choose">从项目中选择' + icon('arrow') + '</button>'],
    done: ['check', '暂无已完成任务', '已完成的任务会显示在这里，可恢复为待办。', ''],
    inbox: ['inbox', '收件箱为空', '未关联项目的任务显示在这里。', '<button class="primary" data-action="new">新建任务' + icon('plus') + '</button>'],
    search: ['search', '没有找到匹配的任务', '试试其他关键词，或清空搜索。', '<button class="small-button" data-action="clear-search">清空搜索</button>'],
    project: ['folder', '暂无任务', '点击“新建任务”添加任务。', '<button class="primary" data-action="new">新建任务' + icon('plus') + '</button>'],
  }[kind];
  return `<div class="empty"><h3>${content[1]}</h3><p>${content[2]}</p>${content[3]}</div>`;
}

function render() {
  if (!state) return;
  if (!['today', 'inbox', 'all', 'done'].includes(view) && !state.projects.some(p => p.id === view)) view = 'today';
  const currentProject = state.projects.find(p => p.id === view);
  const today = selectedTasks();
  const todayOpen = remaining(today);
  const completed = state.tasks.filter(t => t.status === 'done');
  const active = state.tasks.find(t => t.status === 'active');
  const inbox = state.tasks.filter(t => t.projectId === null && t.status !== 'done');
  const searching = !!query;
  const heading = searching ? '搜索任务' : currentProject?.name || ({ today: '今天', inbox: '收件箱', all: '全部任务', done: '已完成' }[view]);
  let tasks = searching ? state.tasks.filter(matches) : currentProject ? state.tasks.filter(t => t.projectId === view) : ({ today, inbox: state.tasks.filter(t => t.projectId === null), all: state.tasks, done: completed }[view] || []);
  const openCount = remaining(tasks).length, doneCount = tasks.length - openCount;
  if (!searching && view !== 'done') tasks = tasks.filter(t => tab === 'done' ? t.status === 'done' : t.status !== 'done');
  const old = oldTasks();
  const nav = (id, label, symbol, count) => `<button class="nav-item ${view === id && !searching ? 'active' : ''}" data-view="${id}" ${view === id && !searching ? 'aria-current="page"' : ''}>${icon(symbol)}<span>${label}</span><small>${count}</small></button>`;
  app.innerHTML = `<aside class="sidebar">
    <a class="brand" href="/" aria-label="Daylight 工作台首页"><img src="/favicon.svg" alt="" width="35" height="35"><span>Daylight<small>项目与任务管理</small></span></a>
    <button class="capture" data-action="new">${icon('plus')}新建任务<span>⌘ K</span></button>
    <nav aria-label="主要导航">${nav('today', '今天', 'sun', todayOpen.length)}${nav('inbox', '收件箱', 'inbox', inbox.length)}${nav('all', '全部任务', 'grid', remaining(state.tasks).length)}${nav('done', '已完成', 'check', completed.length)}</nav>
    <div class="nav-label">我的项目${button('new-project', '新建项目', 'plus')}</div>
    <nav class="project-nav" aria-label="项目">${state.projects.map(p => `<button class="nav-item ${view === p.id && !searching ? 'active' : ''}" data-view="${esc(p.id)}" ${view === p.id && !searching ? 'aria-current="page"' : ''}><i class="dot ${p.color}"></i><span>${esc(p.name)}</span><small>${remaining(state.tasks.filter(t => t.projectId === p.id)).length}</small></button>`).join('')}</nav>
    <div class="sidebar-footer"><span class="local-badge"><i></i>本地工作空间</span><div>${icon('disk')}<span>${busy ? '正在保存…' : '更改已保存到本机'}</span></div><button data-action="export">导出数据 ${icon('arrow')}</button></div>
  </aside>
  <main>
    <header class="topbar"><span>我的工作空间 <span class="slash">/</span> ${searching ? '搜索' : currentProject ? '项目' : esc(heading)}</span><label class="search">${icon('search')}<input id="search" placeholder="搜索任务…" aria-label="搜索任务" value="${esc(query)}" autocomplete="off"><kbd>/</kbd></label></header>
    <div class="workspace">
      <section class="page-heading"><div><h1>${esc(heading)}</h1><p>${searching ? `找到 ${tasks.length} 项任务` : currentProject ? `${remaining(state.tasks.filter(t => t.projectId === view)).length} 项待办` : view === 'today' ? `${todayOpen.length} 项待办 · ${today.length - todayOpen.length} 项已完成` : view === 'inbox' ? '未关联项目的任务' : view === 'done' ? `${completed.length} 项已完成` : `${state.tasks.length} 项任务 · ${state.projects.length} 个项目`}</p></div>
      ${view === 'today' && !searching ? `<div class="date-stamp"><strong>${new Date().getDate()}</strong><span>${new Intl.DateTimeFormat('zh-CN', { month: 'long', weekday: 'long' }).format(new Date())}</span></div>` : `<button class="primary" data-action="new">${icon('plus')}新建任务</button>`}</section>
      ${currentProject && !searching ? `<div class="project-path">${icon('folder')}<span>${esc(currentProject.path || '未关联本地目录')}</span>${currentProject.path ? button('copy', '复制项目路径', 'copy', `data-id="${esc(currentProject.id)}"`) : ''}<small>本地项目</small><button class="small-button" data-action="edit-project" data-id="${esc(currentProject.id)}">编辑项目</button><button class="danger-link" data-action="delete-project" data-id="${esc(currentProject.id)}">删除项目</button></div>` : ''}
      <div class="content-grid ${view !== 'today' || searching ? 'single' : ''}"><section class="task-column">
      ${active && view === 'today' && !searching ? `<div class="focus-card"><div class="focus-label"><span class="pulse"></span>当前正在做</div><div class="focus-title">${esc(active.title)}</div><div class="focus-bottom"><span>${esc(project(active)?.name || '收件箱')}</span><button class="small-button" data-action="toggle" data-id="${esc(active.id)}">${icon('check')}完成</button></div></div>` : ''}
      ${old.length && view === 'today' && !searching ? `<div class="carryover"><span>${old.length} 项之前安排的任务尚未完成</span><button data-action="leftovers">重新选择 ${icon('arrow')}</button></div>` : ''}
      <section class="task-panel"><div class="panel-header"><div class="tabs" role="group" aria-label="任务状态">${!searching && view !== 'done' ? `<button class="${tab === 'open' ? 'chosen' : ''}" data-tab="open">${view === 'today' ? '今日安排' : '待办'}<span>${openCount}</span></button><button class="${tab === 'done' ? 'chosen' : ''}" data-tab="done">已完成<span>${doneCount}</span></button>` : `<strong>${searching ? '搜索结果' : '完成记录'} <span class="muted">${tasks.length}</span></strong>`}</div>${view === 'today' && !searching ? `<button class="text-button" data-action="choose">${icon('plus')}选择任务</button>` : ''}</div>
      <div class="task-list">${tasks.length ? tasks.map(t => taskRow(t, { reorder: view === 'today' && !searching })).join('') : empty(searching ? 'search' : tab === 'done' || view === 'done' ? 'done' : view === 'today' ? 'today' : view === 'inbox' ? 'inbox' : 'project')}</div>
      ${tasks.length && tab === 'open' && !searching && view !== 'done' ? '<button class="add-row" data-action="new">' + icon('plus') + '添加任务</button>' : ''}</section>
      ${view === 'today' && !searching ? '<p class="quiet-note">未加入今天的任务可在项目或“全部任务”中查看。</p>' : ''}
      </section>
      ${view === 'today' && !searching ? `<aside class="project-rail"><div class="rail-heading"><h2>项目概览</h2><span>${state.projects.length} 个项目</span></div>${state.projects.map(projectCard).join('')}</aside>` : ''}</div>
      <footer class="workspace-footer"><span>本地任务管理</span><span>${state.projects.length} 个项目 · ${state.tasks.length} 项任务</span></footer>
    </div>
  </main>`;
}

function renderDialog() {
  if (!modal) return;
  if (modal.type === 'delete') {
    const isTask = modal.kind === 'task';
    const item = (isTask ? state.tasks : state.projects).find(item => item.id === modal.id);
    const count = isTask ? 0 : state.tasks.filter(t => t.projectId === modal.id).length;
    dialog.innerHTML = `<form id="delete-form"><div class="dialog-header"><h2 id="dialog-title">确认删除${isTask ? '这项任务' : '这个项目'}？</h2>${button('close', '关闭', 'close')}</div><div class="form-body"><p class="delete-name">${esc(isTask ? item?.title : item?.name)}</p><p class="field-note">${isTask ? '删除后会同时移除各日期中的安排。可在删除后的提示中撤销。' : `将同时删除项目下全部 ${count} 项任务（包括已完成任务）及其各日期安排。不会删除本地目录或文件。可在删除后的提示中撤销。`}</p></div><div class="dialog-footer"><button type="button" class="secondary" data-action="close" autofocus>取消</button><button type="submit" class="secondary danger-button">${isTask ? '确认删除任务' : count ? `删除项目及 ${count} 项任务` : '确认删除项目'}</button></div></form>`;
  } else if (modal.type === 'choose') {
    const tasks = modal.old ? oldTasks() : remaining(state.tasks);
    dialog.innerHTML = `<div class="dialog-header"><div><h2 id="dialog-title">${modal.old ? '重新安排未完成任务' : '选择今日任务'}</h2><p>加入今天不会改变任务所属的项目。</p></div>${button('close', '关闭', 'close')}</div><div class="picker-list">${tasks.length ? tasks.map(t => taskRow(t, { choose: true })).join('') : '<p class="picker-empty">没有待安排的任务。</p>'}</div><div class="dialog-footer"><span class="muted">已安排 ${remaining(selectedTasks()).length} 项任务</span><button class="primary" data-action="close">完成选择 ${icon('check')}</button></div>`;
  } else if (modal.type === 'project') {
    const p = state.projects.find(p => p.id === modal.id);
    dialog.innerHTML = `<form id="project-form"><div class="dialog-header"><div><h2 id="dialog-title">${p ? '编辑项目' : '新建项目'}</h2></div>${button('close', '关闭', 'close')}</div><div class="form-body"><label>项目名称<input name="name" required maxlength="200" placeholder="输入项目名称" value="${esc(p?.name || '')}" autofocus></label><label>本地项目目录 <span>选填</span><input name="path" maxlength="1000" placeholder="/Users/…" value="${esc(p?.path || '')}"></label><p class="field-note">目录仅作为关联信息，不会自动读取其中的文件。</p></div><div class="dialog-footer"><button type="button" class="secondary" data-action="close">取消</button><button class="primary" type="submit">${p ? '保存修改' : '创建项目'}</button></div></form>`;
  } else {
    const t = state.tasks.find(t => t.id === modal.id);
    const projectId = t ? t.projectId : (state.projects.some(p => p.id === view) ? view : null);
    dialog.innerHTML = `<form id="task-form"><div class="dialog-header"><div><h2 id="dialog-title">${t ? '编辑任务' : '新建任务'}</h2></div>${button('close', '关闭', 'close')}</div><div class="form-body"><label>任务名称<input name="title" required maxlength="300" value="${esc(t?.title || '')}" placeholder="输入任务名称" autofocus></label>${selectField({ name: 'projectId', label: '所属项目', value: projectId || '', options: [{ value: '', label: '收件箱 · 暂不归类' }, ...state.projects.map(p => ({ value: p.id, label: p.name }))] })}<label>备注 <span>选填</span><textarea name="notes" rows="3" maxlength="10000" placeholder="添加备注">${esc(t?.notes || '')}</textarea></label>${!t ? `<label class="checkbox-field"><input type="checkbox" name="today" ${view === 'today' ? 'checked' : ''}>同时加入今天</label>` : ''}</div><div class="dialog-footer"><button type="button" class="secondary" data-action="close">取消</button><div class="footer-actions">${t ? `<button type="button" class="danger-link" data-action="delete-task" data-id="${esc(t.id)}">删除任务</button>` : ''}<button class="primary" type="submit">${t ? '保存修改' : '创建任务'}</button></div></div></form>`;
  }
}

function openModal(value) {
  modal = value;
  renderDialog();
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('[autofocus]')?.focus();
}

document.addEventListener('click', async event => {
  const target = event.target.closest('button');
  if (!target || target.disabled || busy) return;
  if (target.dataset.view) { view = target.dataset.view; query = ''; tab = 'open'; render(); return; }
  if (target.dataset.tab) { tab = target.dataset.tab; render(); return; }
  const { action, id } = target.dataset;
  if (action === 'new') openModal({ type: 'task' });
  if (action === 'edit') openModal({ type: 'task', id });
  if (action === 'choose' || action === 'leftovers') openModal({ type: 'choose', old: action === 'leftovers' });
  if (action === 'delete-task' || action === 'delete-project') {
    if (modal?.needsRefresh) return;
    openModal({ type: 'delete', kind: action === 'delete-task' ? 'task' : 'project', id });
  }
  if (action === 'edit-project') openModal({ type: 'project', id });
  if (action === 'new-project') openModal({ type: 'project' });
  if (action === 'close') dialog.close();
  if (action === 'clear-search') { query = ''; render(); }
  if (action === 'toggle') await mutate({ type: 'toggle', id }, state.tasks.find(t => t.id === id).status === 'done' ? '任务已恢复为待办' : '任务已完成');
  if (action === 'start') await mutate({ type: 'start', id }, state.tasks.find(t => t.id === id).status === 'active' ? '任务已暂停' : '已设为当前任务，并加入今天');
  if (action === 'plan' || action === 'unplan') await mutate({ type: action, id }, action === 'plan' ? '已加入今天' : '已移出今天，任务仍保留');
  if (action === 'up' || action === 'down') await mutate({ type: 'move', id, direction: action === 'up' ? -1 : 1 }, '已调整任务顺序');
  if (action === 'undo' && undoState) await save(undoState, '已撤销上一次修改', false);
  if (action === 'copy') {
    try { await navigator.clipboard.writeText(state.projects.find(p => p.id === id).path); notify('项目路径已复制'); }
    catch { notify('复制失败，可在项目详情中选择并复制路径'); }
  }
  if (action === 'export') {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...state }, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `daylight-${day}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('已导出项目、任务与今日安排');
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
  const name = form.elements.namedItem(form.id === 'project-form' ? 'name' : 'title');
  if (!name.value.trim()) { name.setCustomValidity('请输入名称，不能只有空格'); name.reportValidity(); return; }
  let success;
  if (form.id === 'project-form') success = await mutate({ type: modal.id ? 'project.update' : 'project', id: modal.id || crypto.randomUUID(), name: data.get('name'), path: data.get('path') }, modal.id ? '项目修改已保存' : '项目已创建');
  else success = await mutate({ type: modal.id ? 'edit' : 'add', id: modal.id || crypto.randomUUID(), title: data.get('title'), projectId: data.get('projectId') || null, notes: data.get('notes'), today: data.has('today') }, modal.id ? '修改已保存' : '任务已创建');
  if (success) dialog.close();
});

document.addEventListener('input', event => {
  event.target.setCustomValidity?.('');
  if (event.target.id !== 'search') return;
  const position = event.target.selectionStart;
  query = event.target.value;
  render();
  const input = document.querySelector('#search'); input.focus(); input.setSelectionRange(position, position);
});
dialog.addEventListener('close', () => { modal = null; });
dialog.addEventListener('click', event => {
  if (event.target !== dialog || busy) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
});
document.addEventListener('keydown', event => {
  if (!state || busy) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (!dialog.open) openModal({ type: 'task' }); }
  if (event.key === '/' && !dialog.open && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) { event.preventDefault(); document.querySelector('#search').focus(); }
});
setInterval(() => {
  if (localDate() !== day && !busy) { day = localDate(); render(); if (modal?.type === 'choose') renderDialog(); notify('新的一天，今天的安排已更新'); }
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
      undoState = null;
      render();
      if (search) { const input = document.querySelector('#search'); input.focus(); input.setSelectionRange(selection, selection); }
      notify('已同步工作台的最新修改');
    }
  } catch { /* Keep the last saved view available while the local service restarts. */ }
  finally { refreshing = false; }
}
setInterval(refreshExternal, 3000);
window.addEventListener('focus', refreshExternal);
document.addEventListener('visibilitychange', refreshExternal);

async function openDesktopRoute() {
  if (dialog.open || busy) return;
  await refreshExternal();
  const route = new URLSearchParams(location.hash.slice(1));
  if (route.has('task')) {
    const id = route.get('task');
    if (state.tasks.some(task => task.id === id)) openModal({ type: 'task', id });
  } else if (route.has('new')) openModal({ type: 'task' });
  else if (route.has('today') || route.has('all')) {
    view = route.has('all') ? 'all' : 'today'; query = ''; tab = 'open'; render();
  }
}
window.addEventListener('hashchange', openDesktopRoute);

try { await load(); render(); await openDesktopRoute(); }
catch (error) { app.innerHTML = `<div class="load-error"><h1>暂时无法打开工作台</h1><p>${esc(error.message)}。请确认本地服务正在运行。</p><a href="/">重新连接</a></div>`; }
