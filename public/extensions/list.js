import { escapeButtonText as esc } from '../components/button.js';

// 扩展页清单（0.7 PR-5）：表格行、表头、骨架、空状态等「数据 → HTML」的纯函数。
// 状态、事件、焦点都留在 page.js；这里不碰 DOM，方便单测。
// 约定的选择器（套件和 e2e 依赖，不要改名）：.extension-row、[data-extension-id]、.extension-row-open、.extension-row-status。

export const columnTitles = {
  skills: ['名称与用途', '启用', '接入软件'],
  mcp: ['名称与 ID', '传输', '状态'],
  clients: ['名称与说明', '接入'],
};
export const emptyCopy = {
  skills: { title: '还没有 Skill', hint: '新建一个 Skill，或把已有的 Skill 目录放进共享来源后重新扫描。', action: '添加 Skill' },
  mcp: { title: '还没有 MCP 服务', hint: '新建一个 MCP 服务，或在接入软件的配置里添加后重新扫描。', action: '添加 MCP 服务' },
  clients: { title: '没有可管理的软件', hint: '常见 CLI 会自动识别；其他 CLI 可以手动登记。', action: '添加 CLI' },
};

// 转义后高亮命中（不区分大小写）。查询为空或没有命中时原样转义；不会把查询当正则。
export function highlight(text, query) {
  const source = String(text ?? ''), needle = String(query || '').trim().toLowerCase();
  if (!needle) return esc(source);
  const lower = source.toLowerCase(); let from = 0, out = '';
  for (let at = lower.indexOf(needle, from); at !== -1; at = lower.indexOf(needle, from)) {
    out += esc(source.slice(from, at)) + '<mark>' + esc(source.slice(at, at + needle.length)) + '</mark>';
    from = at + needle.length;
  }
  return out + esc(source.slice(from));
}
export const countLabel = (shown, total) => shown === total ? `${total} 项` : `显示 ${shown} / ${total}`;

// 探测时间：只显示「时:分」，不显示秒；没有时间就返回空串（不编造）。
export function probeTime(probe) {
  const value = probe?.finishedAt || probe?.startedAt; if (!value) return '';
  const date = new Date(value); if (Number.isNaN(date.getTime())) return '';
  return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}

export function tableHeader(tab) {
  return `<div class="extension-table-head" role="row">${(columnTitles[tab] || columnTitles.skills).map(title => `<span role="columnheader">${esc(title)}</span>`).join('')}</div>`;
}
// 一行。statusCells 是已经拼好的 HTML 数组（skills 一个格：开关组；mcp 两格：传输 + 状态；clients 一格），由 page.js 提供，
// 因为开关/chip 的转义与属性都在组件里。
export function rowMarkup({ tab, item, active, query = '', summary = '', sourceText = '', statusCells = [], tabindex = null }) {
  const attrs = (active ? ' aria-current="true"' : '') + (tabindex === null ? '' : ` tabindex="${tabindex}"`);
  const idLine = tab === 'mcp' ? `<code class="extension-row-id">${highlight(item.id, query)}</code>` : '';
  const source = tab !== 'clients' && sourceText ? `<small>${highlight(sourceText, query)}</small>` : '';
  return `<div class="extension-row ${active ? 'selected' : ''}" role="row"><span role="cell" class="extension-row-main"><button type="button" class="extension-row-open" data-extension-id="${esc(item.id)}"${attrs}><span class="extension-row-copy"><strong>${highlight(item.name, query)}</strong>${idLine}<span>${highlight(summary, query)}</span>${source}</span></button></span>${statusCells.map((cell, index) => `<span role="cell" class="extension-row-status extension-row-cell-${index}">${cell}</span>`).join('')}</div>`;
}

// 骨架：只在加载超过 300ms 才渲染（页面决定何时调用）；装饰性，对读屏隐藏。
export function skeletonRows(count = 5) {
  return `<div class="extension-skeleton" aria-hidden="true">${Array.from({ length: count }, () => '<div class="extension-skeleton-row"><span class="skeleton-bar skeleton-title"></span><span class="skeleton-bar skeleton-line"></span></div>').join('')}</div>`;
}
export function loadingState({ elapsed = 0, label = '正在读取扩展来源…', cancellable = false } = {}) {
  // 文字始终在 DOM 里（读屏与旧套件依赖），>1s 才变为可见；骨架 >300ms 才出现。
  return `<div class="extension-empty extension-loading" role="status" aria-busy="true"><p class="extension-loading-text ${elapsed >= 1000 ? '' : 'extension-visually-hidden'}">${esc(label)}</p>${elapsed >= 300 ? skeletonRows() : ''}${elapsed >= 1000 && cancellable ? '<div class="extension-actions"><button type="button" class="secondary" data-cancel-load>取消</button></div>' : ''}</div>`;
}
// 三段式错误（出了什么 / 为什么 / 怎么办）；有旧数据时不会走到这里（页面保留旧清单，只在 [data-error] 提示）。
export function failureState({ reason = '', hasCache = false } = {}) {
  return `<div class="extension-empty extension-failure" role="alert"><h3>扩展来源读取失败</h3><p>${reason ? esc(reason) : '服务没有返回可用的数据。'}</p><p>${hasCache ? '下面仍是上次读取的内容。' : '请重新扫描后再试。'}</p><div class="extension-actions"><button type="button" class="secondary" data-extension-refresh>重新扫描</button></div></div>`;
}
export function emptyState(tab, { blocked = false } = {}) {
  const copy = emptyCopy[tab] || emptyCopy.skills;
  return `<div class="extension-empty extension-empty-state"><h3>${esc(copy.title)}</h3><p>${esc(copy.hint)}</p><div class="extension-actions"><button type="button" class="secondary" data-empty-create ${blocked ? 'disabled' : ''}>${esc(copy.action)}</button></div></div>`;
}
export function noMatchState() {
  return `<div class="extension-empty extension-no-match"><p>没有匹配项。可调整搜索或筛选。</p><div class="extension-actions"><button type="button" class="secondary" data-clear-filters>清除筛选</button></div></div>`;
}
