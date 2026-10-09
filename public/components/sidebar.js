import { icon } from './icons.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function sidebarContent({ state, view = 'all', aiActivity = '' }) {
  const taskPage = !['ai', 'proxy', 'cli', 'settings', 'focus', 'extensions'].includes(view);
  const nav = (id, label, symbol, extra = '') => {
    const active = id === 'all' ? taskPage : view === id;
    return `<button class="nav-item ${active ? 'active' : ''}" data-view="${id}" ${active ? 'aria-current="page"' : ''}>${icon(symbol)}<span>${label}</span>${extra}</button>`;
  };
  return `<a class="brand" href="/" aria-label="Daylight 工作台首页"><img src="/favicon.svg" alt="" width="35" height="35"><span>Daylight<small>项目与任务管理</small></span></a>
    <button class="capture" data-action="new">${icon('plus')}新建任务<span>⌘ K</span></button>
    <nav class="page-navigation" aria-label="主要导航">${nav('all','任务','tasks')}${nav('focus','专注统计','chart')}${nav('ai','AI 对话','chat',`<small data-ai-activity>${esc(aiActivity)}</small>`)}${nav('proxy','反向代理','grid')}${nav('cli','CLI 配置','terminal')}${nav('extensions','扩展管理','grid')}${nav('settings','设置','gear')}</nav>`;
}
