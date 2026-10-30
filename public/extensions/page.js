import { createExtensionsClient } from './client.js';
import { shownText, conflictOf, isOpenConflict, conflictSupported, conflictNote, conflictHint, conflictPanel, compareView, conflictErrorMessage, conflictShouldRefresh, conflictBlock, resolveTitle, resolveIntro } from './conflict.js';
import { createExtensionsController } from './controller.js';
import { extensionPlanContent } from './review.js';
import { extensionCapability } from './capabilities.js';
import { addMenuMarkup, addMenuItems, mountAddMenu } from './add-menu.js';
import { createFolderPicker, folderPickerAvailable } from './folder-picker.js';
import { validateSourcePath, importPhaseView, importFailure, importHasConflict, importConflictNote, importUnknownMessage, importDialogIntro, sourcePathLabel, sourcePathHint } from './skill-import.js';
import { backupList, backupMeta, restoreNoticeText, revealBody, revealErrorMessage, revealFallbackPath } from './restore-reveal.js';
import { mcpCompareSupported, mcpCompareView, conflictChoiceList, replaceConfirm, cleanChoices, allChosen, adoptedIds, mcpCompareErrorMessage, mcpShouldRefresh, resolutionLabel, settleDuplicateFieldError } from './mcp-conflict.js';
import { connectedState, stageKey, hasMasterSwitch, skillEnabled, stageChange, stagedValue, stagedKindFor, pruneStaged, actionFor, rememberedLabel, describeChange, tildePath, tildeText, batchTitle, barLabel, partialSummary, appliedMessage, undoable, undoActions } from './staging.js';
import { probeAllPlan, chunkIds, PROBE_BATCH_SIZE, resumablePlan, redactArgs, progressOf, progressText, finishText, hasMcpSwitch, mcpHealth, toolCountLabel, commandLine, refRows, refBadge, refHints, refStatusLabels, refNote, probeCard, activeProbe, finishedProbe, mcpErrorMessage, shouldRefresh, disabledProbeHint } from './mcp.js';
import { rowMarkup, tableHeader, loadingState, failureState, emptyState, noMatchState, countLabel, probeTime } from './list.js';
import { extensionsRoute } from '../routes.js';
import { escapeButtonText as esc, actionButton } from '../components/button.js';
import { sectionHeading, refreshButton, setRefreshState } from '../components/section.js';
import { segmentedControl, mountSegmentedControl } from '../components/segmented-control.js';
import { createSheet, sheetFooter } from '../components/sheet.js';
import { switchControl } from '../components/switch.js';
import { searchField, mountSearchField, focusVisibleSearchField } from '../components/search-field.js';
import { chip } from '../components/chip.js';
import { bannerMarkup, copyText, showToast } from '../components/banner.js';
import { selectField, updateSelectField } from '../components/select.js';
import { validateExtensionForm, findDuplicateServer, duplicateMessage, insecureHttpWarning, mcpIdError, skillDirectoryError, mcpUrlError, fieldInputName, diagnosticsForTab, corruptMcpConfig, detailErrorMessage, tabKinds } from './controller.js';

const categories = [
  { value: 'skills', label: 'Skills', collection: 'skills', title: 'Skills 来源', action: '新建 Skill' },
  { value: 'mcp', label: 'MCP 服务', collection: 'servers', title: 'MCP 配置', action: '新建 MCP 服务' },
  { value: 'clients', label: '接入软件', collection: 'clients', title: '本地 CLI', action: '添加 CLI' },
];
const bindingLabel = { managed: '链接由 Daylight 管理', existing: '已有正确链接', conflict: '同名位置冲突，未改动', not_connected: '打开后加入待应用的变更' };
const textField = (name, label, value = '', attrs = '') => `<label>${label}<input name="${name}" value="${esc(value)}" ${attrs}></label>`;
const chooseClientsPrompt = `<p>请先在<a href="${extensionsRoute({ tab: 'clients' })}">接入软件</a>中选择要管理的 CLI。</p>`;
const refText = refs => Object.entries(refs || {}).map(([key, ref]) => key + '=' + ref).join('\n');
const parseRefs = text => Object.fromEntries(text.split('\n').filter(line => line.trim()).map(line => { const at = line.indexOf('='); if (at < 1) throw new Error('环境变量引用每行填写 名称=环境变量名'); return [line.slice(0, at).trim(), line.slice(at + 1).trim()]; }));

export function createExtensionsPage({ getToken, onDiscuss, onChanged }) {
  const client = createExtensionsClient({ getToken }), controller = createExtensionsController({ client, onChanged });
  const element = document.createElement('main'); element.className = 'extensions-page'; element.hidden = true;
  element.innerHTML = `<header class="topbar"><span>我的工作空间 <span class="slash">/</span> 扩展管理</span></header><div class="workspace extensions-workspace"><section class="page-heading"><div><h1>扩展管理</h1><p>管理共享来源及你选择接入的本机 CLI。</p></div>${refreshButton({ ariaLabel: '重新扫描扩展', attrs: { 'data-extension-refresh': true } })}</section><div class="extension-tabs"></div><div class="extension-toolbar">${searchField({ label: '搜索扩展', placeholder: '搜索名称、用途或路径', className: 'extension-search' })}<div class="extension-software-filter"><span>软件</span>${selectField({ id: 'extensions-client-filter', name: 'client', label: '按软件筛选', compact: true, hideLabel: true, options: [{ value: '', label: '全部软件' }] })}</div><label class="extension-problem-filter"><input type="checkbox" data-problems>仅看问题</label><div class="extension-category-action extension-add-slot" data-create-slot></div></div><p class="extension-error" role="alert" data-error></p><div data-cancelled-slot></div><div data-restore-slot></div><div class="extension-load-strip" data-load-status hidden></div><div data-submission aria-live="polite"></div><span class="extension-visually-hidden" role="status" data-list-status></span><span class="extension-visually-hidden" role="status" data-probe-live></span><div class="extension-browser"><section class="extension-list" aria-label="扩展清单"></section><aside class="extension-detail" aria-label="扩展详情" tabindex="-1" hidden></aside></div><div class="extension-staging-bar" data-staging-bar role="region" aria-label="待应用的变更" hidden><span class="extension-staging-count" data-staging-count></span><span class="extension-staging-actions"><button type="button" class="text-button" data-staging-revert>还原</button><button type="button" class="primary" data-staging-review>预览并应用</button></span></div></div>`;
  const $ = selector => element.querySelector(selector);
  let route = { tab: 'skills', query: '' }, restoreNotice = null, state, readFailure, selected, detailTicket = 0, visible = false, tabsDispose, shell, probeTimer, detailKey = '', listMarkup, rovingId = '', detailTimer, focusDetailOnRender = false, submitting = false, selectionPreviewing = false, staged = new Map(), batchBusy = false, liveProbes = new Map(), probeWatching = null, probeAllRun = null, probeAllTimer = 0, loadView = {}, loadStartedAt = 0, loadStripTimer, focusBeforeLoad = null;
  let addMenu = null;   // 「添加 ▾」菜单的行为（slot 常驻，内容随页签重绘）
  const category = () => categories.find(item => item.value === route.tab) || categories[0];
  const liveServer = server => state?.servers.find(item => item.id === server.id) || server;
  // 检测进度的页面内覆盖：进行中的检测每 0.5–0.8s 轮询一次，比 10s 一次的整页刷新快；整页刷新带回 lastProbe 后自动让位。
  const probeOf = server => liveProbes.get(server.id) || server.lastProbe || null;
  const liveSkill = skill => state?.skills.find(item => item.id === skill.id) || skill;
  // 暂存（只在页面内存里，/prepare 与 /actions 才是真正动手的地方）：总开关和接入开关都先记下想要的值，右下「预览并应用」才逐项预览、应用。
  function masterControl(skill, compact = true) {
    const live = liveSkill(skill);
    if (!hasMasterSwitch(live)) return compact ? '<span class="extension-master-none"><span aria-hidden="true">—</span><span class="extension-visually-hidden">此 Skill 不能停用</span></span>' : '';
    const change = { kind: 'skill', id: live.id }, pending = staged.has(stageKey(change)), checked = stagedValue(staged, change, skillEnabled(live));
    const reason = stagedKindFor(staged, live.id) === 'binding' ? '已暂存接入变更，先应用或还原' : '';
    const remembered = !checked && !pending ? rememberedLabel(live, state) : '';
    return switchControl({ label: live.name + ' · 启用', text: checked ? '已启用' : '已停用', hint: reason ? (compact ? '接入待应用' : reason) : remembered, checked, pending, busy: batchBusy && pending, disabled: !!reason || batchBusy, title: reason || (checked ? '停用后软件里的链接会被移除，重新启用时恢复' : '启用后会恢复之前接入的软件'), className: 'extension-binding-control extension-master-control', inputAttrs: { 'data-master-toggle': true, 'data-skill': live.id } });
  }
  function bindingControl(skill, binding, compact = false) {
    const software = state.clients.find(item => item.id === binding.clientId);
    if (binding.state === 'local') return `<span>${esc(software.name)} · 本地专有${skill.linked ? '链接' : ''}</span>`;
    const live = liveSkill(skill), conflict = binding.state === 'conflict', actual = connectedState(binding.state), note = conflict ? conflictNote(binding) : bindingLabel[binding.state];
    const change = { kind: 'binding', id: skill.id, clientId: binding.clientId }, pending = staged.has(stageKey(change)), checked = stagedValue(staged, change, actual);
    const masterStaged = stagedKindFor(staged, skill.id) === 'skill', offSkill = !skillEnabled(live) && !actual && !pending;
    const reason = conflict ? '' : masterStaged ? '已暂存总开关变更，先应用或还原' : offSkill ? '已停用，启用后才能接入' : '';
    const disabled = conflict || batchBusy || !!reason || (skill.readOnly && !skill.valid);
    return switchControl({ label: skill.name + ' · ' + software.name, text: software.name, hint: !compact ? (reason || note) : conflict ? conflictHint(binding) : masterStaged ? '总开关待应用' : offSkill ? '已停用' : '', checked, pending, busy: batchBusy && pending, disabled, title: reason || note, className: 'extension-binding-control', inputAttrs: { 'data-binding-toggle': true, 'data-skill': skill.id, 'data-client': binding.clientId } });
  }
  // 检查器里的冲突块（E-11）：对比 / 采用 / 保留 / 重新处理。总开关有暂存时采用和保留置灰；Skill 已停用时只有采用置灰；原因写在块里。
  function conflictBlockFor(skill, binding) {
    if (!conflictOf(binding) || !conflictSupported(state?.capabilities)) return '';
    return conflictPanel({ skill, binding, client: state.clients.find(item => item.id === binding.clientId), root: state.root || '', busy: batchBusy, masterStaged: stagedKindFor(staged, skill.id) === 'skill', skillOff: !skillEnabled(liveSkill(skill)) });
  }
  function bindingRow(skill, binding, showSkillName = false) {
    return `<div class="extension-binding"><div>${showSkillName ? `<a href="${extensionsRoute({ tab: 'skills', id: skill.id })}">${esc(skill.name)}</a>` : ''}${bindingControl(skill, binding)}</div>${binding.state === 'existing' ? `<details><summary>管理记录</summary><button type="button" class="text-button" data-binding="adopt" data-skill="${esc(skill.id)}" data-client="${esc(binding.clientId)}">记录链接归属（可选）</button></details>` : ''}</div>`;
  }
  // 开关（总开关或接入开关）在清单或检查器里的同一个控件：用于重绘后把焦点还给它。
  function findToggle(data, area) {
    const master = data.masterToggle !== undefined, root = $(area === 'list' ? '.extension-list' : '.extension-detail');
    if (data.mcpSwitch !== undefined) return [...root.querySelectorAll('[data-mcp-switch]')].find(input => input.dataset.mcp === data.mcp);
    return [...root.querySelectorAll(master ? '[data-master-toggle]' : '[data-binding-toggle]')].find(input => input.dataset.skill === data.skill && (master || input.dataset.client === data.client));
  }
  // 暂存发生变化后重绘清单、检查器和底栏；焦点留在同一个开关上。
  function renderStaged() {
    const inDetail = $('.extension-detail').contains(document.activeElement) ? { ...document.activeElement.dataset } : null;
    listMarkup = undefined; renderList(); if (selected) renderDetail({ keepFocus: true });
    if (inDetail && (inDetail.bindingToggle !== undefined || inDetail.masterToggle !== undefined || inDetail.mcpSwitch !== undefined)) findToggle(inDetail, 'detail')?.focus({ preventScroll: true });
    renderBar();
  }
  function renderBar() {
    const bar = $('[data-staging-bar]'), count = staged.size;
    bar.hidden = !count;
    $('[data-staging-count]').textContent = count ? barLabel(count) : '';
    for (const button of bar.querySelectorAll('button')) button.disabled = batchBusy;
  }
  function stageToggle(input) {
    if (batchBusy || !state) return;
    if (input.dataset.mcpSwitch !== undefined) {
      if (!state.servers.some(item => item.id === input.dataset.mcp)) return;
      staged = stageChange(staged, { kind: 'mcp', id: input.dataset.mcp, want: input.checked }, state); setError(null); renderStaged(); return;
    }
    const live = state.skills.find(item => item.id === input.dataset.skill); if (!live) return;
    const change = input.dataset.masterToggle !== undefined ? { kind: 'skill', id: live.id, want: input.checked } : { kind: 'binding', id: live.id, clientId: input.dataset.client, want: input.checked };
    staged = stageChange(staged, change, state); setError(null); renderStaged();
  }
  function revertStaged() { staged = new Map(); renderStaged(); }
  async function toggleClientSelection(control) {
    if (selectionPreviewing) return;
    const item = state.clients.find(item => item.id === control.dataset.client);
    if (!item) return;
    const area = control.closest('.extension-list') ? '.extension-list' : '.extension-detail';
    if (control.type === 'checkbox') control.checked = item.selected;
    const restore = () => {
      selectionPreviewing = false; listMarkup = undefined; renderList(); if (selected) renderDetail();   // 同 toggleBinding：强制重绘以解除脚本置灰（E-26）
      if (visible) [...$(area).querySelectorAll('[data-cli-selection]')].find(input => input.dataset.client === item.id)?.focus();
    };
    selectionPreviewing = true; control.disabled = true;
    try { await preview({ type: 'client.select', clientId: item.id, selected: !item.selected }, { title: item.selected ? '确认取消 CLI 接入' : '确认选择 CLI 接入', onClose: restore }); }
    catch (error) { restore(); setError(error); }
  }
  function setError(error) { $('[data-error]').textContent = error?.message || ''; }
  function changeRoute(next, replace = false, { soon = false } = {}) {
    route = { ...route, ...next };
    history[replace ? 'replaceState' : 'pushState'](null, '', '/' + extensionsRoute(route)); renderClientFilter(); renderTabs(); renderList();
    if (soon) loadDetailSoon(); else void loadDetail();
  }
  // 方向键连续移动时不要每一行都请求详情：停下 150ms 后再读（清单高亮立即更新）。
  function loadDetailSoon() { clearTimeout(detailTimer); detailTimer = setTimeout(() => { if (visible) void loadDetail(); }, 150); }
  // ≤999 检查器是覆盖层：打开后焦点必须进去；关闭（按钮或 Esc）后焦点回到刚才那一行。
  const overlayMode = () => window.matchMedia('(max-width: 999px)').matches;
  const rowButton = id => [...$('.extension-list').querySelectorAll('.extension-row-open')].find(button => button.dataset.extensionId === id);
  function closeDetail() {
    const id = route.id; changeRoute({ id: null, operation: null, file: null });
    if (id) { const button = rowButton(id); if (button) { rovingId = id; applyRoving(); button.focus({ preventScroll: true }); } }
  }
  function focusDetail() { ((overlayMode() && $('.extension-back')) || $('.extension-detail')).focus({ preventScroll: true }); }
  // roving tabindex（E-14）：清单里只有当前行是 Tab 停靠点（当前行 = 已选中行，否则最近聚焦行，否则第一行）；其余行及其开关 tabindex=-1，仍可被脚本聚焦、被鼠标点。
  function applyRoving() {
    const opens = [...$('.extension-list').querySelectorAll('.extension-row-open')]; if (!opens.length) return;
    const current = opens.find(button => button.dataset.extensionId === route.id) || opens.find(button => button.dataset.extensionId === rovingId) || opens[0];
    rovingId = current.dataset.extensionId;
    for (const button of opens) {
      // 只在值真的变了才写：对同一个值赋 tabIndex 也会产生 attributes 变动记录，重新扫描时清单会被视为“动过”（E-19）。
      const want = button === current ? 0 : -1, set = el => { if (el.tabIndex !== want) el.tabIndex = want; };
      set(button);
      for (const control of button.closest('.extension-row').querySelectorAll('input, button:not(.extension-row-open), a[href]')) set(control);
    }
  }
  function renderTabs() {
    const restoreFocus=$('#extensions-tabs')?.contains(document.activeElement); tabsDispose?.(); $('.extension-tabs').innerHTML = segmentedControl({ id: 'extensions-tabs', label: '扩展分类', value: route.tab, options: categories, mode: 'tabs' });
    tabsDispose = mountSegmentedControl($('#extensions-tabs'), { onChange: tab => changeRoute({ tab, id: null, operation: null, file: null }) });
    if(restoreFocus)$('#extensions-tabs [aria-selected="true"]').focus({preventScroll:true});
    renderCreateSlot();
    $('#extensions-client-filter').value = route.client || ''; $('[data-problems]').checked = !!route.problems; $('.extension-search input').value = route.query || ''; searchControl?.sync();
  }
  function renderClientFilter() {
    if (!state) return;
    const options = [{ value: '', label: '全部软件' }, ...state.clients.filter(client => route.tab === 'clients' || client.selected).map(client => ({ value: client.id, label: client.name }))];
    if (route.client && !options.some(option => option.value === route.client)) { route.client = null; history.replaceState(null, '', '/' + extensionsRoute(route)); }
    updateSelectField($('.extension-software-filter'), { id: 'extensions-client-filter', name: 'client', label: '按软件筛选', compact: true, hideLabel: true, value: route.client || '', options });
  }
  // 配置文件损坏横幅（E-08）：只描述当前分类自己的主配置，不覆盖原文件；新建在修复前暂停。
  function configBanner() {
    if (!state) return null;
    if (route.tab === 'mcp' && state.mcpValid === false) { const found = corruptMcpConfig(state); return { code: 'MCP_FORMAT', title: 'MCP 主配置无法读取', blocksCreate: true, ...found }; }
    if (route.tab === 'clients' && state.clientsValid === false) { const problem = state.diagnostics.find(item => item.code === 'CLIENTS_FORMAT') || {}; return { code: 'CLIENTS_FORMAT', title: '软件登记文件无法读取', blocksCreate: true, problem, where: problem.path || '', reason: problem.message || '' }; }
    if (route.tab === 'skills' && state.bindingsValid === false) { const problem = state.diagnostics.find(item => item.code === 'BINDINGS_FORMAT') || {}; return { code: 'BINDINGS_FORMAT', title: '接入记录无法读取', blocksCreate: false, problem, where: problem.path || '', reason: problem.message || '' }; }
    return null;
  }
  // 「在访达中显示」「从备份恢复…」要后端能力（§H，后端 #36）：读 /state、/refresh 里 capabilities 镜像的 extensions.reveal / extensions.restoreBackup，
  // 明确为 true 才显示（只认嵌套的 extensions.*，没有扁平键兜底，读法见 capabilities.js）；没有时用「复制路径」代替（路径来自 state 已有字段），不显示会失败的按钮。revealKind 只有 MCP 主配置在契约里。
  const capability = name => extensionCapability(state?.capabilities, name);
  const bannerActions = banner => [
    { label: '重新扫描', attrs: { 'data-extension-refresh': true } },
    ...(capability('reveal') && banner.code === 'MCP_FORMAT' ? [{ label: '在访达中显示', attrs: { 'data-extension-reveal': 'mcpConfig' } }] : banner.problem?.path ? [{ label: '复制路径', attrs: { 'data-copy-path': true } }] : []),
    ...(capability('restoreBackup') && banner.code === 'MCP_FORMAT' ? [{ label: '从备份恢复…', attrs: { 'data-extension-restore-backup': true } }] : []),
  ];
  // 检查器里的「在访达中显示」：只在 capabilities.extensions.reveal === true 时出现；请求体只有 kind + id / clientId（不带路径）。
  const revealButton = (kind, item) => capability('reveal') && revealBody(kind, kind === 'client' ? { clientId: item.id } : { id: item.id }) ? `<button type="button" class="secondary" data-extension-reveal="${kind}" data-reveal-id="${esc(item.id)}">在访达中显示</button>` : '';
  const bannerMarkupFor = banner => bannerMarkup({ tone: 'error', title: banner.title, attrs: { 'data-config-banner': banner.code }, actions: bannerActions(banner), messageHtml: `<p>${banner.where ? `位置：${banner.problem?.path ? `<code data-config-path>${esc(banner.problem.path)}</code>${esc(banner.where.slice(banner.problem.path.length))}` : esc(banner.where)}${banner.reason ? ' · ' + esc(banner.reason) : ''}。` : esc(banner.reason || '')}${banner.where || banner.reason ? '' : '请检查配置文件。'}</p><p>Daylight 不会覆盖或改写这个文件。${banner.blocksCreate ? '修复之前“' + category().action + '”已暂停。' : '修复之前接入写入已暂停。'}修好后重新扫描，提示会自动消失。</p>` });
  // 工具栏右侧的入口：Skills / MCP 是「添加 ▾」菜单（新建 + 导入），接入软件只有一个「添加 CLI」按钮。菜单打开时不重绘，只改禁用状态。
  const createBlockedReason = '配置文件无法读取，修复并重新扫描后才能新建或导入。';
  let createBlocked = false;
  function renderCreateSlot() {
    const slot = $('[data-create-slot]'); if (!slot) return;
    addMenu?.close();
    slot.innerHTML = addMenuItems(route.tab) ? addMenuMarkup(route.tab, { disabled: createBlocked, reason: createBlockedReason }) : `<button class="secondary" type="button" data-create ${createBlocked ? `disabled title="${esc(createBlockedReason)}"` : ''}>${esc(category().action)}</button>`;
  }
  function updateCreateAvailability(banner) {
    createBlocked = !!banner?.blocksCreate;
    const button = $('[data-create-slot] [data-add-menu-button]') || $('[data-create-slot] [data-create]'); if (!button) return;
    if (createBlocked) addMenu?.close();
    button.disabled = createBlocked; button.title = createBlocked ? createBlockedReason : '';
  }
  function visibleItems() {
    const needle = (route.query || '').toLowerCase();
    return state[category().collection].filter(item => {
      const matchesText = !needle || [item.name, item.description, item.relativePath, item.command, item.url, item.note].filter(Boolean).join(' ').toLowerCase().includes(needle);
      const matchesSoftware = !route.client || (route.tab === 'skills'
        ? item.bindings.some(binding => binding.clientId === route.client && binding.state !== 'not_connected')
        : route.tab === 'clients' ? item.id === route.client : item.clientId === route.client);
      const matchesProblems = !route.problems || item.valid === false || route.tab === 'clients' && item.selected && !item.installed || item.bindings?.some(isOpenConflict) || state.diagnostics.some(problem => problem.id === item.id);
      return matchesText && matchesSoftware && matchesProblems;
    });
  }
  let loadingSince = 0, loadingTimers = [], listStatus = '';
  const nothingFiltered = () => !route.query && !route.client && !route.problems;
  // 共享来源是默认情况，行里不再重复（详情里有完整路径）；只有软件本地配置才在行里标出来。
  const sourceOf = item => item.scope === 'client' ? (state.clients.find(client => client.id === item.clientId)?.name || '') + ' · 本地配置' : '';
  function mcpStatus(item) {
    const probe = probeOf(item), health = mcpHealth(item, probe), time = health.key === 'disabled' ? '' : probeTime(probe), badge = shared(item) ? refBadge(item) : null;
    const note = [toolCountLabel(probe), time ? '检测于 ' + time : ''].filter(Boolean).join(' · ');
    return `<span class="extension-status-stack" data-mcp-health="${esc(health.key)}">${chip({ label: health.label, tone: health.tone, dot: health.dot })}${note ? `<small>${esc(note)}</small>` : ''}${badge ? chip({ label: badge.label, tone: badge.tone, className: 'extension-ref-badge' }) : ''}</span>`;
  }
  const shared = server => server.scope !== 'client';
  // 共享 MCP 的启用开关（行里和检查器里是同一个控件）：和 Skill 一样先暂存，应用时才 mcp.toggle。
  function mcpSwitch(server, compact = true) {
    const live = liveServer(server);
    if (!hasMcpSwitch(live)) return compact ? '<span class="extension-master-none"><span aria-hidden="true">—</span><span class="extension-visually-hidden">本地配置的服务在详情里启停</span></span>' : '';
    const change = { kind: 'mcp', id: live.id }, pending = staged.has(stageKey(change)), checked = stagedValue(staged, change, live.enabled);
    return switchControl({ label: live.name + ' · 启用', text: checked ? '已启用' : '已停用', checked, pending, busy: batchBusy && pending, disabled: batchBusy, title: '只改配置，不会启动或停止服务；应用前先预览', className: 'extension-binding-control extension-master-control', inputAttrs: { 'data-mcp-switch': true, 'data-mcp': live.id } });
  }
  // 检测结果卡片：状态、后端给出的固定文案、工具数、前 8 个工具名（折叠）、可操作的建议。不显示任何环境变量的值。
  function probeCardMarkup(server) {
    const card = probeCard(probeOf(server), liveServer(server)); if (!card) return '';
    const meta = [card.version && '服务版本 ' + card.version, card.protocol && '协议 ' + card.protocol].filter(Boolean).join(' · ');
    const names = card.tools.length ? `<details class="extension-probe-tools"><summary>工具清单（${card.toolCount ?? card.tools.length}）</summary><ul>${card.tools.map(name => `<li><code>${esc(name)}</code></li>`).join('')}${card.moreTools ? `<li>另有 ${card.moreTools} 个</li>` : ''}</ul></details>` : '';
    return `<section class="extension-probe-card" data-probe-card data-probe-status="${esc(card.status)}"><div class="extension-probe-card-head">${chip({ label: card.label, tone: card.tone, dot: true })}${probeTime(probeOf(server)) ? `<small>检测于 ${esc(probeTime(probeOf(server)))}</small>` : ''}</div>`
      + `${card.stale ? '<p class="extension-warning" data-probe-stale>配置已变化，以下为上次配置的检测结果；请重新检测。</p>' : ''}`
      + `${card.message ? `<p data-probe-message>${esc(card.message)}${card.status === 'succeeded' && card.toolCount !== null ? ` 工具数：${card.toolCount}` : ''}</p>` : ''}${meta ? `<p><small>${esc(meta)}</small></p>` : ''}`
      + `${card.advice ? `<p class="extension-probe-advice" data-probe-advice><strong>建议 · </strong>${esc(card.advice)}</p>` : ''}${names}`
      + `${card.cancellable ? `<button type="button" class="text-button" data-cancel-probe data-probe-id="${esc(probeOf(server).id)}">取消检测</button>` : ''}</section>`;
  }
  // 环境变量 / 请求头引用表（E-23）：只有「是否存在」，没有值。
  function refTableMarkup(server) {
    const rows = refRows(server); if (!rows?.length) return '';
    return `<section class="extension-refs" data-ref-table aria-labelledby="extension-refs-title"><h3 id="extension-refs-title">环境变量与请求头引用</h3><table class="extension-ref-table"><thead><tr><th scope="col">引用名</th><th scope="col">用途</th><th scope="col">状态</th></tr></thead><tbody>`
      + rows.map(row => `<tr data-ref-row data-ref-status="${esc(row.status)}"><td><code>${esc(row.ref)}</code></td><td>${esc(row.purpose)}</td><td>${chip({ label: refStatusLabels[row.status], tone: row.status === 'set' ? 'success' : row.status === 'unknown' ? 'neutral' : 'warning', dot: row.status !== 'unknown' })}${refHints[row.status] ? `<small>${esc(refHints[row.status])}</small>` : ''}</td></tr>`).join('')
      + `</tbody></table><p class="extension-ref-note"><small>${esc(refNote)}</small></p></section>`;
  }
  // 「测试连接」按钮不可用时要说明原因（不能只是灰的）。
  function probeAvailability(server) {
    const live = liveServer(server);
    if (!shared(live)) return { ok: false, hint: '本地配置的服务由对应软件启动，这里不检测。' };
    if (activeProbe(probeOf(live))) return { ok: false, hint: '正在检测；可以在下面取消。' };
    const hint = disabledProbeHint(live.enabled, staged.get(stageKey({ kind: 'mcp', id: live.id }))?.want === true);
    return { ok: !hint, hint };
  }
  function rowFor(item) {
    const active = item.id === route.id, query = route.query || '';
    const summary = route.tab === 'skills' ? (item.valid ? item.description : item.problem) : route.tab === 'mcp' ? commandLine(item) : item.note;
    const statusCells = route.tab === 'skills' ? [masterControl(item), item.bindings.length ? `<span class="extension-binding-group">${item.bindings.map(binding => bindingControl(item, binding, true)).join('')}</span>` : '<small>未选择软件</small>']
      : route.tab === 'mcp' ? [chip({ label: item.transport, tone: 'neutral' }), mcpSwitch(item), mcpStatus(item)]
      : [switchControl({ label: item.name + ' · 接入扩展管理', text: item.selected ? '已接入' : '选择接入', hint: item.installed ? '已发现命令' : '未找到命令', checked: !!item.selected, disabled: selectionPreviewing, className: 'extension-binding-control', inputAttrs: { 'data-cli-selection': true, 'data-client': item.id } })];
    return rowMarkup({ tab: route.tab, item, active, query, summary, summaryClass: route.tab === 'mcp' ? 'extension-row-command' : '', sourceText: sourceOf(item), statusCells });
  }
  function renderList() {
    clearTimeout(loadingTimers.pop()); loadingTimers.length = 0;
    if (!state) {
      listMarkup = undefined; updateCreateAvailability(null);
      if (readFailure) { loadingSince = 0; $('.extension-list').innerHTML = failureState({ reason: readFailure.message }); return; }
      if (loadView.cancelled) { loadingSince = 0; $('.extension-list').innerHTML = ''; return; }   // 取消后没有数据可显示：上方「已取消」横幅带重试
      loadingSince ||= Date.now();
      const elapsed = Date.now() - loadingSince;
      $('.extension-list').innerHTML = loadingState({ elapsed, cancellable: !!loadView.cancellable });
      if (elapsed < 1000) loadingTimers.push(setTimeout(() => { if (!state && visible) renderList(); }, elapsed < 300 ? 300 - elapsed : 1000 - elapsed));
      return;
    }
    loadingSince = 0;
    const focus = $('.extension-list').contains(document.activeElement) ? document.activeElement?.dataset : null;
    const all = state[category().collection], filtered = visibleItems();
    const banner = configBanner(), tabProblems = diagnosticsForTab(state.diagnostics, route.tab).filter(problem => !(banner && problem.code === banner.code));
    updateCreateAvailability(banner);
    // 配置文件读不出来时列表为空只是表象，横幅已说明原因，不再叠一个“还没有 MCP 服务”。
    const empty = !filtered.length ? (!all.length && nothingFiltered() ? (banner?.blocksCreate ? '' : emptyState(route.tab)) : noMatchState()) : '';
    const markup = `${banner ? bannerMarkupFor(banner) : ''}<div class="extension-list-heading"><h2 tabindex="-1">${category().title}</h2><span data-list-count>${countLabel(filtered.length, all.length)}</span>${route.tab === 'mcp' && all.length ? probeAllMarkup(filtered) : ''}</div>${filtered.length ? `<div class="extension-table" role="table" aria-label="${esc(category().title)}" data-tab="${route.tab}">${tableHeader(route.tab)}${filtered.map(rowFor).join('')}</div>` : ''}${empty}${tabProblems.length ? `<details class="extension-static-diagnostics" ${tabProblems.length <= 3 ? 'open' : ''}><summary>${category().label} 静态问题 ${tabProblems.length} 项</summary>${tabProblems.map(problem => `<p>${esc(problem.message)}${problem.path ? ' · ' + esc(problem.path) : ''}${problem.skippedBranches > 1 ? ' · 共 ' + problem.skippedBranches + ' 处分支' : ''}</p>`).join('')}</details>` : ''}`;
    const status = `${category().label}：${countLabel(filtered.length, all.length)}`;
    if (status !== listStatus) { listStatus = status; const live = $('[data-list-status]'); if (live) live.textContent = status; }
    if (markup === listMarkup) { applyRoving(); return; }
    const disclosures = [...$('.extension-list').querySelectorAll('details')].map(details=>details.open);
    $('.extension-list').innerHTML = markup; listMarkup = markup;
    [...$('.extension-list').querySelectorAll('details')].forEach((details,index)=>{if(disclosures[index]!==undefined)details.open=disclosures[index];});
    if (focus?.bindingToggle !== undefined || focus?.masterToggle !== undefined || focus?.mcpSwitch !== undefined) findToggle(focus, 'list')?.focus({preventScroll:true});
    else if (focus?.cancelAllProbes !== undefined) $('[data-cancel-all-probes]')?.focus({ preventScroll: true });
    else if (focus?.probeAll !== undefined) $('[data-probe-all]')?.focus({ preventScroll: true });
    else if (focus?.extensionId) [...element.querySelectorAll('[data-extension-id]')].find(item => item.dataset.extensionId === focus.extensionId)?.focus({preventScroll:true});
    applyRoving();
  }
  // 检查器顶部的「‹ 返回清单」（design-spec §3：≤999 覆盖层必须有；宽屏下同一个按钮收起检查器）。‹ 对读屏隐藏，可访问名称仍是「返回清单」。
  const backBar = () => '<div class="extension-inspector-top"><button type="button" class="text-button extension-back" data-close-detail><span aria-hidden="true">‹</span>返回清单</button></div>';
  async function loadDetail() {
    const id = route.operation || route.id;
    if (!id) { detailTicket++; focusDetailOnRender = false; selected = null; $('.extension-detail').hidden = true; detailKey = ''; return; }
    const key = [route.tab, id, state?.version, route.file].join(':'); if (key === detailKey) return;
    const ticket = ++detailTicket; $('.extension-detail').hidden = false; $('.extension-detail').innerHTML = backBar() + '<p role="status">正在读取详情…</p>';
    try {
      const value = route.operation ? await client.operation(id) : await client.detail(id, route.file, tabKinds[route.tab]);
      if (ticket !== detailTicket || !visible) return; selected = value; detailKey = key; renderDetail();
    } catch (error) { if (ticket !== detailTicket) return; focusDetailOnRender = false; $('.extension-detail').innerHTML = `<div class="extension-detail-error" role="alert"><h3>无法打开${route.operation ? '操作回执' : '详情'}</h3><p>${esc(detailErrorMessage(error, { tab: route.tab, operation: !!route.operation, mcpValid: state?.mcpValid }))}</p><div class="extension-actions"><button type="button" class="secondary" data-close-detail>返回清单</button><button type="button" class="text-button" data-extension-refresh>重新扫描</button></div></div>`; }
  }
  // 危险操作单独成组（design-spec：破坏性动作不与普通操作并排）；按钮仍是 [data-archive]，点开后是带影响说明的确认。
  const dangerZone = (label, hint) => `<section class="extension-danger-zone" aria-labelledby="extension-danger-title"><h3 id="extension-danger-title">危险操作</h3><p>${esc(hint)}</p><button type="button" class="ui-button-destructive" data-archive>${esc(label)}</button></section>`;
  function renderDetail({ keepFocus = false } = {}) {
    const item = selected; if (!item) return;
    const heading = backBar() + sectionHeading({ title: item.name || '操作回执' });
    let content;
    if (route.operation) content = `<p>状态：${esc(item.status)}</p><p>${esc(item.error || '')}</p><code>${esc(item.requestId)}</code><div class="extension-actions"><button type="button" class="secondary" data-restore-operation="${esc(item.requestId)}" ${item.status === 'applied' && item.steps.length ? '' : 'disabled'}>预览恢复修改前内容</button></div><details><summary>操作与步骤</summary><pre>${esc(JSON.stringify(item, null, 2))}</pre></details>`;
    else if (item.kind === 'skill') content = `<p>${esc(item.description || item.problem)}</p><p class="extension-source">${item.scope === 'client' ? '软件本地来源' : '共享来源'}：${esc(item.sourcePath)}</p><div class="extension-actions"><button type="button" class="secondary" data-edit ${item.readOnly ? "disabled" : ""}>编辑文件</button>${revealButton('skill', item)}<button type="button" class="text-button" data-discuss>让 AI 解释或修改</button></div><section><h3>软件接入</h3>${item.bindings.map(binding => bindingRow(item, binding) + conflictBlockFor(item, binding)).join('') || chooseClientsPrompt}</section><p>MCP 依赖：${item.dependencies === null ? '未声明' : item.dependencies.length ? item.dependencies.map(id => esc(state.servers.find(server => server.id === id)?.name || id + '（不存在）')).join('、') : '明确声明为空'}</p>${!item.readOnly ? selectField({ id: 'extension-file-select', name: 'file', label: '查看 Skill 文件', value: item.file, compact: true, options: item.files.filter(file => !file.linked).map(file => ({ value: file.path, label: file.path })) }) : ''}<pre class="extension-source-content">${esc(item.content || '（空文件）')}</pre>${dangerZone(item.linked ? '移除软件链接，保留源文件' : item.scope === 'client' ? '归档本地 Skill' : '归档主 Skill，影响使用它的软件', item.linked ? '只移除软件里的链接，源文件保留。' : '归档后，使用它的软件会失去这个 Skill。')}`;
    else if (item.kind === 'mcp') content = `<p>${item.transport === 'stdio' ? '本地命令（stdio）' : 'HTTP 服务'} · ${liveServer(item).enabled ? '配置启用' : '配置禁用'} · ${esc(item.scope === 'client' ? state.clients.find(client => client.id === item.clientId)?.name + ' 用户级' : '共享来源')}</p>${shared(item) ? `<div class="extension-mcp-switch">${mcpSwitch(item, false)}</div>` : ''}${(w => w ? `<p class="extension-warning" data-insecure-http><strong>警告 · </strong>${esc(w)}</p>` : '')(insecureHttpWarning(item.url, { hasHeaders: !!Object.keys(item.headerRefs || {}).length }))}<p>保存配置不会启动服务。${item.scope === 'client' ? '在对应 CLI 中刷新并核对实际发现结果。' : '共享来源可接入支持的软件。'}</p>${item.secretKeys?.length ? '<p>已有环境变量或请求头值已隐藏，编辑时会保留。</p>' : ''}<div class="extension-actions"><button type="button" class="secondary" data-edit ${item.editable === false ? "disabled" : ""}>编辑配置</button><button type="button" class="secondary" data-probe ${(a => a.ok ? '' : 'disabled aria-describedby="extension-probe-hint"')(probeAvailability(item))}>测试连接</button><button type="button" class="text-button" data-discuss>让 AI 诊断或修改</button></div>${(a => a.ok ? '' : `<p class="extension-probe-hint" id="extension-probe-hint" data-probe-hint><small>${esc(a.hint)}</small></p>`)(probeAvailability(item))}<div data-probe-result role="status">${probeCardMarkup(item)}</div><dl>${Object.entries(item).filter(([key]) => ['id', 'command', 'args', 'cwd', 'url', ...(refRows(item) ? [] : ['envRefs', 'headerRefs'])].includes(key)).map(([key, value]) => `<dt>${esc(({ envRefs: '环境变量引用', headerRefs: '请求头引用', command: '命令', args: '参数', cwd: '工作目录', url: '端点', id: 'ID' })[key])}</dt><dd>${esc(typeof value === 'object' ? JSON.stringify(key === 'args' ? redactArgs(value) : value, null, 2) : value)}</dd>`).join('')}</dl>${refTableMarkup(item)}<p>声明依赖的 Skills：${item.dependencies.length ? item.dependencies.map(skill => esc(skill.name)).join('、') : '未发现明确声明；其他依赖未知'}</p>${item.scope === 'client' ? (item.toggleSupported ? `<button type="button" class="secondary" data-mcp-toggle>${item.enabled ? '禁用' : '启用'}此服务</button>` : '<p>该 CLI 的用户配置未提供已接入的启停方式，可编辑或移除服务。</p>') : `<h3>接入软件</h3>${state.clients.filter(client => client.selected && client.mcpMode === 'native').map(client => `<button type="button" class="secondary" data-install-mcp="${esc(client.id)}">接入 ${esc(client.name)}</button>`).join(' ') || chooseClientsPrompt}`}${dangerZone(item.scope === 'client' ? '移除软件 MCP 配置' : '归档 MCP 主配置', '归档后，使用它的软件会失去这个 MCP 服务。')}`;
    else content = `<p>${esc(item.note)}</p><dl><dt>软件主目录</dt><dd>${esc(item.root)}</dd><dt>软件 Skills 目录</dt><dd>${esc(item.skillsRoot)}</dd><dt>Daylight 管理的共享来源</dt><dd>${esc(state.root)}/skills</dd><dt>CLI 命令</dt><dd>${esc(item.command)}</dd></dl><p>${esc(item.refresh)}</p><p>${item.installed ? '可执行文件：' + esc(item.executable) : '未找到命令，可填写可执行文件的绝对路径。'}</p><div class="extension-actions"><button type="button" class="secondary" data-cli-selection data-client="${esc(item.id)}" ${selectionPreviewing ? 'disabled' : ''}>${item.selected ? '取消接入' : '选择接入'}</button>${item.registrationId ? '<button type="button" class="secondary" data-remove-client>删除旧登记，使用自动识别</button>' : ''}${item.custom ? '<button type="button" class="secondary" data-edit>编辑 CLI</button><button type="button" class="ui-button-destructive" data-remove-client>移除登记</button>' : ''}${item.selected && item.mcpMode !== 'unsupported' ? `<button type="button" class="secondary" data-generate>预览生成 MCP 配置</button>` : ''}${item.selected ? revealButton('client', item) : ''}<button type="button" class="text-button" data-discuss>让 AI 解释接入情况</button>${item.id === 'pi' ? '<a class="text-button" href="#cli">Pi 模型配置</a>' : ''}</div><p>${item.discovered ? '自动识别' : item.custom ? '手动登记' : '内置适配器'} · MCP ${item.mcpMode === 'native' ? '直接管理' : item.mcpMode === 'manual' ? '仅生成片段' : '未接入'}</p>${item.mcpPath ? `<p>用户级 MCP 文件：<code>${esc(item.mcpPath)}</code></p>` : ''}${item.selected ? `<h3>Skills</h3>${item.skills.map(skill => bindingRow(skill, skill.binding, true)).join('') || '<p>主目录暂无 Skill。</p>'}<h3>用户级 MCP</h3>${item.servers?.map(server => `<p><a href="${extensionsRoute({ tab: 'mcp', id: server.id })}">${esc(server.name)}</a> · ${server.enabled ? '启用' : '禁用'}</p>`).join('') || `<p>${item.mcpValid === false ? '配置读取失败，请修复后重新扫描。' : item.mcpMode === 'native' ? '暂无用户级 MCP。可在 MCP 分类新增，选择此软件。' : '尚无已核实的原生 MCP 适配器。'}</p>`}${item.generated ? `<h3>MCP 导出片段</h3><p>${item.generated.current ? '与主配置一致' : '主配置已变化或格式不能生成，请重新核对'}</p><code>${esc(item.generated.path)}</code><p>${esc(item.integration)}</p><pre>${esc(item.generated.content)}</pre>` : `<p>${item.mcpMode === 'unsupported' ? '该软件暂未设置支持的 MCP 配置格式。' : '尚未生成 MCP 适配文件；生成后仍需在客户端接入。'}</p>`}` : '<p>尚未选择接入。选择后才读取和管理此软件的 Skills、MCP；取消接入会保留原有文件和链接。</p>'}`;
    $('.extension-detail').innerHTML = heading + content;
    if (focusDetailOnRender) { focusDetailOnRender = false; focusDetail(); }
    if (item.kind === 'mcp' && activeProbe(probeOf(item)) && probeWatching !== probeOf(item).id) watchProbe(probeOf(item).id);
  }
  // 复制路径：navigator.clipboard；失败时选中横幅里的路径文字让用户按 ⌘C，两种结果都用 toast（role=status）播报。
  async function copyBannerPath(button) {
    const target = button.closest('[data-config-banner]')?.querySelector('[data-config-path]'), text = target?.textContent || '';
    if (!text) return;
    const result = await copyText(text, { selectTarget: target });
    if (result.copied) showToast({ message: '已复制路径' });
    else showToast({ message: result.selected ? '无法写入剪贴板，路径已选中，请按 ⌘C 复制' : '无法复制路径，请手动选择上方的文字', tone: 'warning', duration: 8000 });
  }
  // 在访达中显示：skill / client 按 id 请求，mcpConfig 无参数。失败不抛到页面错误区（那是读取失败的位置），用 toast 说明原因；已知路径时给「复制路径」。
  async function revealInFinder(button) {
    const kind = button.dataset.extensionReveal, body = revealBody(kind, { id: button.dataset.revealId, clientId: button.dataset.revealId });
    if (!body) return;
    try { await client.reveal(body); showToast({ message: '已在访达中显示' }); }
    catch (error) {
      const problemPath = $('[data-config-path]')?.textContent || '', path = revealFallbackPath(kind, { item: selected, problemPath });
      showToast({ message: revealErrorMessage(error, { canCopy: !!path }), tone: 'warning', duration: 8000, ...(path ? { actionLabel: '复制路径', onAction: async () => { const result = await copyText(path); showToast({ message: result.copied ? '已复制路径' : '无法写入剪贴板，请在详情里手动选择路径', tone: result.copied ? 'success' : 'warning' }); } } : {}) });
    }
  }
  // 从备份恢复：恢复点列表来自 GET /api/extensions/backups?kind=mcpConfig（后端 #36：只返回元数据，不含配置内容或凭据）；选定后走同一套「预览 → 确认」，动作 mcp.restoreBackup。
  async function chooseBackup() {
    const list = backupList(await client.backups('mcpConfig'));
    if (!list.length) { showToast({ message: '没有可用的恢复点', tone: 'warning' }); return; }
    const sheet = openShell('从备份恢复', `<fieldset class="ui-sheet-list" role="radiogroup" aria-label="恢复点">${list.map((backup, index) => `<label><input type="radio" name="backup" value="${esc(backup.operationId)}" ${index === 0 ? 'checked' : ''}><span>${esc(backup.summary || '一次 MCP 配置修改')}<small>${esc(backupMeta(backup))}</small></span></label>`).join('')}</fieldset>${sheetFooter({ confirmLabel: '预览恢复' })}`);
    sheet.element.querySelector('[data-sheet-cancel]').onclick = () => sheet.close();
    sheet.element.querySelector('[data-sheet-confirm]').onclick = async () => {
      const operationId = sheet.element.querySelector('input[name=backup]:checked')?.value; if (!operationId) return;
      try { sheet.close(); await preview({ type: 'mcp.restoreBackup', operationId }, { title: '预览从备份恢复' }); } catch (error) { setError(error); }
    };
  }
  function openShell(title, content, onClose = () => {}) {
    shell?.dispose(); shell = createSheet({ title, size: 'form', onClose }); shell.element.classList.add('extension-dialog'); shell.setContent(content); shell.open(); return shell;
  }
  // 归档 / 移除登记成功后，被删行会消失；焦点要落到相邻行（先下一行，再上一行），都没有就落到清单标题（E-27）。
  const removalTarget = action => ['skill.archive', 'mcp.archive'].includes(action.type) ? action.id : action.type === 'client.remove' ? selected?.id : null;
  function focusAfterRemoval({ id, order }) {
    if (!visible) return;
    const at = order.indexOf(id), rows = new Map([...$('.extension-list').querySelectorAll('[data-extension-id]')].map(button => [button.dataset.extensionId, button]));
    const target = [id, ...order.slice(at + 1), ...order.slice(0, Math.max(at, 0)).reverse()].map(candidate => rows.get(candidate)).find(Boolean);
    (target || $('.extension-list-heading h2') || $('.extension-search input'))?.focus();
  }
  const nameFor = action => (state?.skills.find(item => item.id === action.id) || state?.servers.find(item => item.id === action.id) || state?.clients.find(item => item.id === (action.clientId || action.id)))?.name || '';
  // 成功回执：toast 说明结果；能撤销的（不是检测、不是撤销本身）带「撤销」按钮，走同一套预览确认（operation.restore）。
  function receipt(done) {
    const ok = done.filter(item => item.result); if (!ok.length) return;
    const message = ok.length === 1 ? appliedMessage(ok[0].action, ok[0].name) : `已应用 ${ok.length} 项变更`;
    const undo = ok.every(item => undoable(item.action, item.result)) ? ok.map(item => ({ operationId: item.result.operationId, label: item.label || appliedMessage(item.action, item.name) })) : [];
    // 从备份恢复：toast 只有 4 秒，撤销入口改成列表上方常驻的提示条（任何后续回执 / 撤销完成都会收起它）；其他变更仍是 toast 上的「撤销」。
    const restored = undo.length && ok.length === 1 && ok[0].action?.type === 'mcp.restoreBackup';
    restoreNotice = restored ? undo : null; renderRestoreNotice();
    showToast({ message, tone: 'success', ...(undo.length && !restored ? { actionLabel: '撤销', onAction: () => void undoOperations(undo).catch(setError) } : {}) });
    controller.clearSubmission();
  }
  function renderRestoreNotice() {
    const slot = $('[data-restore-slot]'); if (!slot) return;
    const markup = restoreNotice ? bannerMarkup({ tone: 'info', title: '已从备份恢复', message: restoreNoticeText, attrs: { 'data-restore-banner': true }, actions: [{ label: '撤销', attrs: { 'data-restore-undo': true } }, { label: '知道了', attrs: { 'data-restore-dismiss': true } }] }) : '';
    if (slot.innerHTML !== markup) slot.innerHTML = markup;
  }
  async function undoOperations(items) {
    const actions = undoActions(items.map(item => item.operationId));
    await openBatch({ title: items.length > 1 ? `撤销 ${items.length} 项变更` : '撤销上一步变更', confirmLabel: '撤销变更', chained: true, entries: actions.map((action, index) => ({ action, tag: '撤销', label: items[items.length - 1 - index]?.label || '恢复到变更前', name: '' })) });
  }
  // 批量预览/应用：每一项各自 /prepare（只读），应用时逐项重新 /prepare 再 /actions（后端没有批量接口，也不是原子的）；中途失败时停下，如实显示已应用 / 失败 / 未执行。
  async function openBatch({ title, entries, confirmLabel = '应用变更', destructive = false, intro = '', chained = false, onSettled }) {
    setError(null);
    let plans;
    try { plans = await Promise.all((chained ? entries.slice(0, 1) : entries).map(entry => client.prepare(entry.action))); }   // chained：后一项依赖前一项的结果（撤销多步），只能预览第一项；其余在应用时逐项重新预览
    catch (error) { const mcp = entries.some(entry => entry.action?.type?.startsWith('mcp.')); setError(mcp ? new Error(mcpErrorMessage(error, entries.length === 1 ? entries[0].name || entries[0].label : '')) : error); if (mcp && shouldRefresh(error)) void controller.refresh(true); return; }
    if (!visible) return;
    const root = state?.root || '', tilde = plan => ({ ...plan, impact: (plan.impact || []).map(text => tildeText(text, root)), conflicts: (plan.conflicts || []).map(text => tildeText(text, root)), files: (plan.files || []).map(file => ({ ...file, path: tildePath(file.path, root), ...(file.linkTarget ? { linkTarget: tildePath(file.linkTarget, root) } : {}) })) });
    const conflicts = plans.flatMap((plan, index) => (plan.conflicts || []).map(text => `${entries[index].label}：${tildeText(text, root)}`));
    const rows = entries.map((entry, index) => `<li data-batch-item="${index}" data-status="pending"><span class="extension-batch-tag">${esc(entry.tag)}</span><span class="extension-batch-label">${esc(entry.label)}</span><small data-batch-result></small></li>`).join('');
    const details = plans.map((plan, index) => `<details class="extension-batch-detail"><summary>${esc(entries[index].tag + ' · ' + entries[index].label)}</summary>${extensionPlanContent(tilde(plan))}</details>`).join('');
    const dialog = openShell(title, `${intro}<ul class="extension-batch-list" data-batch-list>${rows}</ul>${chained && entries.length > 1 ? '<p class="extension-batch-note" data-batch-chained>这几步按顺序进行：后面的步骤会在前一步完成后再检查，不满足条件会停下。</p>' : ''}${conflicts.length ? `<div class="extension-batch-conflicts" role="alert" data-batch-conflicts><strong>有冲突，不能应用</strong>${conflicts.map(text => `<p>${esc(text)}</p>`).join('')}</div>` : ''}<details class="extension-batch-detail-group"><summary>查看每一项的详细改动</summary>${details}</details><p class="extension-batch-summary" role="status" data-batch-summary></p>${sheetFooter({ confirmLabel, destructive, confirmAttrs: 'data-batch-apply', cancelAttrs: 'data-batch-cancel' })}`, () => { batchBusy = false; renderStaged(); });
    const confirm = dialog.element.querySelector('[data-batch-apply]'), cancel = dialog.element.querySelector('[data-batch-cancel]'), summary = dialog.element.querySelector('[data-batch-summary]');
    const mark = (index, status, text = '') => { const row = dialog.element.querySelector(`[data-batch-item="${index}"]`); row.dataset.status = status; row.querySelector('[data-batch-result]').textContent = text; };
    if (conflicts.length) confirm.disabled = true;
    cancel.onclick = () => dialog.close();
    confirm.onclick = async () => {
      batchBusy = true; confirm.disabled = true; dialog.setBusy(true); dialog.setError(''); renderStaged();
      const done = []; let failed = null;
      for (const [index, entry] of entries.entries()) {
        mark(index, 'working', '应用中…');
        try {
          const plan = await client.prepare(entry.action);
          if ((plan.conflicts || []).length) throw new Error(plan.conflicts.map(text => tildeText(text, root)).join('；'));
          if (plans[index] && JSON.stringify(plan.normalizedAction) !== JSON.stringify(plans[index].normalizedAction)) throw new Error('这一项在预览之后发生了变化，请重新预览');
          const result = await controller.submit(plan);
          done.push({ ...entry, action: plan.normalizedAction, result }); mark(index, 'done', '已应用');
        } catch (error) { const text = entry.action?.type?.startsWith('mcp.') ? mcpErrorMessage(error, entry.name || entry.label) : error.message; failed = { index, error: Object.assign(new Error(text), { status: error.status, code: error.code }) }; mark(index, 'failed', text); if (entry.action?.type?.startsWith('mcp.') && shouldRefresh(error)) void controller.refresh(true); break; }
      }
      for (const item of done) if (item.change) staged.delete(stageKey(item.change));
      batchBusy = false;
      if (failed) for (let index = failed.index + 1; index < entries.length; index++) mark(index, 'skipped', '未执行');
      summary.textContent = failed ? partialSummary({ done: done.length, failed: 1, skipped: entries.length - done.length - 1 }) : '';
      onSettled?.(done, failed);
      if (!failed) { dialog.setBusy(false); dialog.close(); receipt(done); return; }
      dialog.setBusy(false); dialog.setError(failed.error.message + '；已应用的项不会回滚，可在完成提示里撤销。'); confirm.hidden = true; cancel.textContent = '关闭'; cancel.focus();
      receipt(done);   // 已应用的部分仍给出回执（可撤销）
    };
  }
  // 暂存的变更 → 预览并应用。
  async function reviewStaged() {
    if (batchBusy || !staged.size || !state) return;
    const entries = [...staged.values()].map(change => ({ change, action: actionFor(change, state), ...describeChange(change, state), name: (change.kind === 'mcp' ? state.servers : state.skills).find(item => item.id === change.id)?.name || '' }));
    await openBatch({ title: batchTitle(entries.length), entries });
  }
  const archiveIntro = (action, name) => {
    const skill = action.type === 'skill.archive' ? state?.skills.find(item => item.id === action.id) : null;
    const users = skill ? skill.bindings.filter(binding => connectedState(binding.state)).map(binding => state.clients.find(item => item.id === binding.clientId)?.name || binding.clientId) : [];
    const used = action.type === 'skill.archive' ? (users.length ? `正在使用它的软件：${users.map(esc).join('、')}。归档后这些软件不再有它。` : '目前没有软件接入它。') : '归档后，使用它的软件会失去这个 MCP 服务。';
    return `<div class="extension-archive-intro" data-archive-affected><p><strong>归档「${esc(name)}」</strong></p><p>${used}</p><p>归档不是永久删除：完成后可以在提示里点「撤销」，也可以稍后在操作回执里恢复。</p></div>`;
  };
  async function preview(action, { title, onClose, intro = '', confirmLabel = '', destructive = false } = {}) {
    const plan = await client.prepare(action);
    if (!visible) { onClose?.(); return; }
    const removedId = removalTarget(action); let removal = null;
    const archive = ['skill.archive', 'mcp.archive'].includes(action.type), name = nameFor(action);
    const closed = () => { onClose?.(); if (removal) focusAfterRemoval(removal); };   // 对话框先把焦点还给触发按钮（已被移除），随后才走到这里
    const applyLabel = confirmLabel || (action.type === 'mcp.probe' ? '确认并检测' : archive ? '归档' : '应用变更');
    const dialog = openShell(title || (action.type === 'mcp.probe' ? '确认检测 MCP 连接' : archive ? `确认归档「${name}」` : '预览扩展变更'), `${archive ? archiveIntro(action, name) : intro}${extensionPlanContent(plan)}<p class="extension-error" role="alert" data-dialog-error></p><div class="dialog-footer"><button type="button" class="secondary" data-preview-cancel>取消</button><button type="button" class="${archive || destructive ? 'ui-button ui-button-danger' : 'primary'}" data-preview-apply ${plan.conflicts.length ? 'disabled' : ''}>${applyLabel}</button></div>`, closed);
    dialog.element.querySelector('[data-preview-cancel]').onclick = () => dialog.close();
    dialog.element.querySelector('[data-preview-apply]').onclick = async () => {
      dialog.setBusy(true); dialog.element.querySelector('[data-preview-apply]').disabled = true;
      try {
        const order = removedId && state ? visibleItems().map(item => item.id) : [];   // 提交前记录清单顺序，用于找相邻行
        const result = await controller.submit(plan); if (result.probeId) watchProbe(result.probeId);
        if (removedId) { removal = { id: removedId, order }; changeRoute({ id: null, operation: null }); }
        detailKey = ''; await loadDetail(); dialog.setBusy(false); dialog.close();
        receipt([{ action: plan.normalizedAction, result, name }]);
      }
      catch (error) { dialog.element.querySelector('[data-dialog-error]').textContent = (action.type.startsWith('mcp.') ? mcpErrorMessage(error, name) : action.type === 'skill.resolveConflict' ? conflictErrorMessage(error, { name, clientName: state?.clients.find(item => item.id === action.clientId)?.name }) : error.message) + '；输入与原请求已保留。'; if (action.type.startsWith('mcp.') && shouldRefresh(error) || action.type === 'skill.resolveConflict' && conflictShouldRefresh(error)) void controller.refresh(true); }
      finally { dialog.setBusy(false); dialog.element.querySelector('[data-preview-apply]').disabled = false; }
    };
  }
  // ---- Skill 接入冲突（E-11）----
  // 对比：只读，不进暂存、不产生回执。弹窗先显示「正在读取」，响应回来后只经 compareView（再次脱敏）渲染。
  let compareToken = 0;
  async function openCompare(button) {
    const skill = state?.skills.find(item => item.id === button.dataset.skill), clientInfo = state?.clients.find(item => item.id === button.dataset.client); if (!skill) return;
    const token = ++compareToken, names = { name: skill.name, clientName: clientInfo?.name || button.dataset.client };
    const footer = '<div class="dialog-footer ui-sheet-footer"><button type="button" class="secondary" data-compare-close>关闭</button></div>';
    const dialog = openShell(`对比差异 · ${skill.name} · ${names.clientName}`, `<div data-compare-body aria-live="polite"><p class="extension-compare-loading" role="status" data-compare-loading>正在读取差异…</p></div>${footer}`, () => { compareToken++; });
    dialog.element.classList.add('extension-compare-dialog');
    dialog.element.querySelector('[data-compare-close]').onclick = () => dialog.close();
    const body = () => dialog.element.querySelector('[data-compare-body]');
    try {
      const result = await client.compare({ id: skill.id, clientId: button.dataset.client, expectedVersion: state.version });
      if (token !== compareToken || !body()) return;
      body().innerHTML = compareView(result, { skillName: skill.name, clientName: names.clientName, root: state?.root || '' });
    } catch (error) {
      if (token !== compareToken || !body()) return;
      body().innerHTML = `<p class="extension-error" role="alert" data-compare-error>${esc(conflictErrorMessage(error, names))}</p>`;
      if (conflictShouldRefresh(error)) void controller.refresh(true);
    }
  }
  // 三个选择都走 prepare → 预览确认 → apply → 回执（采用共享可「撤销」→ operation.restore）。不进暂存栏：逐项决定，各自确认。
  async function resolveConflict(button, resolution) {
    const skill = state?.skills.find(item => item.id === button.dataset.skill), clientInfo = state?.clients.find(item => item.id === button.dataset.client); if (!skill) return;
    const clientName = clientInfo?.name || button.dataset.client;
    const action = { type: 'skill.resolveConflict', id: skill.id, clientId: button.dataset.client, resolution };
    try { await preview(action, { title: `${resolveTitle[resolution]} · ${skill.name} · ${clientName}`, intro: resolveIntro({ resolution, skillName: skill.name, clientName }), confirmLabel: resolveTitle[resolution], destructive: resolution === 'adoptShared' }); }
    catch (error) { setError(new Error(conflictErrorMessage(error, { name: skill.name, clientName }))); if (conflictShouldRefresh(error)) void controller.refresh(true); }
  }
  // 单个检测的轮询：排队（queued）和运行（running）都要继续轮询；页面隐藏时停下，回来时由 setVisible 接着查。
  function watchProbe(id) {
    clearTimeout(probeTimer); probeWatching = id;
    async function poll() {
      if (!visible || probeWatching !== id) return;
      if (document.hidden) { probeTimer = setTimeout(poll, 2000); return; }
      try {
        const probe = await client.probe(id), before = liveProbes.get(probe.serverId);
        liveProbes.set(probe.serverId, probe);
        if (probe.status !== before?.status || probe.id !== before?.id) renderList();
        if (selected?.kind === 'mcp' && selected.id === probe.serverId) { const output = $('[data-probe-result]'), markup = probeCardMarkup(selected); if (output && output.innerHTML !== markup) output.innerHTML = markup; if (!activeProbe(probe)) renderDetail({ keepFocus: true }); }
        if (activeProbe(probe)) probeTimer = setTimeout(poll, probe.status === 'queued' ? 800 : 500);
        else { probeWatching = null; void controller.refresh(); }
      } catch (error) { probeWatching = null; setError(error); }
    }
    void poll();
  }
  // ---- 检测全部服务（E-12）：对话框确认后 POST /probes；后端最多同时跑 2 个，其余排队；这里逐个轮询、可整体取消 ----
  function probeAllMarkup(filtered) {
    if (probeAllRun) return `<div class="extension-probe-all"><span class="extension-probe-progress" aria-hidden="true" data-probe-progress>${esc(probeAllRun.cancelling ? '正在取消…' : progressText(progressOf(probeAllRun.probes.values())))}</span><button type="button" class="secondary" data-cancel-all-probes ${probeAllRun.cancelling ? 'disabled' : ''}>取消全部检测</button></div>`;
    const plan = probeAllPlan(filtered), ok = plan.targets.length > 0;
    return `<div class="extension-probe-all"><button type="button" class="secondary" data-probe-all ${ok ? '' : 'disabled aria-describedby="extension-probe-all-hint"'}>检测全部服务</button>${ok ? '' : '<small class="extension-probe-progress" id="extension-probe-all-hint">没有已启用的共享服务可检测</small>'}</div>`;
  }
  function announceProbeAll(text) { const live = $('[data-probe-live]'); if (live && live.textContent !== text) live.textContent = text; }
  function openProbeAll() {
    if (!state || probeAllRun) return;
    const plan = probeAllPlan(visibleItems()); if (!plan.targets.length) return;
    const names = list => list.map(server => `<li><strong>${esc(server.name)}</strong> <code>${esc(commandLine(server))}</code></li>`).join('');
    const dialog = openShell('检测全部服务', `<p>将逐个启动下面 ${plan.targets.length} 个已启用服务的命令（或连接它们的端点）并读取工具清单。同时最多检测 2 个，其余排队，可以随时取消。${plan.targets.length > PROBE_BATCH_SIZE ? `服务较多，将分 ${chunkIds(plan.targets.map(server => server.id)).length} 批提交（每批最多 ${PROBE_BATCH_SIZE} 个）。` : ''}</p><ul class="extension-probe-list" data-probe-targets>${names(plan.targets)}</ul>${plan.skipped.length ? `<p>不检测（已停用）：${plan.skipped.map(server => esc(server.name)).join('、')}</p>` : ''}${plan.clientLocal ? `<p>另有 ${plan.clientLocal} 个本地配置的服务由对应软件管理，不在这里检测。</p>` : ''}<p class="extension-error" role="alert" data-dialog-error></p><div class="dialog-footer"><button type="button" class="secondary" data-preview-cancel>取消</button><button type="button" class="primary" data-preview-apply>开始检测</button></div>`);
    dialog.element.querySelector('[data-preview-cancel]').onclick = () => dialog.close();
    dialog.element.querySelector('[data-preview-apply]').onclick = async () => {
      dialog.setBusy(true); dialog.element.querySelector('[data-preview-apply]').disabled = true;
      try {
        const started = [], skipped = [];
        for (const [index, ids] of chunkIds(plan.targets.map(server => server.id)).entries()) {   // 后端一次最多 50 个
          try { const result = await client.probeAll(ids, state.version); started.push(...(result.probes || [])); skipped.push(...(result.skipped || [])); }
          catch (error) { if (index === 0) throw error; dialog.setBusy(false); dialog.close(); startProbeAll(started, skipped); showToast({ message: `只提交了前 ${started.length + skipped.length} 个服务：${mcpErrorMessage(error)}`, tone: 'warning' }); if (shouldRefresh(error)) void controller.refresh(true); return; }
        }
        dialog.setBusy(false); dialog.close();
        startProbeAll(started, skipped);
      } catch (error) {
        dialog.element.querySelector('[data-dialog-error]').textContent = mcpErrorMessage(error) + (error?.status === 409 && !error.code ? '（清单已变化，已刷新，请重新确认）' : '');
        if (shouldRefresh(error)) void controller.refresh(true);
        dialog.setBusy(false); dialog.element.querySelector('[data-preview-apply]').disabled = false;
      }
    };
  }
  function startProbeAll(probes, skipped) {
    if (!probes.length) { showToast({ message: skipped.length ? `没有可检测的服务（${skipped.length} 个已停用，已跳过）` : '没有可检测的服务', tone: 'info' }); return; }
    probeAllRun = { probes: new Map(probes.map(probe => [probe.id, probe])), skipped: skipped.length, cancelling: false, lastText: '' };
    for (const probe of probes) liveProbes.set(probe.serverId, probe);
    renderList(); setTimeout(() => $('[data-cancel-all-probes]')?.focus(), 0);
    announceProbeAll(progressText(progressOf(probeAllRun.probes.values()))); pollProbeAll();
  }
  function resumeProbeAll(probes) {
    probeAllRun = { probes: new Map(probes.map(probe => [probe.id, probe])), skipped: 0, cancelling: false, lastText: '' };
    for (const probe of probes) liveProbes.set(probe.serverId, probe);
    if (visible) pollProbeAll();
  }
  async function pollProbeAll() {
    clearTimeout(probeAllTimer); const run = probeAllRun; if (!run || !visible) return;
    if (document.hidden) { probeAllTimer = setTimeout(pollProbeAll, 2000); return; }
    try {
      for (const probe of [...run.probes.values()].filter(activeProbe)) {   // 逐个查询，不并发
        if (probeAllRun !== run || !visible) return;
        try { const next = await client.probe(probe.id); run.probes.set(probe.id, next); liveProbes.set(next.serverId, next); }
        catch (error) { if (error?.status === 404) { run.probes.delete(probe.id); liveProbes.delete(probe.serverId); } else throw error; }
      }
    } catch (error) { setError(error); finishProbeAll(); return; }
    const progress = progressOf(run.probes.values()), text = run.cancelling ? '正在取消…' : progressText(progress);
    renderList();
    if (text !== run.lastText) { run.lastText = text; announceProbeAll(text); }
    if (!progress.active) { finishProbeAll(); return; }
    probeAllTimer = setTimeout(pollProbeAll, 600);
  }
  async function finishProbeAll() {
    const run = probeAllRun; if (!run) return; clearTimeout(probeAllTimer);
    const progress = progressOf(run.probes.values()), wasFocused = document.activeElement?.hasAttribute?.('data-cancel-all-probes') || document.activeElement === document.body;
    probeAllRun = null;
    try { await controller.refresh(); } catch { /* 读取失败会走常规的失败提示 */ }
    renderList(); if (wasFocused) $('[data-probe-all]')?.focus({ preventScroll: true });
    const message = finishText(progress) + (run.skipped ? `；${run.skipped} 个已停用，已跳过` : ''); announceProbeAll(message); showToast({ message, tone: progress.failed ? 'warning' : 'success' });
  }
  async function cancelProbeAll() {
    const run = probeAllRun; if (!run || run.cancelling) return; run.cancelling = true; renderList();
    for (const probe of [...run.probes.values()].filter(activeProbe)) { try { await client.cancelProbe(probe.id); } catch (error) { if (![404, 409].includes(error?.status)) { setError(error); break; } } }
    pollProbeAll();
  }
  async function cancelOneProbe(id) {
    try { await client.cancelProbe(id); } catch (error) { setError(error); if (shouldRefresh(error)) void controller.refresh(); }
    if (probeWatching === id) { clearTimeout(probeTimer); probeTimer = setTimeout(() => watchProbe(id), 0); }
    else if (liveProbes.size) void client.probe(id).then(probe => { liveProbes.set(probe.serverId, probe); renderList(); }).catch(() => {});
  }
  // ---- MCP 导入 JSON（0.7 PR-12，最小版：粘贴 → 预览 → 同 ID 冲突逐项处理 → 应用）----
  // 复用 E-11：对比只读（不进暂存、不产生回执）、替换用红色破坏性按钮二次确认、成功后 toast「撤销」→ operation.restore。
  // 对比与选择只在 capabilities.extensions.mcpConflictCompare === true 时出现；旧后端上冲突仍是文字冲突，不能应用。
  function openImportJson() {
    if (!state) return;
    const compareOn = mcpCompareSupported(state.capabilities), root = state.root || '';
    const natives = state.clients.filter(item => item.selected && item.mcpMode === 'native');
    const scopeField = selectField({ id: 'extension-import-scope', name: 'clientId', label: '导入到', value: natives.some(item => item.id === route.client) ? route.client : '', options: [{ value: '', label: '共享来源 ~/.agents' }, ...natives.map(item => ({ value: item.id, label: item.name + ' · 本地配置' }))] });
    const dialog = openShell('导入 MCP JSON', `<form class="extension-editor extension-mcp-import" data-import-form novalidate><p>粘贴 <code>{"mcpServers": {…}}</code>。导入只写配置，不会启动服务；明文凭据会被拒绝，请改用环境变量引用。</p>${scopeField}<label>MCP JSON<textarea name="json" rows="9" spellcheck="false" autocapitalize="none" data-import-text></textarea></label><p class="extension-error" role="alert" data-dialog-error></p><div class="extension-mcp-import-review" data-import-review aria-live="polite"></div><div class="dialog-footer"><button type="button" class="secondary" data-import-cancel>取消</button><button type="submit" class="primary" data-import-preview>预览导入</button></div></form>`);
    dialog.element.classList.add('extension-compare-dialog');
    const form = dialog.element.querySelector('[data-import-form]'), review = form.querySelector('[data-import-review]'), text = form.querySelector('[data-import-text]'), previewButton = form.querySelector('[data-import-preview]');
    const setError = message => { form.querySelector('[data-dialog-error]').textContent = message || ''; };
    const scopeValue = () => form.querySelector('#extension-import-scope')?.value || '';
    let session = null, working = false;
    const baseAction = (json, clientId) => ({ type: 'mcp.importJson', scope: clientId ? 'client' : 'shared', ...(clientId ? { clientId } : {}), json });
    const withChoices = () => { const resolutions = cleanChoices(session.choices, session.ids); return { ...session.base, ...(Object.keys(resolutions).length ? { resolutions } : {}) }; };
    const busy = on => { working = on; dialog.setBusy(on); previewButton.disabled = on; form.querySelectorAll('[data-mcp-resolution]').forEach(input => { input.disabled = on || input.dataset.locked === 'true'; }); updateApply(); };
    const reset = () => { session = null; review.innerHTML = ''; setError(''); };
    function updateApply() {
      const apply = form.querySelector('[data-import-apply]'); if (!apply) return;
      apply.disabled = working || !session || !session.plan || session.plan.conflicts.length > 0 || (session.ids.length > 0 && !allChosen(session.choices, session.ids));
    }
    function renderPlan() { const box = form.querySelector('[data-import-plan]'); if (box) box.innerHTML = extensionPlanContent(session.plan); updateApply(); }
    function renderReview() {
      const choiceable = compareOn && session.items.length > 0;
      const hint = choiceable ? '<p data-import-hint>下面的服务在这里已经存在。每一个都要选择怎么处理，才能应用；默认不会替换。</p>' : '';
      review.innerHTML = `<div data-import-plan>${extensionPlanContent(session.plan)}</div>${hint}${choiceable ? conflictChoiceList(session.items, session.choices) : ''}<div data-import-actions><div class="dialog-footer"><button type="button" class="primary" data-import-apply disabled>应用导入</button></div></div>`;
      form.querySelectorAll('[data-mcp-conflict]').forEach(group => { const item = session.items.find(entry => entry.id === group.dataset.id); if (item?.editable === false) group.querySelector('input[value="adoptNew"]').dataset.locked = 'true'; });
      updateApply(); (review.querySelector('[data-mcp-compare]') || review.querySelector('[data-import-apply]'))?.focus();
    }
    async function runPreview() {
      const json = text.value, clientId = scopeValue(); setError('');
      if (!json.trim()) { setError('请先粘贴要导入的 MCP JSON。'); text.focus(); return; }
      reset(); busy(true);
      try {
        const base = baseAction(json, clientId), plan = await client.prepare(base);
        let items = [];
        if (compareOn && plan.conflicts.length) items = (await client.mcpCompare({ scope: base.scope, ...(clientId ? { clientId } : {}), json, expectedVersion: plan.expectedVersion })).items || [];
        session = { base, plan, items, ids: items.map(item => item.id), choices: {}, token: 0, version: plan.expectedVersion };
        renderReview();
      } catch (error) { setError(mcpCompareErrorMessage(error)); if (mcpShouldRefresh(error)) void controller.refresh(true); }
      finally { busy(false); }
    }
    async function refreshPlan() {
      if (!session) return; const mine = ++session.token; busy(true);
      try { const plan = await client.prepare(withChoices()); if (!session || mine !== session.token) return; session.plan = plan; renderPlan(); setError(''); }
      catch (error) { if (session && mine === session.token) setError(mcpCompareErrorMessage(error)); }
      finally { if (!session || mine === session.token) busy(false); }
    }
    async function showCompare(button) {
      const id = button.dataset.id, group = [...form.querySelectorAll('[data-mcp-conflict]')].find(entry => entry.dataset.id === id), body = group?.querySelector('[data-mcp-compare-body]'); if (!body || !session) return;
      if (button.getAttribute('aria-expanded') === 'true') { body.innerHTML = ''; button.setAttribute('aria-expanded', 'false'); return; }
      button.disabled = true; body.innerHTML = '<p class="extension-compare-loading" role="status">正在读取差异…</p>';
      try {
        const clientId = scopeValue(), result = await client.mcpCompare({ scope: session.base.scope, ...(clientId ? { clientId } : {}), json: session.base.json, expectedVersion: session.version });
        body.innerHTML = mcpCompareView(result, { root, only: id }); button.setAttribute('aria-expanded', 'true');
      } catch (error) { body.innerHTML = `<p class="extension-error" role="alert" data-compare-error>${esc(mcpCompareErrorMessage(error))}</p>`; if (mcpShouldRefresh(error)) void controller.refresh(true); }
      finally { button.disabled = false; }
    }
    async function commit() {
      busy(true); setError('');
      try {
        const plan = session.plan, result = await controller.submit(plan); dialog.setBusy(false); dialog.close();
        receipt([{ action: { ...plan.normalizedAction, resolutions: plan.normalizedAction?.resolutions || cleanChoices(session.choices, session.ids) }, result, name: '' }]);
      } catch (error) {
        setError(mcpCompareErrorMessage(error) + '；输入已保留，请重新预览。'); if (mcpShouldRefresh(error)) { session = null; review.innerHTML = ''; void controller.refresh(true); }
        busy(false);
      }
    }
    function confirmReplace() {
      const ids = adoptedIds(session.choices, session.ids), box = form.querySelector('[data-import-actions]');
      box.innerHTML = `${replaceConfirm(ids)}<div class="dialog-footer"><button type="button" class="secondary" data-import-back>返回</button><button type="button" class="ui-button ui-button-danger" data-import-replace>确认替换</button></div>`;
      box.querySelector('[data-import-back]').focus();
    }
    form.onsubmit = event => { event.preventDefault(); if (!working) void runPreview(); };
    form.querySelector('[data-import-cancel]').onclick = () => dialog.close();
    form.addEventListener('input', event => { if (event.target === text && session) reset(); });
    form.addEventListener('change', event => {
      if (event.target.closest?.('#extension-import-scope') && session) { reset(); return; }
      const input = event.target.closest?.('[data-mcp-resolution]'); if (!input || !session) return;
      session.choices = { ...session.choices, [input.dataset.id]: input.value }; updateApply(); void refreshPlan();
    });
    form.addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button || working && !button.matches('[data-import-back]')) return;
      if (button.matches('[data-mcp-compare]')) void showCompare(button);
      else if (button.matches('[data-import-apply]')) { if (adoptedIds(session.choices, session.ids).length) confirmReplace(); else void commit(); }
      else if (button.matches('[data-import-replace]')) void commit();
      else if (button.matches('[data-import-back]')) { const box = form.querySelector('[data-import-actions]'); box.innerHTML = '<div class="dialog-footer"><button type="button" class="primary" data-import-apply>应用导入</button></div>'; updateApply(); box.querySelector('[data-import-apply]').focus(); }
    });
    text.focus();
  }
  // ---- 从文件夹导入 Skill（0.7 PR-8）：一次一个文件夹 → 预览（只读）→ 导入；同名冲突不覆盖，只提示 ----
  // 选文件夹：只有原生桥接存在时才显示「选择文件夹…」（folder-picker.js）；否则手输绝对路径。两种方式拿到的路径都以后端 skill.import 的校验为准。
  function openImportSkill() {
    if (!state) return;
    const pickerOn = folderPickerAvailable(), picker = pickerOn ? createFolderPicker() : null;
    let closed = false;
    const dialog = openShell('从文件夹导入 Skill', `<form class="extension-editor extension-skill-import" data-skill-import-form novalidate>${importDialogIntro({ pickerAvailable: pickerOn })}<label>${sourcePathLabel}<input name="sourcePath" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="4096" placeholder="/Users/…/my-skill" data-import-path></label><p class="extension-field-hint" id="skill-import-path-hint">${esc(sourcePathHint)}</p>${pickerOn ? '<div class="extension-import-pick"><button type="button" class="secondary" data-pick-folder>选择文件夹…</button></div>' : ''}<p class="extension-import-status" role="status" data-import-status></p><p class="extension-error" role="alert" data-dialog-error></p><div class="extension-skill-import-review" data-import-review aria-live="polite"></div><div class="dialog-footer"><button type="button" class="secondary" data-import-cancel>取消</button><button type="submit" class="primary" data-import-preview>预览导入</button></div></form>`, () => { closed = true; });
    dialog.element.classList.add('extension-compare-dialog');
    const form = dialog.element.querySelector('[data-skill-import-form]'), review = form.querySelector('[data-import-review]'), input = form.querySelector('[data-import-path]'), pickButton = form.querySelector('[data-pick-folder]'), previewButton = form.querySelector('[data-import-preview]'), statusLine = form.querySelector('[data-import-status]');
    // createFieldMessages 会把 aria-describedby 整个改写成「只含错误」；这里每次都补上常驻的格式提示，不让提示在错误清掉后丢了关联。
    const fieldMessages = createFieldMessages(form);
    const describe = () => input.setAttribute('aria-describedby', [...(fieldMessages.has('sourcePath') ? ['field-error-sourcePath'] : []), 'skill-import-path-hint'].join(' '));
    const messages = { has: name => fieldMessages.has(name), error: (...args) => { const done = fieldMessages.error(...args); describe(); return done; }, clearAll: () => { fieldMessages.clearAll(); describe(); } };
    describe();
    const setError = message => { form.querySelector('[data-dialog-error]').textContent = message || ''; };
    let phase = 'idle', session = null;
    const setPhase = next => {
      phase = next; const view = importPhaseView(phase, { pickerAvailable: pickerOn });
      form.dataset.phase = phase; input.readOnly = !view.canEditPath; previewButton.disabled = !view.canPreview; if (pickButton) pickButton.disabled = !view.canPick;
      statusLine.textContent = view.status; form.querySelector('[data-import-apply]')?.toggleAttribute('disabled', !view.canApply);
      dialog.setBusy(phase === 'previewing' || phase === 'importing');
    };
    const reset = () => { session = null; review.innerHTML = ''; setError(''); messages.clearAll(); if (phase !== 'picking') setPhase('idle'); };
    const showFailure = error => {
      const failure = importFailure(error);
      if (failure.field === 'sourcePath' && messages.error('sourcePath', failure.message)) input.focus(); else { setError(failure.message); input.focus(); }
    };
    async function pickFolder() {
      if (!picker || phase !== 'idle' && phase !== 'ready' && phase !== 'conflict' && phase !== 'failed') return;
      reset(); setPhase('picking');
      const result = await picker.pick();
      if (closed) return;
      setPhase('idle');
      if (result.status === 'picked') { input.value = result.path; statusLine.textContent = '已填入所选文件夹的路径，请核对后点「预览导入」。'; input.focus(); }
      else if (result.status === 'error' || result.status === 'timeout') { setError(result.message); (input || pickButton).focus(); }
      else pickButton?.focus();            // 取消：不报错，回到「选择文件夹…」
    }
    async function runPreview() {
      reset();
      const checked = validateSourcePath(input.value);
      if (!checked.ok) { messages.error('sourcePath', checked.message); input.focus(); return; }
      input.value = checked.path; setPhase('previewing');
      try {
        const base = { type: 'skill.import', scope: 'shared', sourcePath: checked.path }, plan = await client.prepare(base);
        if (closed) return;
        session = { base, plan };
        const conflict = importHasConflict(plan);
        review.innerHTML = `<div data-import-plan>${extensionPlanContent(plan)}</div>${conflict ? `<p class="extension-error" data-import-conflict tabindex="-1" id="skill-import-conflict">${esc(importConflictNote)}</p>` : ''}<div class="dialog-footer"><button type="button" class="primary" data-import-apply ${conflict ? 'disabled aria-describedby="skill-import-conflict"' : ''}>导入</button></div>`;
        setPhase(conflict ? 'conflict' : 'ready');
        (conflict ? review.querySelector('[data-import-conflict]') : review.querySelector('[data-import-apply]'))?.focus();
      } catch (error) { if (closed) return; setPhase('failed'); showFailure(error); if (error?.code === 'EXTENSIONS_VERSION_CONFLICT') void controller.refresh(true); }
    }
    async function commit() {
      if (phase !== 'ready' || !session) return;
      setPhase('importing'); setError('');
      try {
        const plan = session.plan, result = await controller.submit(plan), target = plan.files?.[0]?.path;
        dialog.setBusy(false); dialog.close();
        receipt([{ action: plan.normalizedAction || session.base, result, name: target ? String(target).split('/').filter(Boolean).pop() : '' }]);
      } catch (error) {
        if (closed) return;
        session = null; review.innerHTML = ''; setPhase('failed');
        if (['submitted', 'unknown'].includes(controller.getSubmission()?.status)) {
          // 服务没有给出明确回应：文件可能已经写入。不让用户在这里再点一次（controller 也会拒绝），指向页面上的「核对原请求」。
          setError(importUnknownMessage); input.readOnly = true; previewButton.disabled = true; if (pickButton) pickButton.disabled = true; form.dataset.phase = 'unknown'; form.querySelector('[data-import-cancel]').focus();
        } else showFailure(error);
        if (error?.code === 'EXTENSIONS_VERSION_CONFLICT' || error?.status === 409) void controller.refresh(true);
      }
    }
    form.onsubmit = event => { event.preventDefault(); if (phase === 'previewing' || phase === 'importing' || phase === 'picking') return; void runPreview(); };
    form.querySelector('[data-import-cancel]').onclick = () => dialog.close();
    form.addEventListener('input', event => { if (event.target === input && (session || messages.has('sourcePath') || phase === 'failed' || form.querySelector('[data-dialog-error]').textContent)) reset(); });
    form.addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button) return;
      if (button.matches('[data-pick-folder]')) void pickFolder(); else if (button.matches('[data-import-apply]')) void commit();
    });
    setPhase('idle'); input.focus();
  }
  function edit(create = false) {
    const item = create ? null : selected, isMcp = create ? route.tab === 'mcp' : item.kind === 'mcp', isClient = create ? route.tab === 'clients' : item.kind === 'client', key = create ? 'new:' + route.tab : item.id + ':' + (item.file || ''), draft = controller.drafts.get(key);
    const destinations = [{ value: '', label: '共享来源 ~/.agents' }, ...state.clients.filter(client => client.selected && (!isMcp || client.mcpMode === 'native')).map(client => ({ value: client.id, label: client.name + ' · 本地配置' }))];
    const destination = create && !isClient ? selectField({ id: 'extension-destination', name: 'clientId', label: '保存到', value: route.client || '', options: destinations }) : '';
    const form = isClient ? `<p>常见 CLI 会自动识别；其他 CLI 可手动登记目录，并选择已核实的适配器。</p><input type="hidden" name="id" value="${esc(item?.id || draft?.id || 'client_' + crypto.randomUUID())}"><div class="extension-form-grid">${textField('name', '软件名称', item?.name, 'required maxlength="80" placeholder="如 Claude Code"')}${textField('command', 'CLI 命令', item?.command, 'required maxlength="2000" placeholder="命令名或可执行文件绝对路径"')}</div>${textField('root', '软件主目录', item?.root, 'required maxlength="2000" placeholder="如 ~/.claude"')}${textField('skillsDirectory', 'Skills 相对目录', item?.skillsDirectory || 'skills', 'required maxlength="2000" placeholder="如 skills 或 agent/skills"')}${selectField({ id: 'extension-client-adapter', name: 'adapter', label: 'CLI 适配器', value: item?.adapter || 'auto', options: [{ value: 'auto', label: '按命令自动匹配' }, { value: 'manual', label: '仅管理 Skills / 导出 MCP' }, ...state.adapters.map(({ id, name }) => ({ value: id, label: name }))] })}${selectField({ id: 'extension-client-mcp-format', name: 'mcpFormat', label: '未匹配适配器时的导出格式', value: item?.mcpFormat || 'none', options: [{ value: 'none', label: '暂不生成 MCP 配置' }, { value: 'toml', label: 'TOML（Codex 格式）' }, { value: 'json', label: 'JSON（Qoder 格式）' }] })}` : isMcp ? `${destination}<p>${item?.scope === 'client' ? '只修改该软件的用户级 MCP，保留已有凭据与其他配置。' : '保存到所选来源；共享配置可再接入软件。'}凭据请填环境变量名。</p><div class="extension-form-grid">${textField('id', '稳定 ID', item?.serverKey || item?.id, 'required maxlength="' + (create && !route.client && !draft?.clientId ? 80 : 200) + '" autocapitalize="none" spellcheck="false" autocomplete="off" ' + (item ? 'readonly' : ''))}${textField('name', '服务名称', item?.name, 'required maxlength="200"')}</div>${selectField({ id: 'extension-transport', name: 'transport', label: '连接方式', value: item?.transport || 'stdio', options: [{ value: 'stdio', label: '本地命令（stdio）' }, { value: 'http', label: 'HTTP 服务' }] })}<div data-stdio-fields>${textField('command', '可执行命令', item?.command, 'placeholder="如 node 或 /绝对路径/程序"')}<label>参数（每行一项）<textarea name="args" rows="3">${esc((item?.args || []).join('\n'))}</textarea></label>${textField('cwd', '工作目录（可选）', item?.cwd)}<label>环境变量引用（每行 名称=环境变量名）<textarea name="envRefs" rows="3" placeholder="API_TOKEN=API_TOKEN">${esc(refText(item?.envRefs))}</textarea></label></div><div data-http-fields>${textField('url', 'HTTP 端点', item?.url, 'type="url" placeholder="https://example.com/mcp"')}<label>请求头引用（每行 请求头=环境变量名）<textarea name="headerRefs" rows="3" placeholder="Authorization=MCP_AUTH_HEADER">${esc(refText(item?.headerRefs))}</textarea></label></div><label class="extension-checkbox" data-enabled-field><input type="checkbox" name="enabled" ${item?.enabled !== false ? 'checked' : ''}>配置启用（软件生效需刷新；不支持启停的软件只能保存为启用）</label>` : create ? `${destination}${textField('directory', 'Skill 名称 / 目录', '', 'required pattern="[a-z0-9][a-z0-9\\-]{0,63}" maxlength="64" autocapitalize="none" spellcheck="false" autocomplete="off" placeholder="如 review-code"')}<label>用途说明<textarea name="description" required rows="2" placeholder="什么时候使用这个 Skill"></textarea></label><label>操作说明<textarea name="body" rows="10" placeholder="写下使用步骤和约束"></textarea></label>` : `<p>编辑来源 ${esc(item.sourcePath)}/${esc(item.file)}，不会执行其中的脚本。</p><label>文件内容<textarea name="content" rows="16" spellcheck="false" required>${esc(item.content)}</textarea></label>`;
    const dialog = openShell(isClient ? create ? '添加 CLI' : '编辑 CLI' : create ? isMcp ? '新建 MCP 服务' : '新建 Skill' : '编辑主来源', `<form class="extension-editor">${form}${isClient || isMcp ? '<div data-client-review hidden></div>' : ''}${create && isMcp ? '<div class="extension-duplicate-panel" data-duplicate-panel hidden></div>' : ''}<p class="extension-error" role="alert" data-dialog-error></p><p class="extension-draft-note" role="status">未保存内容在切换页面后保留。</p><div class="dialog-footer"><button type="button" class="secondary" data-editor-cancel>取消</button><button type="submit" class="primary">${isClient ? '预览登记' : '保存主来源'}</button></div></form>`);
    const editor = dialog.element.querySelector('form');
    if (draft) for (const [name, value] of Object.entries(draft)) { const control = editor.elements[name]; if (control) control.type === 'checkbox' ? control.checked = value : control.value = value; }
    if (isMcp) editor.querySelector('#extension-transport').value = editor.elements.transport.value;
    if (isClient) { editor.querySelector('#extension-client-mcp-format').value = editor.elements.mcpFormat.value; editor.querySelector('#extension-client-adapter').value = editor.elements.adapter.value; }
    const saveDraft = () => controller.drafts.set(key, Object.fromEntries([...editor.elements].filter(field => field.name).map(field => [field.name, field.type === 'checkbox' ? field.checked : field.value])));
    const toggleTransport = () => { if (isMcp) { const http = editor.elements.transport.value === 'http'; editor.querySelector('[data-stdio-fields]').hidden = http; editor.querySelector('[data-http-fields]').hidden = !http; const target = state.clients.find(client => client.id === (item?.clientId || editor.elements.clientId?.value)); const enabled = editor.elements.enabled; enabled.disabled = !!target && !target.mcpToggle; if (enabled.disabled) enabled.checked = true; } };
    const clearReview = () => { if (isClient || isMcp) { const review = editor.querySelector('[data-client-review]'); review.hidden = true; review.innerHTML = ''; editor.querySelector('[type=submit]').hidden = false; } };
    toggleTransport(); editor.addEventListener('input', () => { saveDraft(); clearReview(); }); editor.addEventListener('change', () => { saveDraft(); clearReview(); toggleTransport(); });
    // ---- 字段级校验（E-04 / E-16 / E-01）与 http 警告（E-17）：客户端先拦，服务端仍是最终裁判 ----
    editor.noValidate = true;   // 不用浏览器原生英文气泡
    const messages = createFieldMessages(editor), formKind = isClient ? 'client' : isMcp ? 'mcp' : create ? 'skill-create' : 'skill-edit';
    const setDialogError = text => { editor.querySelector('[data-dialog-error]').textContent = text; };
    const viewExistingAction = { id: 'view-existing', label: '查看现有服务' };
    let duplicateOf = null, lastAction = null, conflictChoice = null;
    const duplicateAware = create && isMcp && mcpCompareSupported(state?.capabilities);
    const formValues = () => { saveDraft(); return controller.drafts.get(key) || {}; };
    const validate = values => validateExtensionForm({ kind: formKind, creating: create, values, servers: state?.servers || [] });
    function showError(found) { if (found.duplicate) duplicateOf = found.duplicate; messages.error(found.name, found.message, found.duplicate ? { action: viewExistingAction } : undefined); }
    function liveCheck(name) {
      messages.clear(name); if (name === 'id') duplicateOf = null;
      const values = formValues(); if (!values[name] || !String(values[name]).trim()) return;
      const found = validate(values).find(entry => entry.name === name); if (found) showError(found);
    }
    function updateHttpWarning() {
      if (!isMcp) return; const values = formValues();
      messages.warning('url', values.transport === 'http' ? insecureHttpWarning((values.url || '').trim(), { hasHeaders: !!(values.headerRefs || '').trim() }) : '');
    }
    editor.addEventListener('input', event => {
      const name = event.target.name; if (!name) return; setDialogError('');
      if (messages.has(name) || ((name === 'id' && create && isMcp) || name === 'directory')) liveCheck(name);
      if (name === 'url' || name === 'headerRefs') updateHttpWarning();
    });
    editor.addEventListener('change', event => {
      const name = event.target.name; if (!name) return;
      if (['url', 'headerRefs', 'envRefs', 'cwd'].includes(name) && messages.has(name)) liveCheck(name); // 首次错误留到提交时再出：失焦就插入提示会把“保存”按钮顶走，点击落空
      if (['url', 'headerRefs', 'transport'].includes(name)) updateHttpWarning();
      if (name === 'clientId' && create && isMcp) liveCheck('id');
    });
    editor.addEventListener('click', event => {
      if (event.target.closest('[data-field-action="view-existing"]') && duplicateOf) { const existing = duplicateOf; saveDraft(); dialog.close(); changeRoute({ id: existing.id, operation: null, file: null }); }
    });
    updateHttpWarning();
    function reportFailure(error) {
      if (error.code !== 'EXTENSIONS_DUPLICATE_ID') hideDuplicatePanel();   // 非同 ID 冲突的失败：收起面板并清掉已选处理方式
      const raw = String(error.field || '').replace(/^(server|client)\./, ''), name = [fieldInputName(error.field), raw].find(candidate => candidate && editor.elements[candidate]);
      if (!name) { setDialogError(error.message); return; }
      const duplicate = error.code === 'EXTENSIONS_DUPLICATE_ID' ? findDuplicateServer(state?.servers || [], { id: formValues().id, clientId: formValues().clientId || '' }) : null;
      showError({ name, message: error.message, ...(duplicate ? { duplicate } : {}) });
      setDialogError('有字段需要修改，输入已保留。'); editor.elements[name].focus();
      if (duplicateAware && error.code === 'EXTENSIONS_DUPLICATE_ID' && lastAction?.server) void showDuplicatePanel();
    }
    // ---- 同 ID 冲突（PR-12）：409 EXTENSIONS_DUPLICATE_ID → 对比 + 「用新填写的替换 / 保留现有」→ 以 onConflict 重新 prepare ----
    const duplicatePanel = () => editor.querySelector('[data-duplicate-panel]');
    function hideDuplicatePanel() { const panel = duplicatePanel(); if (panel) { panel.hidden = true; panel.innerHTML = ''; } conflictChoice = null; }
    async function showDuplicatePanel() {
      const panel = duplicatePanel(), action = lastAction; if (!panel || !action?.server) return;
      const clientId = action.clientId || '', root = state?.root || '';
      panel.hidden = false; panel.innerHTML = '<p class="extension-compare-loading" role="status">正在读取现有服务…</p>';
      let item;
      try {
        const result = await client.mcpCompare({ scope: clientId ? 'client' : 'shared', ...(clientId ? { clientId } : {}), server: action.server, expectedVersion: state?.version });
        item = (result.items || []).find(entry => entry.id === action.server.id);
        if (!item) { panel.innerHTML = '<p role="status">这个 ID 现在已经没有同名服务了，直接再保存一次即可。</p>'; return; }
      } catch (error) { panel.innerHTML = `<p class="extension-error" role="alert">${esc(mcpCompareErrorMessage(error))}</p>`; if (mcpShouldRefresh(error)) void controller.refresh(true); return; }
      const label = id => esc(shownText(id));
      panel.innerHTML = `<p><strong>已经有 ID 为「${label(item.id)}」的 MCP 服务</strong>。选择怎么处理，再继续保存；默认不会替换。</p>${conflictChoiceList([item], {}, { source: 'form' })}<div data-duplicate-actions><div class="dialog-footer"><button type="button" class="primary" data-duplicate-continue disabled>按所选继续</button></div></div>`;
      panel.querySelector('[data-mcp-compare]')?.focus();
      let chosen = '';
      const renderActions = () => { const box = panel.querySelector('[data-duplicate-actions]'); box.innerHTML = '<div class="dialog-footer"><button type="button" class="primary" data-duplicate-continue>按所选继续</button></div>'; };
      panel.onchange = event => { const input = event.target.closest('[data-mcp-resolution]'); if (!input) return; chosen = input.value; settleDuplicateFieldError({ messages, setDialogError }); panel.querySelector('[data-duplicate-continue]')?.removeAttribute('disabled'); };
      panel.onclick = async event => {
        const button = event.target.closest('button'); if (!button) return;
        if (button.matches('[data-mcp-compare]')) {
          const body = panel.querySelector('[data-mcp-compare-body]');
          if (button.getAttribute('aria-expanded') === 'true') { body.innerHTML = ''; button.setAttribute('aria-expanded', 'false'); return; }
          body.innerHTML = mcpCompareView({ items: [item], newIds: [] }, { root, incomingLabel: '新填写的', only: item.id }); button.setAttribute('aria-expanded', 'true');
        } else if (button.matches('[data-duplicate-continue]')) {
          if (chosen === 'adoptNew') {
            settleDuplicateFieldError({ messages, setDialogError });
            const box = panel.querySelector('[data-duplicate-actions]');
            box.innerHTML = `${replaceConfirm([item.id], { source: 'form' })}<div class="dialog-footer"><button type="button" class="secondary" data-duplicate-back>返回</button><button type="button" class="ui-button ui-button-danger" data-duplicate-replace>确认替换</button></div>`;
            box.querySelector('[data-duplicate-back]').focus();
          } else if (chosen === 'keepExisting') { conflictChoice = 'keepExisting'; editor.requestSubmit(); }
        } else if (button.matches('[data-duplicate-back]')) { renderActions(); panel.querySelector('[data-duplicate-continue]').focus(); }
        else if (button.matches('[data-duplicate-replace]')) { conflictChoice = 'adoptNew'; editor.requestSubmit(); }
      };
    }
    editor.addEventListener('input', event => { if (event.target.name === 'id') hideDuplicatePanel(); });
    editor.addEventListener('change', event => { if (event.target.name === 'clientId') hideDuplicatePanel(); });
    editor.querySelector('[data-editor-cancel]').onclick = () => dialog.close();
    async function run(work) {
      if (submitting) return;
      submitting = true; dialog.setBusy(true); editor.querySelector('[data-dialog-error]').textContent = '';
      const controls = [...editor.querySelectorAll('input:not([type=hidden]), textarea, workbench-select')].map(control => [control, control.disabled]);
      controls.forEach(([control]) => control.disabled = true);
      editor.querySelectorAll('[type=submit], [data-client-confirm]').forEach(button => button.disabled = true);
      let failure = null;
      try { await work(); }
      catch (error) { failure = error; }
      finally { submitting = false; dialog.setBusy(false); controls.forEach(([control, disabled]) => control.disabled = disabled); editor.querySelector('[type=submit]').disabled = false; const confirm = editor.querySelector('[data-client-confirm]'); if (confirm) confirm.disabled = confirm.dataset.conflicts === 'true'; }
      if (failure) reportFailure(failure);
    }
    async function commit(plan) {
      const savedName = controller.drafts.get(key)?.name || item?.name || '', result = await controller.submit(plan); controller.drafts.delete(key); dialog.setBusy(false); dialog.close(); receipt([{ action: plan.normalizedAction, result, name: savedName }]);
      changeRoute({ id: isClient ? result.changedIds[0] : isMcp ? result.changedIds[0] : create ? result.changedIds[0] : item.id, operation: null });
    }
    editor.onsubmit = async event => {
      event.preventDefault(); if (submitting) return; saveDraft(); const values = controller.drafts.get(key); let action;
      messages.clearAll(); duplicateOf = null; setDialogError('');
      const choice = conflictChoice; conflictChoice = null;   // 选择只管这一次提交；失败后要重新选，不沿用上次的
      if (!choice) hideDuplicatePanel();
      const problems = validate(values).filter(problem => !(duplicateAware && problem.duplicate));   // 有对比能力时同 ID 交给后端 409 EXTENSIONS_DUPLICATE_ID，再给对比与选择
      if (problems.length) { hideDuplicatePanel(); problems.forEach(showError); setDialogError(`有 ${problems.length} 处需要修改，已定位到第一处；已填写的内容都保留着。`); messages.focusFirst(); return; }
      await run(async () => {
        if (isClient) action = { type: 'client.save', client: values };
        else if (isMcp) action = { type: 'mcp.save', ...(create ? { create: true } : {}), ...(create && choice ? { onConflict: choice } : {}), ...((item?.clientId || values.clientId) ? { clientId: item?.clientId || values.clientId } : {}), server: { id: values.id, name: values.name, enabled: values.enabled, transport: values.transport, ...(values.transport === 'stdio' ? { command: values.command, args: values.args.split('\n').filter(Boolean), ...(values.cwd ? { cwd: values.cwd } : {}), envRefs: parseRefs(values.envRefs) } : { url: values.url, headerRefs: parseRefs(values.headerRefs) }) } };
        else if (create) action = { type: 'skill.create', ...(values.clientId ? { clientId: values.clientId } : {}), directory: values.directory, content: '---\nname: ' + JSON.stringify(values.directory) + '\ndescription: ' + JSON.stringify(values.description) + '\n---\n\n' + values.body + '\n' };
        else action = { type: 'skill.update', id: item.id, file: item.file, content: values.content };
        lastAction = action; let plan;
        try { plan = await client.prepare(action); }
        catch (error) {
          // 旧版服务不认识 create 字段（400）：上面的同 ID 检查已通过，退回不带 create 的请求；新版服务会返回 409 EXTENSIONS_DUPLICATE_ID。
          if (action.create && error.status === 400 && /扩展动作或字段无效/.test(error.message)) { const { create: ignored, ...legacy } = action; action = legacy; plan = await client.prepare(action); }
          else throw error;
        }
        if (isClient || isMcp && (item?.clientId || values.clientId)) {
          const review = editor.querySelector('[data-client-review]'); review.hidden = false;
          review.innerHTML = `${extensionPlanContent(plan)}<div class="dialog-footer"><button type="button" class="secondary" data-client-back>返回编辑</button><button type="button" class="primary" data-client-confirm data-conflicts="${!!plan.conflicts.length}" ${plan.conflicts.length ? 'disabled' : ''}>${isClient ? '确认保存登记' : '确认保存配置'}</button></div>`;
          editor.querySelector('[type=submit]').hidden = true;
          review.querySelector('[data-client-back]').onclick = () => { clearReview(); editor.elements.name.focus(); };
          review.querySelector('[data-client-confirm]').onclick = () => void run(() => commit(plan));
          review.querySelector(plan.conflicts.length ? '[data-client-back]' : '[data-client-confirm]').focus();
        } else { if (plan.conflicts.length) throw Object.assign(new Error(plan.conflicts.join('；')), create && !isMcp && !isClient ? { field: 'directory' } : {}); await commit(plan); }
      });
    };
  }
  // 读取超过 1 秒才出现「取消」（controller.cancel）：取消后回到读取前的状态（数据与焦点不变），上方出「已取消」横幅带「重试」。
  function renderLoadStrip() {
    const strip = $('[data-load-status]'), show = !!(loadView.loading && loadView.cancellable && state && Date.now() - loadStartedAt >= 1000);
    const markup = show ? '<span role="status">正在读取扩展来源…</span><button type="button" class="text-button" data-cancel-load>取消</button>' : '';
    if (strip.dataset.shown !== String(show)) { strip.dataset.shown = String(show); strip.innerHTML = markup; strip.hidden = !show; }
  }
  function renderCancelled() {
    const slot = $('[data-cancelled-slot]');
    const markup = loadView.cancelled ? bannerMarkup({ tone: 'info', title: '已取消', message: state ? '已停止读取，下面仍是读取前的内容。' : '已停止读取，还没有内容。', attrs: { 'data-cancelled-banner': true }, actions: [{ label: '重试', attrs: { 'data-retry-load': true } }] }) : '';
    if (slot.innerHTML !== markup) slot.innerHTML = markup;
  }
  const unsubscribe = controller.subscribe(value => {
    const wasLoading = !!loadView.loading, wasCancelled = !!loadView.cancelled;
    if (value.loading && !wasLoading) {   // 在刷新按钮被置灰之前记下焦点
      const active = document.activeElement; focusBeforeLoad = active && active !== document.body && element.contains(active) ? active : null;
      loadStartedAt = Date.now(); clearTimeout(loadStripTimer); loadStripTimer = setTimeout(() => { renderLoadStrip(); if (!state && visible) renderList(); }, 1000);
    }
    if (!value.loading) clearTimeout(loadStripTimer);
    loadView = { loading: !!value.loading, cancellable: !!value.cancellable, cancelled: !!value.cancelled };
    state = value.snapshot; readFailure = value.failure; setError(value.failure); setRefreshState($('[data-extension-refresh]'), { loading: value.loading }); renderClientFilter();
    if (state && liveProbes.size) for (const [id, live] of liveProbes) { const server = state.servers.find(item => item.id === id); if (!server || (finishedProbe(live) && server.lastProbe?.id === live.id)) liveProbes.delete(id); }   // 整页刷新带回了同一个检测的最终结果，覆盖层让位
    if (state && !probeAllRun) { const resumed = resumablePlan(state.servers); if (resumed.length) resumeProbeAll(resumed); }   // 刷新 / 重新打开页面后，后端还在排队 / 检测的服务继续显示进度
    if (state && staged.size) { const { staged: kept } = pruneStaged(staged, state); if (kept !== staged) staged = kept; }   // pruneStaged 返回 { staged, dropped }，不是 Map
    renderList(); renderBar(); renderLoadStrip(); renderCancelled();
    if (loadView.cancelled && !wasCancelled && visible) {   // 焦点回到读取前的位置（取消按钮已经消失）
      const active = document.activeElement;
      if ((!active || active === document.body || active === element || !element.contains(active) || active.hasAttribute?.('data-cancel-load')) && focusBeforeLoad?.isConnected && !focusBeforeLoad.disabled) focusBeforeLoad.focus({ preventScroll: true });
    }
    const record = value.submission;
    $('[data-submission]').innerHTML = record && record.status !== 'applied' ? `<div class="extension-receipt"><span>${record.status === 'applied' ? '变更已保存。' : record.status === 'needs_review' ? '需要重新预览：' + esc(record.error) : '提交结果待核对：请使用原请求，避免重复写入。'}</span><div>${record.status === 'submitted' || record.status === 'unknown' ? '<button type="button" class="secondary" data-retry-submission>核对原请求</button>' : '<button type="button" class="text-button" data-clear-submission>关闭提示</button>'}<a class="text-button" href="${extensionsRoute({ tab: route.tab, operation: record.request.requestId })}">查看回执</a></div></div>` : '';
    if (visible) void loadDetail();
  });
  const searchControl = mountSearchField($('.extension-search'));
  // 键盘（design-spec §11）：↑↓/Home/End 在清单里移动（检查器已打开且是并排布局时，选中行跟着走）；Esc 收起检查器并把焦点还给那一行；⌘F 聚焦搜索。
  element.addEventListener('focusin', event => {
    const row = event.target.closest?.('.extension-list .extension-row'), id = row?.querySelector('.extension-row-open')?.dataset.extensionId;
    if (id && id !== rovingId) { rovingId = id; applyRoving(); }
  });
  element.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (event.key === 'Escape') {
      if (!(route.id || route.operation) || $('.extension-detail').hidden || target.closest('dialog, [role="listbox"], [role="menu"]') || target.matches('input, textarea, select') || target.getAttribute('aria-expanded') === 'true') return;
      event.preventDefault(); closeDetail(); return;
    }
    if (!target.matches?.('.extension-row-open')) return;
    const opens = [...$('.extension-list').querySelectorAll('.extension-row-open')], at = opens.indexOf(target);
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: opens.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const next = opens[Math.max(0, Math.min(opens.length - 1, to))]; if (!next || next === target) return;
    const id = next.dataset.extensionId; rovingId = id; applyRoving(); next.focus({ preventScroll: true });   // 先移焦点：renderList 会按当前焦点所在行恢复焦点
    if (route.id && !overlayMode()) changeRoute({ id, operation: null, file: null }, true, { soon: true });
    rowButton(id)?.scrollIntoView({ block: 'nearest' });
  });
  const onFind = event => {
    if (!visible || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'f' || document.querySelector('dialog[open]')) return;
    if (focusVisibleSearchField(document)) event.preventDefault();   // 与原生菜单发出的 daylight-find 共用同一个函数
  };
  document.addEventListener('keydown', onFind);
  $('.extension-search input').addEventListener('input', event => changeRoute({ query: event.target.value }, true));
  $('[data-problems]').addEventListener('change', event => changeRoute({ problems: event.target.checked }));
  element.addEventListener('change', event => {
    if (event.target.matches('#extensions-client-filter')) changeRoute({ client: event.target.value || null });
    else if (event.target.matches('#extension-file-select')) {
      const id = route.id; route.file = event.target.value; detailKey = '';
      void loadDetail().then(() => { if (visible && route.id === id) $('#extension-file-select .select-trigger')?.focus(); });
    }
    else if (event.target.matches('input[data-cli-selection]')) void toggleClientSelection(event.target);
    else if (event.target.matches('[data-binding-toggle], [data-master-toggle], [data-mcp-switch]')) stageToggle(event.target);
  });
  element.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button) return;
    try {
      if (button.dataset.extensionId) {
        const id = button.dataset.extensionId; rovingId = id;
        if (id === route.id && !$('.extension-detail').hidden) focusDetail();   // 已选中的行再按 Return/点击：焦点进检查器（§11）
        else { focusDetailOnRender = overlayMode(); changeRoute({ id, operation: null, file: null }); }
      }
      else if (button.hasAttribute('data-close-detail')) closeDetail();
      else if (button.hasAttribute('data-cancel-load')) controller.cancel();
      else if (button.hasAttribute('data-retry-load') || button.hasAttribute('data-extension-refresh')) await controller.refresh(true);
      else if (button.hasAttribute('data-staging-review')) await reviewStaged();
      else if (button.hasAttribute('data-staging-revert')) revertStaged();
      else if (button.hasAttribute('data-copy-path')) await copyBannerPath(button);
      else if (button.dataset.extensionReveal) await revealInFinder(button);
      else if (button.hasAttribute('data-extension-restore-backup')) await chooseBackup(button);
      else if (button.hasAttribute('data-restore-undo')) await undoOperations(restoreNotice || []);
      else if (button.hasAttribute('data-restore-dismiss')) { restoreNotice = null; renderRestoreNotice(); $('[data-extension-refresh]')?.focus(); }
      else if (button.hasAttribute('data-create') || button.hasAttribute('data-empty-create')) edit(true);
      else if (button.hasAttribute('data-import-json')) openImportJson();
      else if (button.hasAttribute('data-import-skill')) openImportSkill();
      else if (button.hasAttribute('data-clear-filters')) { changeRoute({ query: '', client: null, problems: false }); $('.extension-search input')?.focus(); }
      else if (button.hasAttribute('data-edit')) edit();
      else if (button.hasAttribute('data-cli-selection')) await toggleClientSelection(button);
      else if (button.hasAttribute('data-remove-client')) await preview({ type: 'client.remove', clientId: selected.registrationId || selected.id }, { title: '确认移除 CLI 登记' });
      else if (button.dataset.binding) await preview({ type: 'binding.' + button.dataset.binding, id: button.dataset.skill || selected.id, clientId: button.dataset.client, ...(button.hasAttribute('data-include-existing') ? { includeExisting: true } : {}) });
      else if (button.hasAttribute('data-archive')) await preview({ type: selected.kind === 'skill' ? 'skill.archive' : 'mcp.archive', id: selected.id });
      else if (button.dataset.installMcp) await preview({ type: 'mcp.install', id: selected.id, clientId: button.dataset.installMcp });
      else if (button.hasAttribute('data-mcp-toggle')) await preview({ type: 'mcp.toggle', id: selected.id, enabled: !selected.enabled });
      else if (button.hasAttribute('data-generate')) await preview({ type: 'mcp.generate', clientId: selected.id });
      else if (button.hasAttribute('data-probe')) await preview({ type: 'mcp.probe', id: selected.id });
      else if (button.hasAttribute('data-probe-all')) openProbeAll();
      else if (button.hasAttribute('data-cancel-all-probes')) await cancelProbeAll();
      else if (button.hasAttribute('data-cancel-probe')) await cancelOneProbe(button.dataset.probeId);
      else if (button.hasAttribute('data-conflict-compare')) await openCompare(button);
      else if (button.hasAttribute('data-conflict-adopt')) await resolveConflict(button, 'adoptShared');
      else if (button.hasAttribute('data-conflict-keep')) await resolveConflict(button, 'keepLocal');
      else if (button.hasAttribute('data-conflict-reopen')) await resolveConflict(button, 'reopen');
      else if (button.dataset.restoreOperation) await preview({ type: 'operation.restore', operationId: button.dataset.restoreOperation });
      else if (button.hasAttribute('data-retry-submission')) { button.disabled = true; await controller.retry(); }
      else if (button.hasAttribute('data-clear-submission')) controller.clearSubmission();
      else if (button.hasAttribute('data-discuss')) onDiscuss({ reference: { id: selected.id, kind: selected.kind, version: selected.version, name: selected.name }, returnHash: extensionsRoute(route), prompt: selected.kind === 'skill' ? '请解释这个 Skill 的用途和接入情况。如需修改，先给我审阅草稿。' : '请检查这个扩展的配置和接入情况。实际检测或修改前先给我审阅草稿。' });
    } catch (error) { setError(error); } finally { button.disabled = false; }
  });
  addMenu = mountAddMenu($('[data-create-slot]'));
  renderTabs();
  return { element, controller, updateRoute(value) { if(extensionsRoute(value)===extensionsRoute(route))return;route = { ...value }; detailKey = ''; renderClientFilter(); renderTabs(); renderList(); if (visible) void loadDetail(); }, setVisible(value) { const changed = visible !== value; visible = value; element.hidden = !value; if (!changed) return; controller.setVisible(value); if (!value) { if (!probeAllRun) liveProbes.clear(); probeWatching = null; clearTimeout(probeAllTimer); detailTicket++; clearTimeout(probeTimer); shell?.close(); } else { void loadDetail(); if (probeAllRun) void pollProbeAll(); const record = controller.getSubmission(); if (record?.result?.probeId) watchProbe(record.result.probeId); } }, dispose() { document.removeEventListener('keydown', onFind); clearTimeout(detailTimer); unsubscribe(); controller.dispose(); tabsDispose?.(); shell?.dispose(); clearTimeout(probeTimer); clearTimeout(probeAllTimer); element.remove(); } };
}

// 字段旁错误/警告（0.7 PR-1）：并入本文件以免新增静态资源（新文件需登记 core/web-assets.json，属打包相关）

export function createFieldMessages(form) {
  const text = label => [...label.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('').trim();
  // 消息放进 <label> 后，控件的可访问名称会把它算进去；先固定成纯标签文字。
  for (const control of form.querySelectorAll('label > input, label > textarea')) if (!control.hasAttribute('aria-label')) { const label = text(control.parentElement); if (label) control.setAttribute('aria-label', label); }
  const control = name => form.elements[name] || null;
  const slot = (name, kind) => form.querySelector(`[data-field-${kind}="${CSS.escape(name)}"]`);
  function put(name, kind, message, { action } = {}) {
    const input = control(name), host = input?.closest?.('label') || input?.parentElement; if (!host) return false;
    let node = slot(name, kind);
    if (!message) { node?.remove(); refresh(name); return true; }
    if (!node) { node = document.createElement('small'); node.dataset[kind === 'error' ? 'fieldError' : 'fieldWarning'] = name; node.id = `field-${kind}-${name}`; node.className = kind === 'error' ? 'extension-field-error' : 'extension-field-warning'; host.append(node); }
    node.innerHTML = `<span>${kind === 'error' ? '错误' : '警告'} · ${esc(message)}</span>${action ? `<button type="button" class="text-button" data-field-action="${esc(action.id)}">${esc(action.label)}</button>` : ''}`;
    refresh(name); return true;
  }
  function refresh(name) {
    const input = control(name); if (!input?.setAttribute) return;
    const ids = ['error', 'warning'].map(kind => slot(name, kind)?.id).filter(Boolean);
    if (ids.length) input.setAttribute('aria-describedby', ids.join(' ')); else input.removeAttribute('aria-describedby');
    if (slot(name, 'error')) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
  }
  return {
    error: (name, message, options) => put(name, 'error', message, options),
    warning: (name, message) => put(name, 'warning', message),
    clear: name => { put(name, 'error', ''); },
    clearAll() { form.querySelectorAll('[data-field-error]').forEach(node => put(node.dataset.fieldError, 'error', '')); },
    has: name => !!slot(name, 'error'),
    // 聚焦表单中第一个有错误的控件（按 DOM 顺序）。
    focusFirst() { const first = [...form.querySelectorAll('[data-field-error]')].map(node => control(node.dataset.fieldError)).filter(Boolean).sort((a, b) => a.compareDocumentPosition(b) & 4 ? -1 : 1)[0]; first?.focus?.(); return !!first; },
  };
}
