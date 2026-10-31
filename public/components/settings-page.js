import { createExtensionsClient } from '../extensions/client.js';
import { chip } from './chip.js';
import { escapeButtonText as esc } from './button.js';

// 设置页 B 版（0.7）：一列分组卡片 + 顶部分区胶囊锚点 + 右侧「接入状态」概览。
// 分区由 app.js 把各自的模块挂进 [data-settings-slot]（反向代理 / AI 对话 / 专注）；表单、令牌、保存逻辑都留在原模块里，这里只管布局与锚点。
export const settingsSections = [
  { id: 'extensions', label: '本地扩展' },
  { id: 'proxy', label: '反向代理' },
  { id: 'ai', label: 'AI 对话' },
  { id: 'focus', label: '专注' },
  { id: 'shortcuts', label: '快捷键' },
  { id: 'update', label: '应用更新' },
];
const keys = list => `<span class="keys">${list.map(key => `<kbd>${key}</kbd>`).join('')}</span>`;
const shortcut = (title, description, list) => `<li><div><strong>${title}</strong><span>${description}</span></div>${keys(list)}</li>`;

export const settingsPage = `
    <header class="topbar"><span>我的工作空间 <span class="slash">/</span> 设置</span></header>
    <div class="workspace settings-workspace settings-b">
      <section class="page-heading"><div><h1>设置</h1><p>反向代理、AI 对话、专注计时与快捷键</p></div></section>
      <nav class="settings-pills" aria-label="设置分区"><a class="settings-pill" href="#settings" data-settings-anchor="top" aria-current="true">全部</a>${settingsSections.map(section => `<a class="settings-pill" href="#settings" data-settings-anchor="${section.id}">${section.label}</a>`).join('')}</nav>
      <div class="settings-layout">
        <div class="settings-main">
          <section class="settings-group" id="settings-extensions" tabindex="-1" aria-labelledby="extensions-settings-heading">
            <div class="settings-heading"><h2 id="extensions-settings-heading">本地扩展</h2></div>
            <div class="settings-card">
              <div class="settings-row"><div class="settings-row-text"><strong>主来源目录</strong><span>Skills 与 MCP 的统一存放位置，管理 Skills、MCP 与本机软件接入</span></div><div class="settings-row-control"><code class="settings-path">~/.agents</code><a class="secondary settings-link-button" href="#extensions">打开扩展管理</a></div></div>
              <div class="settings-row"><div class="settings-row-text"><strong>接入软件</strong><span data-settings-clients-note>正在读取接入状态…</span></div><div class="settings-row-control"><a class="text-button" href="#extensions&tab=clients">管理接入 ›</a></div></div>
            </div>
          </section>
          <section class="settings-group" id="settings-proxy" tabindex="-1" data-settings-slot="proxy" aria-label="反向代理"></section>
          <section class="settings-group" id="settings-ai" tabindex="-1" data-settings-slot="ai" aria-label="AI 对话"></section>
          <section class="settings-group" id="settings-focus" tabindex="-1" data-settings-slot="focus" aria-label="专注"></section>
          <section class="settings-group" id="settings-shortcuts" tabindex="-1" aria-labelledby="shortcuts-heading">
            <div class="settings-heading"><h2 id="shortcuts-heading">快捷键</h2><p>在快捷面板和主窗口中使用</p></div>
            <div class="settings-card"><ul class="shortcut-list">
              ${shortcut('快捷问答与搜索', '全局唤出临时 AI 问答，也可切换 Google 搜索', ['⌥', 'Space'])}
              ${shortcut('新建任务', '在当前页面打开新建任务表单', ['⌘', 'K'])}
              ${shortcut('搜索任务', '聚焦顶部搜索框，查找任务', ['/'])}
              ${shortcut('打开设置', '从任意页面回到这里', ['⌘', ','])}
              ${shortcut('关闭', '关闭对话框或快捷面板', ['Esc'])}
            </ul></div>
            <div class="settings-heading settings-subheading"><h2 id="quick-heading">快捷问答与搜索</h2><p>按 ⌥ Space 唤出，输入后按 Enter</p></div>
            <div class="settings-card"><dl class="settings-facts">
              <div><dt>临时问答</dt><dd>复用 AI 对话模型与推理设置，仅一轮，关闭即清空</dd></div>
              <div><dt>搜索引擎</dt><dd>切换 Google 模式搜索或打开网址</dd></div>
              <div><dt>打开方式</dt><dd>Google Chrome，未安装时使用系统默认浏览器</dd></div>
              <div><dt>网址识别</dt><dd>输入网址（如 example.com、localhost:3000）直接打开</dd></div>
              <div><dt>关闭方式</dt><dd>Esc、再次按 ⌥ Space，或点击面板外部</dd></div>
            </dl></div>
          </section>
          <section class="settings-group" id="settings-update" tabindex="-1" aria-labelledby="update-settings-heading">
            <div class="settings-heading"><h2 id="update-settings-heading">应用更新</h2></div>
            <div class="settings-card"><div class="settings-row"><div class="settings-row-text"><strong>检查更新与回滚</strong><span>检查新版本、自动更新方式与回滚已移到独立的更新页面</span></div><div class="settings-row-control"><a class="secondary settings-link-button" href="#update">打开更新页面</a></div></div></div>
          </section>
        </div>
        <aside class="settings-rail" aria-label="接入状态">
          <section class="settings-rail-card" data-settings-rail aria-labelledby="settings-rail-title">
            <div class="settings-rail-head"><h2 id="settings-rail-title">接入状态</h2><a class="text-button" href="#extensions&tab=clients">管理</a></div>
            <p class="settings-rail-total" role="status"><strong data-settings-connected>—</strong><span data-settings-total>正在读取…</span></p>
            <ul class="settings-rail-list" data-settings-clients></ul>
          </section>
        </aside>
      </div>
      <footer class="workspace-footer"><span>设置仅保留在本机</span><span>Daylight</span></footer>
    </div>`;

// 接入软件概览：接入 = 用户在「接入软件」里选中。纯函数，方便单测。
export function connectionSummary(clients = []) {
  const list = Array.isArray(clients) ? clients : [];
  const connected = list.filter(client => client.selected), discovered = list.filter(client => !client.selected && client.installed);
  return { total: list.length, connected: connected.length, discovered: discovered.length };
}
export function clientRowMarkup(client) {
  const state = client.selected ? (client.installed ? chip({ label: '已接入', tone: 'connected', dot: true }) : chip({ label: '未找到命令', tone: 'update', dot: true, title: '已选择接入，但没有找到命令' })) : chip({ label: '未接入', tone: 'idle', dot: true });
  return `<li class="settings-rail-row" data-client-id="${esc(client.id)}" data-connection="${client.selected ? 'connected' : 'idle'}"><span class="settings-avatar" aria-hidden="true">${esc(String(client.name || client.id).trim().charAt(0).toUpperCase())}</span><span class="settings-rail-name">${esc(client.name || client.id)}</span>${state}</li>`;
}

export function mountSettingsPage(root, { getToken, fetchImpl } = {}) {
  const pills = [...root.querySelectorAll('[data-settings-anchor]')];
  const groups = settingsSections.map(section => root.querySelector('#settings-' + section.id)).filter(Boolean);
  const reduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const mark = id => { for (const pill of pills) { if (pill.dataset.settingsAnchor === id) pill.setAttribute('aria-current', 'true'); else pill.removeAttribute('aria-current'); } };
  root.addEventListener('click', event => {
    const pill = event.target.closest?.('[data-settings-anchor]'); if (!pill) return;
    event.preventDefault();
    const id = pill.dataset.settingsAnchor, target = id === 'top' ? null : root.querySelector('#settings-' + id);
    if (target) { target.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' }); target.focus({ preventScroll: true }); }
    else window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' });
    mark(id); pinned = id; pinnedAt = Date.now();
  });
  // 滚动时让胶囊跟随当前分区；点击锚点后的 600ms 内以点击为准（滚动动画途中不抢高亮）。
  let pinned = '', pinnedAt = 0, frame = 0;
  const offset = () => parseFloat(getComputedStyle(root.querySelector('.settings-pills')).top || 0) + root.querySelector('.settings-pills').offsetHeight + 24;
  function spy() {
    frame = 0; if (root.hidden || Date.now() - pinnedAt < 600) return;
    const line = offset(); let current = 'top';
    for (const group of groups) if (group.getBoundingClientRect().top <= line) current = group.id.replace('settings-', '');
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4 && groups.length) current = groups.at(-1).id.replace('settings-', '');
    mark(current);
  }
  window.addEventListener('scroll', () => { if (!frame && !root.hidden) frame = requestAnimationFrame(spy); }, { passive: true });

  const client = getToken ? createExtensionsClient({ getToken, fetchImpl }) : null;
  const note = root.querySelector('[data-settings-clients-note]'), list = root.querySelector('[data-settings-clients]');
  let ticket = 0;
  async function refresh() {
    if (!client) return; const mine = ++ticket;
    try {
      const state = await client.state(); if (mine !== ticket) return;
      const clients = state.clients || [], summary = connectionSummary(clients);
      root.querySelector('[data-settings-connected]').textContent = String(summary.connected);
      root.querySelector('[data-settings-total]').textContent = `/ ${summary.total} 个软件已接入`;
      list.innerHTML = clients.map(clientRowMarkup).join('');
      note.textContent = `已接入 ${summary.connected} 个${summary.discovered ? ` · 另有 ${summary.discovered} 个已发现但未接入` : ''}`;
      root.querySelector('[data-settings-rail]').dataset.state = 'ready';
    } catch {
      if (mine !== ticket) return;
      root.querySelector('[data-settings-total]').textContent = '暂时无法读取接入状态';
      note.textContent = '暂时无法读取接入状态，请稍后再试';
      root.querySelector('[data-settings-rail]').dataset.state = 'error';
    }
  }
  return { refresh, dispose() { ticket++; } };
}
