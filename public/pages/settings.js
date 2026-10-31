// 设置页（0.8）：左侧二级导航 + 分组卡片。没有「保存」按钮——每个控件的 ui:change 立即写一个键。
// 页面只拼装组件库的组件；数据来自反向代理状态仓库（proxyStore）、扩展服务和 AI 服务。
import { morph } from '../ui/core/morph.js';
import { html } from '../ui/core/html.js';
import { settingsLayout, settingsGroup, settingsRow } from '../ui/patterns/settings/settings.js';
import { input } from '../ui/components/input/input.js';
import { select } from '../ui/components/select/select.js';
import { switchControl } from '../ui/components/switch/switch.js';
import { button } from '../ui/components/button/button.js';
import { mountDialog } from '../ui/components/dialog/dialog.js';
import { showToast } from '../ui/components/toast/toast.js';
import { saveProxySetting } from './proxy-settings-actions.js';
import { viewState, portHint, validPort } from './proxy-service-view.js';

export const settingsSections = [
  { value: 'general', label: '通用' },
  { value: 'extensions', label: '本地扩展' },
  { value: 'proxy', label: '反向代理' },
  { value: 'ai', label: 'AI 对话' },
  { value: 'focus', label: '专注' },
  { value: 'shortcuts', label: '快捷键' },
  { value: 'update', label: '应用更新' },
];
const SUBTITLES = { general: '改动即时保存，无需点击“保存”。' };
const shortcuts = [
  ['快捷问答与搜索', '全局唤出临时 AI 问答，也可切换 Google 搜索', ['⌥', 'Space']],
  ['新建任务', '在当前页面打开新建任务表单', ['⌘', 'K']],
  ['搜索任务', '聚焦顶部搜索框，查找任务', ['/']],
  ['打开设置', '从任意页面回到这里', ['⌘', ',']],
  ['关闭', '关闭对话框或快捷面板', ['Esc']],
];
const quickFacts = [
  ['临时问答', '复用 AI 对话模型与推理设置，仅一轮，关闭即清空'],
  ['搜索引擎', '切换 Google 模式搜索或打开网址'],
  ['打开方式', 'Google Chrome，未安装时使用系统默认浏览器'],
  ['网址识别', '输入网址（如 example.com、localhost:3000）直接打开'],
  ['关闭方式', 'Esc、再次按 ⌥ Space，或点击面板外部'],
];

// 接入软件概览（纯函数，单测用）：接入 = 用户在「接入软件」里选中；found = 本机检测到命令。
export function connectionSummary(clients = []) {
  const list = Array.isArray(clients) ? clients : [];
  const connected = list.filter(client => client.selected), discovered = list.filter(client => !client.selected && client.installed);
  return { total: list.length, connected: connected.length, discovered: discovered.length };
}
export function clientsSummary(clients = []) {
  const list = Array.isArray(clients) ? clients : [];
  const missing = list.filter(client => !client.installed).map(client => client.name || client.id);
  return { total: list.length, found: list.length - missing.length, missing };
}

const keysOf = list => html`<span class="px-keys">${list.map(key => html`<kbd class="dl-kbd">${key}</kbd>`)}</span>`;
const stateDot = tone => html`<span class="px-dot px-dot--${tone}" aria-hidden="true"></span>`;

export function createSettingsPage({ getToken, proxyStore, confirmAction, mountFocus, fetchImpl, extensionsClient, aiBackends = [] }) {
  const element = document.createElement('main');
  element.id = 'settings-page'; element.className = 'settings-page'; element.hidden = true;
  element.innerHTML = '<header class="topbar"><span>我的工作空间 <span class="slash">/</span> 设置</span></header><div class="workspace settings-workspace"><div data-slot="layout"></div><div class="dl-sr-only" role="status" aria-live="polite" data-slot="announce"></div></div>';
  const host = element.querySelector('[data-slot="layout"]'), announce = element.querySelector('[data-slot="announce"]');
  const focusRoot = document.createElement('div'); focusRoot.dataset.settingsSlot = 'focus';
  const extensions = extensionsClient || null;
  const S = { section: 'general', clients: [], clientsState: 'loading', reveal: false, copied: {}, portDraft: null, portError: '', proxyMessage: '', ai: { settings: null, backends: [], catalog: {}, error: '', loading: true, detecting: false, message: '' }, node: '' };
  const groupTitle = text => S.section === 'general' ? text : undefined;
  let visible = false, disposed = false, ticket = 0, focusMounted = false, nodeDialog;
  const status = () => proxyStore.status;

  // ——— AI 后端（/api/ai/*）
  const aiApi = async (route, data) => {
    const response = await (fetchImpl || fetch)('/api/ai/' + route, { method: data ? 'POST' : 'GET', headers: { 'X-Workbench-Token': getToken(), 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
    const body = await response.json(); if (!response.ok) throw new Error(body.error || 'AI 设置请求失败'); return body;
  };
  async function loadAi() {
    try {
      const [settings, detected] = await Promise.all([aiApi('settings'), aiApi('backends')]);
      S.ai.settings = settings.settings; S.ai.backends = detected.backends; S.ai.error = ''; S.ai.loading = false; paint();
      void loadCatalog();
    } catch (error) { S.ai.error = 'AI 设置暂时不可用：' + error.message; S.ai.loading = false; paint(); }
  }
  async function loadCatalog(force = false) {
    const ai = S.ai, backend = ai.settings?.backend; if (!backend) return;
    ai.detecting = true; paint();
    try { const result = await aiApi('discover', { backend, path: ai.settings[backend]?.path, ...(force ? { force: true } : {}) }); if (ai.settings.backend === backend) ai.catalog[backend] = result; ai.message = force ? `已连接，发现 ${result.models.length} 个模型` : ''; }
    catch (error) { ai.message = error.message; }
    finally { ai.detecting = false; paint(); }
  }
  async function saveAi(key, value) {
    const ai = S.ai, backend = ai.settings.backend;
    try {
      ai.settings = (await aiApi('settings/' + key, { value, ...(key === 'backend' ? {} : { backend }) })).settings; ai.message = '';
      say('已保存');
      if (key === 'backend' || key === 'path') void loadCatalog();
    } catch (error) { showToast({ message: error.message, tone: 'error' }); }
    paint();
  }

  // ——— 扩展
  async function loadClients() {
    if (!extensions) { S.clientsState = 'error'; return; }
    const mine = ++ticket;
    try { const state = await extensions.state(); if (mine !== ticket) return; S.clients = state.clients || []; S.reveal = state.capabilities?.extensions?.reveal === true; S.clientsState = 'ready'; }
    catch { if (mine !== ticket) return; S.clientsState = 'error'; }
    paint();
  }

  // ——— 分组
  const say = text => { announce.textContent = ''; setTimeout(() => { announce.textContent = text; }, 30); };
  function extensionsGroup() {
    const summary = clientsSummary(S.clients), ready = S.clientsState === 'ready';
    const hint = S.clientsState === 'error' ? '暂时无法读取接入状态，请稍后再试' : ready ? `${summary.total} 个已登记，${summary.found} 个检测到命令` : '正在读取接入状态…';
    const statusText = !ready ? '' : summary.missing.length ? html`<span class="px-status">${stateDot('warning')}${summary.missing.join(' · ')} 未找到命令</span>` : html`<span class="px-status">${stateDot('success')}全部可用</span>`;
    return settingsGroup({ title: groupTitle('本地扩展'), key: 'g-ext', rows: [
      settingsRow({ key: 'agents', label: '主来源目录', hint: 'Skills 与 MCP 的统一存放位置', control: html`<span class="dl-readout dl-readout--mono">~/.agents</span>${S.reveal ? button({ label: '在访达中显示', attrs: { 'data-action': 'reveal' } }) : button({ label: S.copied.agents ? '已复制' : '复制路径', attrs: { 'data-action': 'copy-agents' } })}` }),
      settingsRow({ key: 'clients', label: '接入软件', hint, control: html`${statusText}${button({ label: '管理 ›', variant: 'ghost', attrs: { 'data-action': 'goto', 'data-href': '#extensions&tab=clients' } })}` }),
    ] });
  }
  function clientsGroup() {
    if (S.clientsState !== 'ready' || !S.clients.length) return '';
    const stateOf = client => client.selected ? ['success', '已接入'] : client.installed ? ['warning', '已检测到，未接入'] : ['neutral', '未找到命令'];
    return settingsGroup({ title: '接入软件状态', key: 'g-clients', rows: S.clients.map(client => { const [tone, text] = stateOf(client); return settingsRow({ key: 'c-' + client.id, label: client.name || client.id, control: html`<span class="px-status">${stateDot(tone)}${text}</span>` }); }) });
  }
  function proxyGroup(extra = false) {
    const current = status(), state = viewState(current), portValue = S.portDraft ?? (current ? String(current.port) : '');
    const node = current?.runtimeError || (current?.node ? `${current.node.version || ''} · ${current.node.path || ''}` : '正在检测…');
    const keyLocked = current?.state !== 'stopped';
    const rows = [
      settingsRow({ key: 'port', label: '本机端口', hint: S.portError || (extra ? portHint(state) : ''), hintTone: S.portError ? 'error' : undefined, control: input({ name: 'port', value: portValue, label: '本机端口', type: 'number', mono: true, invalid: !!S.portError, disabled: !current, attrs: { min: '1024', max: '65535', inputmode: 'numeric' } }) }),
      settingsRow({ key: 'autoStart', label: '随 Daylight 启动代理', hint: '关闭窗口后继续运行，退出 Daylight 时停止', control: switchControl({ name: 'autoStart', checked: !!current?.autoStart, label: '随 Daylight 启动代理', disabled: !current }) }),
      settingsRow({ key: 'node', label: 'Node 运行环境', hint: current?.runtimeError ? '需要 Node 22 或更新版本' : '', hintTone: current?.runtimeError ? 'error' : undefined, control: html`<span class="dl-readout dl-readout--mono">${node}</span>${current?.native ? button({ label: '更改…', attrs: { 'data-action': 'node-path' }, disabled: keyLocked }) : ''}` }),
      settingsRow({ key: 'apikey', label: 'API Key', hint: S.proxyMessage || (keyLocked ? '停止代理后才能更换' : current?.native ? '已保存在钥匙串' : '已保存在本机'), hintTone: S.proxyMessage ? 'error' : undefined, control: button({ label: '更换…', variant: 'danger', disabled: !current || keyLocked || !!current?.runtimeError, attrs: { 'data-action': 'rotate-key' } }) }),
    ];
    return settingsGroup({ title: groupTitle('反向代理'), key: extra ? 'g-proxy-full' : 'g-proxy', rows });
  }
  const backendOptions = () => aiBackends.map(item => { const detected = S.ai.backends.find(backend => backend.id === item.id); return { value: item.id, label: item.name + (detected && !detected.available ? ' · 未检测到' : '') }; });
  function aiGroup(full) {
    const ai = S.ai;
    if (ai.error) return settingsGroup({ title: groupTitle('AI 对话'), key: 'g-ai', rows: [settingsRow({ label: 'AI 设置不可用', hint: ai.error, hintTone: 'error', control: button({ label: '重试', attrs: { 'data-action': 'ai-retry' } }) })] });
    if (!ai.settings) return settingsGroup({ title: groupTitle('AI 对话'), key: 'g-ai', rows: [settingsRow({ label: 'AI 后端', hint: '正在读取 AI 设置…' })] });
    const backend = ai.settings.backend, config = ai.settings[backend] || {}, models = ai.catalog[backend]?.models || [], selected = models.find(model => model.id === config.model);
    const rows = [settingsRow({ key: 'backend', label: 'AI 后端', hint: '自动识别本机 Pi、Qoder、Codex', control: select({ name: 'backend', value: backend, label: 'AI 后端', options: backendOptions() }) })];
    if (full) {
      const efforts = selected?.efforts?.length ? selected.efforts : config.effort ? [config.effort] : [];
      rows.push(
        settingsRow({ key: 'path', label: 'CLI 路径', hint: '留空则自动检测本机安装', control: input({ name: 'path', value: config.path || '', label: 'CLI 路径', placeholder: '自动检测', mono: true }) }),
        settingsRow({ key: 'detect', label: '刷新模型与技能', hint: ai.message, control: button({ label: ai.detecting ? '检测中…' : '重新检测', busy: ai.detecting, disabled: ai.detecting, attrs: { 'data-action': 'ai-detect' } }) }),
        settingsRow({ key: 'model', label: '默认模型', control: select({ name: 'model', value: config.model || '', label: '默认模型', options: [{ value: '', label: '请先检测并选择模型' }, ...(config.model && !models.some(model => model.id === config.model) ? [{ value: config.model, label: config.model }] : []), ...models.map(model => ({ value: model.id, label: model.name || model.id }))] }) }),
        settingsRow({ key: 'effort', label: '思考强度', control: select({ name: 'effort', value: config.effort || '', label: '思考强度', options: [{ value: '', label: '使用 CLI 默认值' }, ...efforts.map(effort => ({ value: effort, label: effort }))] }) }),
        settingsRow({ key: 'accessMode', label: '访问模式', hint: '完全访问允许读写文件、执行命令和访问网络，无需逐次确认；从下一次发送生效', control: select({ name: 'accessMode', value: config.accessMode || 'standard', label: '访问模式', options: [{ value: 'standard', label: '标准 · 按需确认' }, { value: 'full', label: '完全访问 · 不询问命令权限' }] }) }),
      );
      if (backend === 'pi') rows.push(settingsRow({ key: 'ctx', label: '上下文与输出', hint: 'Pi 使用模型原生上下文窗口与最大输出' }));
      else {
        rows.push(selected?.contextWindows?.length
          ? settingsRow({ key: 'contextWindow', label: '上下文窗口（Token）', hint: '设置不会扩大模型真实能力', control: select({ name: 'contextWindow', value: String(config.contextWindow || ''), label: '上下文窗口', options: [{ value: '', label: '使用模型默认值' }, ...selected.contextWindows.map(n => ({ value: String(n), label: n.toLocaleString() }))] }) })
          : settingsRow({ key: 'contextWindow', label: '上下文窗口（Token）', hint: '设置不会扩大模型真实能力', control: input({ name: 'contextWindow', value: String(config.contextWindow || ''), label: '上下文窗口', type: 'number', placeholder: '模型默认值', attrs: { min: '1', max: '10000000' } }) }));
        rows.push(backend === 'qoder'
          ? settingsRow({ key: 'maxOutputTokens', label: '最大输出（Token）', hint: '不支持的取值会在发送时报错', control: input({ name: 'maxOutputTokens', value: String(config.maxOutputTokens || ''), label: '最大输出', type: 'number', placeholder: 'CLI 默认值', attrs: { min: '1', max: '10000000' } }) })
          : settingsRow({ key: 'maxOut', label: '最大输出', hint: 'Codex 未提供已适配的最大输出设置，使用运行时默认值' }));
      }
    }
    return settingsGroup({ title: groupTitle('AI 对话'), key: full ? 'g-ai-full' : 'g-ai', rows });
  }
  function shortcutsBody() {
    return html`${settingsGroup({ title: '快捷键', key: 'g-keys', rows: shortcuts.map(([label, hint, list], index) => settingsRow({ key: 'k' + index, label, hint, control: keysOf(list) })) })}${settingsGroup({ title: '快捷问答与搜索', key: 'g-quick', rows: quickFacts.map(([label, hint], index) => settingsRow({ key: 'q' + index, label, hint })) })}`;
  }
  function body() {
    switch (S.section) {
      case 'general': return html`${extensionsGroup()}${proxyGroup()}${aiGroup(false)}`;
      case 'extensions': return html`${extensionsGroup()}${clientsGroup()}`;
      case 'proxy': return html`${proxyGroup(true)}<p class="px-note">服务开关、来源与接入配置在<a href="#proxy" data-action="goto" data-href="#proxy">反向代理</a>页。</p>`;
      case 'ai': return html`${aiGroup(true)}`;
      case 'focus': return html`<div class="px-focus" data-key="focus-slot" data-ui-static></div>`;
      case 'shortcuts': return shortcutsBody();
      default: return html`${settingsGroup({ title: '应用更新', key: 'g-update', rows: [settingsRow({ label: '检查更新与回滚', hint: '检查新版本、自动更新方式与回滚在独立的更新页面', control: button({ label: '打开更新页面', attrs: { 'data-action': 'goto', 'data-href': '#update' } }) })] })}`;
    }
  }
  function view() {
    const sections = [{ key: 'settings-nav', items: settingsSections.map(item => ({ ...item, active: item.value === S.section })) }];
    const label = settingsSections.find(item => item.value === S.section).label;
    return settingsLayout({ navLabel: '设置分类', sections, title: label, subtitle: SUBTITLES[S.section] || '', children: body() });
  }
  function paint() {
    if (disposed || !visible) return;
    morph(host, view());
    const switchEl = host.querySelector('.dl-switch[data-name="autoStart"]');
    if (switchEl) switchEl.setAttribute('aria-checked', String(!!status()?.autoStart));
    const slotEl = host.querySelector('.px-focus');
    if (slotEl && !slotEl.firstChild) { if (!focusMounted) { mountFocus(focusRoot); focusMounted = true; } slotEl.append(focusRoot); }
  }

  // ——— 事件
  async function savePort(raw) {
    const text = String(raw).trim();
    if (!validPort(text)) { S.portDraft = text; S.portError = '端口需为 1024–65535 的整数'; return paint(); }
    S.portDraft = null; S.portError = '';
    if (Number(text) === status()?.port) return paint();
    const failure = await saveProxySetting(proxyStore, 'port', Number(text));
    if (failure && !/已被占用/.test(failure)) S.portError = failure; else say('已保存');
    paint();
  }
  async function rotateKey() {
    if (!await confirmAction('更换 API Key？', '现有客户端中的旧密钥将立即失效，需要重新复制配置。', '更换密钥')) return;
    try { await proxyStore.api.request('key/rotate', {}); S.proxyMessage = ''; showToast({ message: '密钥已更换，请更新客户端配置', tone: 'success' }); }
    catch (error) { S.proxyMessage = error.message; }
    paint();
  }
  function openNodeDialog() {
    nodeDialog?.destroy();
    const current = status();
    nodeDialog = mountDialog({ id: 'node-path-dialog', label: '更改 Node 路径', width: 480, children: html`<div class="px-dlg"><h2 class="px-dlg__title">更改 Node 路径</h2><p class="px-dlg__text">留空自动检测，或填写 Node 22+ 的绝对路径。</p>${input({ name: 'nodePath', value: current?.node?.path || '', label: 'Node 路径', mono: true, placeholder: '自动检测' })}<p class="px-dlg__error" role="alert" data-node-error></p><div class="px-dlg__acts">${button({ label: '取消', variant: 'ghost', attrs: { 'data-dlg': 'cancel' } })}${button({ label: '保存', variant: 'primary', attrs: { 'data-dlg': 'save', 'data-dialog-submit': '' } })}</div></div>` });
    const el = nodeDialog.el;
    el.addEventListener('click', async event => {
      const action = event.target.closest?.('[data-dlg]')?.dataset.dlg; if (!action) return;
      if (action === 'cancel') return nodeDialog.close();
      const value = el.querySelector('input[name="nodePath"]').value.trim(), error = el.querySelector('[data-node-error]');
      try { await proxyStore.api.request('runtime', { nodePath: value }); await proxyStore.refresh(); nodeDialog.close(); say('Node 路径已保存'); paint(); }
      catch (failure) { error.textContent = failure.message; }
    });
    nodeDialog.open();
  }
  element.addEventListener('ui:select', event => { if (event.target.closest('.dl-set__nav')) { S.section = event.detail.value; paint(); } });
  element.addEventListener('ui:change', async event => {
    const target = event.target, name = target.dataset?.name || target.name || target.closest?.('[data-name]')?.dataset.name, { value } = event.detail;
    if (target.closest('#node-path-dialog')) return;
    if (name === 'port') return savePort(value);
    if (name === 'autoStart') { S.proxyMessage = await saveProxySetting(proxyStore, 'autoStart', value); if (!S.proxyMessage) say('已保存'); return paint(); }
    if (['backend', 'path', 'model', 'effort', 'accessMode', 'contextWindow', 'maxOutputTokens'].includes(name)) {
      const numeric = ['contextWindow', 'maxOutputTokens'].includes(name);
      return saveAi(name, numeric ? (String(value).trim() === '' ? null : Number(value)) : value);
    }
  });
  element.addEventListener('click', async event => {
    const control = event.target.closest?.('[data-action]'); if (!control || !element.contains(control)) return;
    const action = control.dataset.action;
    if (action === 'goto') { event.preventDefault(); location.hash = control.dataset.href; return; }
    if (action === 'copy-agents') { try { await navigator.clipboard.writeText('~/.agents'); S.copied.agents = true; paint(); setTimeout(() => { delete S.copied.agents; paint(); }, 1600); } catch { showToast({ message: '复制未完成，请手动选择路径。', tone: 'error' }); } return; }
    if (action === 'reveal') { try { await extensions.reveal({ kind: 'mcpConfig' }); } catch (error) { showToast({ message: error.message, tone: 'error' }); } return; }
    if (action === 'rotate-key') return rotateKey();
    if (action === 'node-path') return openNodeDialog();
    if (action === 'ai-detect') return loadCatalog(true);
    if (action === 'ai-retry') { S.ai.error = ''; S.ai.loading = true; paint(); return loadAi(); }
  });
  const unsubscribe = proxyStore.subscribe(() => { if (visible && S.section !== 'ai' && S.section !== 'extensions' && S.section !== 'focus') paint(); });

  return {
    element,
    setVisible(value) {
      element.hidden = !value; if (visible === value) return; visible = value;
      if (value) { paint(); void loadClients(); if (!S.ai.settings) void loadAi(); }
    },
    select(section) { if (settingsSections.some(item => item.value === section)) { S.section = section; paint(); } },
    dispose() { disposed = true; ticket++; unsubscribe(); nodeDialog?.destroy(); },
  };
}
