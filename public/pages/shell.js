// 全局侧栏（0.8）：品牌 + 工作 / 项目 / 工具三组入口，只用 nav 组件。
import { html } from '../ui/core/html.js';
import { nav, updateNav } from '../ui/components/nav/nav.js';

const TOOLS = [['ai', 'AI 对话', 'chat'], ['proxy', '反向代理', 'grid'], ['cli', 'CLI 配置', 'terminal'], ['extensions', '扩展管理', 'puzzle'], ['update', '更新', 'refresh']];

// sidebarNav({ view, projects, counts, aiActivity, updateAvailable })
//   counts: { open, today, byProject: { [projectId]: n }, inbox }
export function sidebarNav({ view, projects = [], counts = {}, aiActivity = '', updateAvailable = false }) {
  const byProject = counts.byProject || {};
  const item = ([value, label, icon], extra = {}) => ({ value, label, icon, active: view === value, attrs: { 'data-view': value, title: label }, ...extra });
  const tool = ([value, label, icon]) => item([value, label, icon], { count: value === 'ai' ? aiActivity : value === 'update' && updateAvailable ? '有更新' : '' });
  return nav({
    label: '主要导航', kind: 'sidebar',
    header: html`<a class="dl-nav__brand" data-brand href="/" aria-label="Daylight 工作台首页"><img src="/favicon.svg" alt="" width="24" height="24"><span class="dl-nav__brand-text">Daylight</span></a>`,
    sections: [
      { key: 'work', title: '工作', items: [
        item(['all', '任务', 'tasks'], { active: view === 'all' || view === 'done', count: counts.open ?? '' }),
        item(['today', '今天', 'sun'], { count: counts.today || '' }),
        item(['calendar', '日历', 'calendar']),
        item(['focus', '专注统计', 'chart']),
      ] },
      { key: 'projects', title: '项目', action: { label: '新建项目', attrs: { 'data-action': 'new-project' } }, items: [
        ...projects.map(p => ({ value: `project:${p.id}`, label: p.name, dot: p.color || 'neutral', active: view === `project:${p.id}`, count: byProject[p.id] || '', attrs: { 'data-view': `project:${p.id}`, title: p.name } })),
        ...(counts.inbox ? [{ value: 'inbox', label: '未归类', dot: 'neutral', active: view === 'inbox', count: counts.inbox, attrs: { 'data-view': 'inbox', title: '未归类' } }] : []),
      ], empty: projects.length ? '' : '还没有项目' },
      { key: 'tools', title: '工具', items: TOOLS.map(tool) },
    ],
    footer: [item(['settings', '设置', 'gear'])],
  });
}

// 重绘全局侧栏：焦点、滚动位置由 morph / updateNav 保住。
export const updateSidebar = (host, props) => updateNav(host, sidebarNav(props));
