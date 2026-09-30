import { localDate } from '../model.js';
import { icon } from './icons.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const remaining = tasks => tasks.filter(task => task.status !== 'done').length;

// Both pages share the same elements so counts, wrapping and spacing stay stable.
export function sidebarContent({ state, day = localDate(), view = 'today', searching = false, busy = false }) {
  const current = id => view === id && !searching;
  const nav = (id, label, symbol, count) => `<button class="nav-item ${current(id) ? 'active' : ''}" data-view="${id}" ${current(id) ? 'aria-current="page"' : ''}>${icon(symbol)}<span>${label}</span><small>${count}</small></button>`;
  const today = new Set(state.plans[day] || []);
  return `
    <a class="brand" href="/" aria-label="Daylight 工作台首页"><img src="/favicon.svg" alt="" width="35" height="35"><span>Daylight<small>项目与任务管理</small></span></a>
    <button class="capture" data-action="new">${icon('plus')}新建任务<span>⌘ K</span></button>
    <nav aria-label="主要导航">${nav('today', '今天', 'sun', remaining(state.tasks.filter(t => today.has(t.id))))}${nav('inbox', '收件箱', 'inbox', remaining(state.tasks.filter(t => t.projectId === null)))}${nav('all', '全部任务', 'grid', remaining(state.tasks))}${nav('done', '已完成', 'check', state.tasks.length - remaining(state.tasks))}</nav>
    <button class="nav-item ${current('ai') ? 'active' : ''}" data-view="ai" ${current('ai') ? 'aria-current="page"' : ''}>${icon('chat')}<span>AI 对话</span></button>
    <button class="nav-item ${current('proxy') ? 'active' : ''}" data-view="proxy" ${current('proxy') ? 'aria-current="page"' : ''}>${icon('grid')}<span>反向代理</span></button>
    <div class="nav-label">我的项目<button type="button" class="icon-button" data-action="new-project" title="新建项目" aria-label="新建项目" ${busy ? 'disabled' : ''}>${icon('plus')}</button></div>
    <nav class="project-nav" aria-label="项目">${state.projects.map(p => `<button class="nav-item ${current(p.id) ? 'active' : ''}" data-view="${esc(p.id)}" ${current(p.id) ? 'aria-current="page"' : ''}><i class="dot ${esc(p.color)}"></i><span>${esc(p.name)}</span><small>${remaining(state.tasks.filter(t => t.projectId === p.id))}</small></button>`).join('')}</nav>
    <div class="sidebar-footer"><button data-view="settings" ${current('settings') ? 'aria-current="page"' : ''}>设置 ${icon('gear')}</button></div>`;
}
