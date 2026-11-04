import { icon } from './icons.js';
import { actionButton } from './button.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function sidebarContent({ state, view = 'all', aiActivity = '', updateAvailable = false, collapsed = true }) {
  const taskPage = !['ai', 'proxy', 'cli', 'update', 'settings', 'focus', 'extensions'].includes(view);
  const nav = (id, label, symbol, extra = '') => {
    const active = id === 'all' ? taskPage : view === id;
    return `<button class="nav-item ${active ? 'active' : ''}" data-view="${id}" ${active ? 'aria-current="page"' : ''} aria-label="${label}" title="${label}${id === 'ai' && aiActivity ? ' · ' + esc(aiActivity) : ''}">${icon(symbol)}<span>${label}</span>${extra}</button>`;
  };
  return `<a class="brand" href="/" aria-label="Daylight 工作台首页"><img src="/favicon.svg" alt="" width="35" height="35"><span>Daylight<small>项目与任务管理</small></span></a>
    ${actionButton({variant:'icon',iconOnly:true,className:'sidebar-toggle',symbol:'menu',label:collapsed?'展开导航':'收起导航',attrs:{'data-action':'toggle-sidebar','aria-expanded':String(!collapsed)}})}${actionButton({variant:'text',className:'capture',symbol:'plus',label:'新建任务',attrs:{'data-action':'new','aria-label':'新建任务',title:'新建任务（⌘ K）'},content:'<span class="capture-label">新建任务</span><span class="capture-shortcut">⌘ K</span>'})}
    <nav class="page-navigation" aria-label="主要导航">${nav('all','任务','tasks')}${nav('ai','AI 对话','chat',`<small data-ai-activity>${esc(aiActivity)}</small>`)}${nav('proxy','反向代理','grid')}${nav('cli','CLI 配置','terminal')}${nav('extensions','扩展管理','plug')}${nav('update','更新','refresh', updateAvailable ? '<small data-app-update>有更新</small>' : '')}${nav('settings','设置','gear')}</nav>`;
}

export function revealNavigationItem(target) {
  target?.closest?.('.page-navigation .nav-item')?.scrollIntoView({ block:'nearest', inline:'nearest', behavior:'instant' });
}
