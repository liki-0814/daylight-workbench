// Stateless helpers shared by the main page orchestrator (app.js).
// Keep this module free of app state so it can be imported anywhere without cycles.
import { icon } from './components/icons.js';

export const pageViews = ['proxy', 'settings', 'update', 'ai', 'cli', 'focus', 'extensions'];
export const isPage = value => pageViews.includes(value);
export const sectionFor = value => isPage(value) ? value : 'task';

export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function empty(kind) {
  const content = {
    today: ['sun', '今天暂无任务', '从已有任务中选择，或新建任务加入今天。', '<button class="primary" data-action="choose">从项目中选择' + icon('arrow') + '</button>'],
    done: ['check', '暂无已完成任务', '已完成的任务会显示在这里，可恢复为待办。', ''],
    inbox: ['inbox', '未归类为空', '未关联项目的任务显示在这里。', '<button class="primary" data-action="new">新建任务' + icon('plus') + '</button>'],
    search: ['search', '没有找到匹配的任务', '试试其他关键词，或清空搜索。', '<button class="small-button" data-action="clear-search">清空搜索</button>'],
    project: ['folder', '暂无任务', '点击“新建任务”添加任务。', '<button class="primary" data-action="new">新建任务' + icon('plus') + '</button>'],
  }[kind];
  return `<div class="empty"><h3>${content[1]}</h3><p>${content[2]}</p>${content[3]}</div>`;
}
