import { icon } from './components/icons.js';
import { refreshButton, setRefreshState } from './components/section.js';
import { selectField } from './components/select.js';
import { createProxyDrawer } from './components/proxy-drawer.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const apis = [{ value: 'openai-responses', label: 'Responses' }, { value: 'openai-completions', label: 'Chat Completions' }, { value: 'anthropic-messages', label: 'Messages' }];
const sourceTypes = [
  { id: 'all', name: '全部模型', mark: '', tone: '' },
  { id: 'codex', name: 'Codex', mark: 'C', tone: 'codex' },
  { id: 'kimi', name: 'Kimi', mark: 'K', tone: 'kimi' },
  { id: 'grok', name: 'Grok', mark: 'G', tone: 'grok' },
  { id: 'qoder', name: 'Qoder', mark: 'Q', tone: 'codex' },
  { id: 'agy', name: 'AGY', mark: 'A', tone: 'kimi' },
  { id: 'custom', name: '自定义', mark: 'M', tone: 'custom' },
];
const sourceType = model => model.source.startsWith('custom:') ? 'custom' : model.source;
const context = model => model.contextWindow ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(model.contextWindow / 1000) + 'K 上下文' : '上下文未提供';

export function createCLIPage({ getToken }) {
  const root = document.createElement('main');
  root.id = 'cli-page'; root.className = 'cli-page'; root.hidden = true;
  let source = 'all', query = '', onlyPending = false, defaultEnabled = false, defaultModel = '', api = apis[0].value;
  let modelOverrides = {}, overridesDirty = false;
  const levels = ['off','minimal','low','medium','high','xhigh','max'];
  let snapshot, busy = false, refreshing = false, pendingAutomatic, loadedAt = 0, poll;
  root.innerHTML = `
    <header class="topbar"><span>我的工作空间 <span class="slash">/</span> CLI 配置</span><span class="cli-preview-tag">Pi</span></header>
    <div class="workspace cli-workspace">
      <section class="page-heading cli-heading"><div><h1>CLI 配置</h1><p>把 Daylight 的模型接入 Pi</p></div>${refreshButton({ariaLabel:'重新读取代理目录与 Pi 配置',attrs:{'data-refresh':true,title:'重新读取代理目录与 Pi 配置'}})}</section>
      <section class="cli-client" aria-label="Pi 接入信息">
        <div class="cli-client-identity"><span class="cli-pi-mark" aria-hidden="true">π</span><div><h2>Pi <span class="cli-version" data-pi-version>正在检测</span></h2><span class="cli-subtext" data-pi-path>~/.pi/agent/models.json</span></div></div>
        <div class="cli-client-default"><span class="cli-caption">默认模型</span><strong data-current-default>正在读取</strong></div>
        <div class="cli-client-count"><span class="cli-caption">已接入</span><strong data-imported-count>—</strong><span class="cli-subtext" data-obsolete-count></span></div>
        <button type="button" class="cli-history icon-button" data-restore title="恢复上次接入" aria-label="恢复上次接入" disabled>${icon('undo')}</button>
      </section>
      <div class="cli-connection"><span class="cli-connection-label"><span class="cli-online-dot" data-service-dot></span><span data-service-state>Daylight 代理</span></span><code data-base-url>正在读取</code><button type="button" class="cli-auto-setting" role="switch" aria-label="自动同步" aria-checked="false" data-automatic><span class="cli-auto-track" aria-hidden="true"><span></span></span><span>自动同步</span></button><div class="cli-api-picker">${selectField({ id: 'cli-api', label: 'Pi 接口', options: apis, value: api, compact: true })}</div><button type="button" class="text-button" data-view="proxy">查看反向代理 ${icon('arrow')}</button></div>
      <section class="cli-catalog" aria-label="接入模型">
        <div class="cli-catalog-heading"><div><h2>接入模型</h2><span data-catalog-count></span></div><div class="cli-tools"><label class="cli-search">${icon('search')}<input type="search" placeholder="搜索模型或 ID" aria-label="搜索模型或 ID"><button type="button" data-clear-search title="清空搜索" aria-label="清空搜索" hidden>${icon('close')}</button></label><label class="cli-pending-filter"><input type="checkbox" data-pending>待接入</label></div></div>
        <div class="cli-model-browser"><nav class="cli-source-nav" aria-label="模型来源"></nav><div class="cli-model-list"><div class="cli-table-head"><span>模型</span><span>状态</span><span></span></div><div data-models></div></div></div>
      </section>
      <div class="cli-apply-bar"><div class="cli-apply-left"><div class="cli-selection"><strong data-selection-count>同步全部中转模型</strong><span data-selection-note>正在读取目录</span></div><div class="cli-default-setting"><label><input type="checkbox" data-default>同时设为 Pi 默认模型</label><div data-default-picker hidden></div></div></div><div class="cli-apply-actions"><button type="button" class="secondary" data-preview disabled>${icon('copy')}查看变更</button><button type="button" class="primary" data-apply disabled>${icon('refresh')}一键同步 Pi</button></div></div>
      <p class="cli-feedback" data-feedback role="status" aria-live="polite">正在读取 Pi 配置与代理模型…</p>
    </div>`;
  const drawer = createProxyDrawer(root), rows = root.querySelector('[data-models]'), sourceNav = root.querySelector('.cli-source-nav');
  const picker = root.querySelector('[data-default-picker]');
  const catalog = () => snapshot?.models || [];
  const filtered = () => catalog().filter(m => (source === 'all' || sourceType(m) === source) && (!onlyPending || m.state !== 'connected') && `${m.name} ${m.id} ${m.sourceName}`.toLowerCase().includes(query.toLowerCase()));
  const feedback = (message, error = false) => { const node = root.querySelector('[data-feedback]'); node.textContent = message; node.classList.toggle('is-error', error); };
  async function request(operation, body) {
    const response = await fetch('/api/cli/pi/' + operation + (body === undefined ? '?' + (loadedAt ? 'api=' + encodeURIComponent(api) : '') : ''), {
      method: body === undefined ? 'GET' : 'POST', headers: { 'x-workbench-token': getToken(), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error || 'Pi 配置操作失败'), { status: response.status });
    return value;
  }
  function renderActions() {
    const chosen = catalog(), added = chosen.filter(m => m.state === 'new').length;
    const blocked = !snapshot || snapshot.pending || snapshot.catalogError || chosen.some(m => m.unavailableReason);
    root.querySelector('[data-selection-count]').textContent = `同步全部 ${chosen.length} 个模型`;
    root.querySelector('[data-selection-note]').textContent = snapshot ? `新增 ${added} 项 · 更新 ${chosen.filter(m => m.state === 'update').length} 项 · 移除 ${snapshot.obsolete.length} 项` : '正在读取目录';
    root.querySelector('[data-preview]').disabled = busy || !!blocked;
    root.querySelector('[data-apply]').disabled = busy || !!blocked;
    root.querySelector('[data-restore]').disabled = busy || !snapshot?.pi.canRestore;
    root.querySelector('[data-refresh]').disabled = busy;
    root.querySelector('#cli-api').disabled = busy;
    root.querySelector('[data-automatic]').disabled = busy || !snapshot || !snapshot.automatic.enabled && !!blocked;
    root.querySelector('[data-automatic]').setAttribute('aria-checked', String(pendingAutomatic ?? !!snapshot?.automatic.enabled));
    root.querySelector('[data-automatic]').setAttribute('aria-busy', String(pendingAutomatic !== undefined));
    root.querySelector('[data-default]').disabled = busy || !chosen.length;
    root.querySelector('[data-apply]').innerHTML = `${icon('refresh')}${busy ? '处理中…' : '一键同步 Pi'}`;
    picker.hidden = !defaultEnabled;
    if (defaultEnabled) {
      if (!chosen.some(m => m.id === defaultModel)) defaultModel = chosen[0]?.id || '';
      picker.innerHTML = selectField({ id: 'cli-default-model', label: '默认模型', hideLabel: true, compact: true, disabled: busy, options: chosen.map(m => ({ value: m.id, label: m.name })), value: defaultModel });
    }
  }
  function render() {
    const focused = document.activeElement, focusSource = focused?.dataset?.source;
    const sources = sourceTypes.filter(s => s.id === 'all' || catalog().some(m => sourceType(m) === s.id));
    if (!sources.some(s => s.id === source)) source = 'all';
    sourceNav.innerHTML = sources.map(s => `<button type="button" class="cli-source ${source === s.id ? 'selected' : ''}" data-source="${s.id}" aria-pressed="${source === s.id}">${s.mark ? `<span class="cli-source-mark ${s.tone}">${s.mark}</span>` : icon('grid')}<span>${s.name}</span><small>${catalog().filter(m => s.id === 'all' || sourceType(m) === s.id).length}</small></button>`).join('');
    const visible = filtered();
    root.querySelector('[data-catalog-count]').textContent = `${visible.length} / ${catalog().length} 个模型`;
    root.querySelector('[data-imported-count]').textContent = snapshot ? `${snapshot.pi.importedCount} 个模型` : '—';
    root.querySelector('[data-obsolete-count]').textContent = snapshot?.obsolete.length ? `待移除 ${snapshot.obsolete.length} 个` : '';
    const current = snapshot?.pi.defaultModel;
    root.querySelector('[data-current-default]').textContent = current ? (snapshot.pi.defaultProvider === 'daylight' ? catalog().find(m => m.id === current)?.name || current : `${snapshot.pi.defaultProvider} / ${current}`) : '未设置';
    root.querySelector('[data-clear-search]').hidden = !query;
    if (snapshot) {
      root.querySelector('[data-pi-version]').textContent = snapshot.pi.installed ? snapshot.pi.version : '未检测到 Pi';
      root.querySelector('[data-pi-path]').textContent = snapshot.pi.modelsPath;
      root.querySelector('[data-base-url]').textContent = snapshot.service.baseUrl;
      root.querySelector('[data-service-state]').textContent = snapshot.service.state === 'running' ? 'Daylight 代理 · 运行中' : 'Daylight 代理 · 已停止';
      root.querySelector('[data-service-dot]').classList.toggle('is-offline', snapshot.service.state !== 'running');
    }
    rows.innerHTML = visible.length ? visible.map(m => {
      const tone = sourceTypes.find(s => s.id === sourceType(m))?.tone || 'custom';
      return `<div class="cli-model-row"><div class="cli-model-choice"><span class="cli-model-text"><strong>${esc(m.name)}</strong><span>${esc(m.id)}</span><small><span class="cli-source-dot ${tone}"></span>${esc(m.sourceName)}<span class="cli-meta-separator">·</span>${context({...m,contextWindow:m.configuration.contextWindow})}<span class="cli-meta-separator">·</span>${m.configuration.maxTokens ? Number(m.configuration.maxTokens).toLocaleString()+' 最大输出' : '最大输出未提供'}${Object.keys(modelOverrides[m.id] || {}).length ? '<span class="cli-meta-separator">·</span>个性化配置' : ''}</small>${m.unavailableReason ? `<small class="cli-incompatible">${esc(m.unavailableReason)}</small>` : ''}</span></div><span class="cli-model-state ui-first-line-slot ${m.state}">${!m.unavailableReason && m.state === 'connected' ? icon('check') : ''}${m.unavailableReason ? '不兼容' : { connected: '已接入', update: '需要更新', new: '未接入' }[m.state]}</span><div class="ui-first-line-slot"><button type="button" class="icon-button" data-model-config="${esc(m.id)}" title="配置 ${esc(m.name)}" aria-label="配置 ${esc(m.name)}">${icon('gear')}</button></div></div>`;
    }).join('') : `<div class="cli-empty">${icon('search')}<strong>${!snapshot ? '模型目录尚未加载' : catalog().length ? '没有匹配的模型' : '暂无已启用的代理模型'}</strong><button type="button" class="text-button" ${catalog().length ? 'data-reset' : 'data-view="proxy"'}>${catalog().length ? '清除筛选' : '查看反向代理'}</button></div>`;
    renderActions();
    if (focusSource) sourceNav.querySelector(`[data-source="${focusSource}"]`)?.focus({ preventScroll: true });
  }
  function adoptOverrides() { if (!overridesDirty) modelOverrides = Object.fromEntries(catalog().map(m=>[m.id,m.overrides || {}])); }
  async function load() {
    snapshot = await request('state'); loadedAt = Date.now();
    adoptOverrides(); api = snapshot.api; root.querySelector('#cli-api').value = api;
    render();
  }
  async function refreshBackground() {
    if (busy || refreshing) return;
    refreshing = true;
    const previousLoad = loadedAt;
    try {
      const next = await request('state');
      if (busy || root.hidden || loadedAt !== previousLoad || JSON.stringify(next) === JSON.stringify(snapshot)) return;
      snapshot = next; adoptOverrides(); loadedAt = Date.now(); api = next.api;
      root.querySelector('#cli-api').value = api;
      render(); showStatus(snapshot.automatic.enabled ? '自动同步已开启。' : '配置已读取。');
    } catch (error) { if (!busy && !root.hidden) feedback(error.message, true); }
    finally { refreshing = false; }
  }
  function input() { return { api, modelOverrides: Object.fromEntries(Object.entries(modelOverrides).filter(([id])=>catalog().some(m=>m.id===id))), ...(defaultEnabled && catalog().some(m => m.id === defaultModel) ? { defaultModel } : {}) }; }
  function configureModel(id) {
    const model = catalog().find(m=>m.id===id); if (!model) return;
    const c = {...model.configuration, ...modelOverrides[id]}, mapping = {...model.configuration.thinkingLevelMap, ...modelOverrides[id]?.thinkingLevelMap};
    const efforts = [...new Set([...(model.reasoningEfforts?.length ? model.reasoningEfforts : ['none',...levels.filter(l=>l!=='off')]), ...Object.values(mapping).filter(v=>typeof v==='string')])];
    drawer.open(`<form class="proxy-drawer-form cli-model-form"><div class="dialog-header proxy-drawer-header"><div><h2 id="cli-model-config-title">${esc(model.name)}</h2><p class="cli-subtext">Pi 模型个性化配置</p></div><button type="button" data-close aria-label="关闭模型配置">${icon('close')}</button></div><div class="form-body proxy-drawer-body"><p class="cli-subtext">上游声明：上下文 ${model.contextWindow ? Number(model.contextWindow).toLocaleString() : "未提供"} · 最大输出 ${model.maxOutputTokens ? Number(model.maxOutputTokens).toLocaleString() : "未提供"} · 思考档位 ${model.reasoningEfforts?.length ? esc(model.reasoningEfforts.join(" / ")) : "未提供，可自行配置"}</p><div class="cli-config-tokens"><label>上下文长度<input name="contextWindow" type="number" min="1" step="1" value="${c.contextWindow || ''}" placeholder="上游未提供；Pi 默认 128000"></label><label>最大输出 Token 数<input name="maxTokens" type="number" min="1" step="1" value="${c.maxTokens || ''}" placeholder="上游未提供；Pi 默认 16384"></label></div><div class="cli-config-capabilities"><label><input name="reasoning" type="checkbox" ${c.reasoning ? 'checked' : ''}>支持扩展思考</label><label><input name="image" type="checkbox" ${c.input?.includes('image') ? 'checked' : ''}>支持图片输入</label></div><h3>思考档位</h3><div class="cli-thinking-levels">${levels.map(level=>selectField({name:'thinking-'+level,label:level==='off'?'关闭':level,value:mapping[level]===null?'unsupported':mapping[level]===undefined?'default':'value:'+mapping[level],options:[{value:'default',label:'跟随目录 / Pi 默认'},{value:'unsupported',label:'不支持此档位'},...efforts.map(e=>({value:'value:'+e,label:e}))]})).join('')}</div><p class="cli-subtext">映射值发送给上游；不支持的档位在 Pi 中隐藏。填写 Token 参数不会扩大模型真实能力。保存后持久保留；一键同步写入 Pi，已开启的自动同步也会使用这些配置。</p><p class="cli-feedback is-error" data-config-error role="alert"></p></div><div class="dialog-footer proxy-drawer-footer"><button type="button" class="secondary" data-config-reset>恢复跟随目录</button><button type="submit" class="primary">保存配置</button></div></form>`,{titleId:'cli-model-config-title'});
    const form = drawer.element.querySelector('form');
    async function persist(next) {
      const updated={...modelOverrides,[id]:next};
      const submit=form.querySelector('[type="submit"]');submit.disabled=true;drawer.setBusy(true);
      try { await request('configuration',{api,expectedVersion:snapshot.version,modelOverrides:Object.fromEntries(Object.entries(updated).filter(([key])=>catalog().some(m=>m.id===key)))}); modelOverrides=updated;overridesDirty=false; await load(); drawer.close();feedback('个性化配置已保存，后续一键同步和自动同步将使用这些设置。'); }
      catch(error){form.querySelector('[data-config-error]').textContent=error.message;}
      finally{submit.disabled=false;drawer.setBusy(false);}
    }
    form.querySelector('[data-config-reset]').onclick=()=>void persist({});
    form.onsubmit=event=>{
      event.preventDefault(); const data = new FormData(form), next = {};
      for(const key of ['contextWindow','maxTokens']) { const v=data.get(key); if(v) { if(!Number.isSafeInteger(Number(v))||Number(v)<1){form.querySelector('[data-config-error]').textContent='Token 参数需为正整数';return;} next[key]=Number(v); } }
      next.reasoning=data.has('reasoning'); next.input=data.has('image')?['text','image']:['text'];
      const map={}; for(const level of levels){const value=data.get('thinking-'+level);if(value==='unsupported')map[level]=null;else if(value.startsWith('value:'))map[level]=value.slice(6);}
      if(Object.keys(map).length)next.thinkingLevelMap=map;
      void persist(next);
    };
  }
  async function showPreview() {
    const plan = await request('prepare', input()), label = apis.find(a => a.value === plan.api).label;
    drawer.open(`<div class="proxy-drawer-form"><div class="dialog-header proxy-drawer-header"><div><h2 id="cli-preview-title">同步变更</h2><p class="cli-subtext">Pi · ${label}</p></div><button type="button" data-close aria-label="关闭同步变更" title="关闭">${icon('close')}</button></div><div class="form-body proxy-drawer-body cli-diff-body"><div class="cli-diff-file">${icon('folder')}<span>${esc(snapshot.pi.modelsPath)}</span></div><div class="cli-diff-summary">${plan.changes.map(m => `<div><span class="cli-diff-symbol">${{ new: '+', removed: '-', connected: '=', update: '~' }[m.state]}</span><strong>${esc(m.name)}</strong><span>${{ new: '新增', removed: '移除', connected: '保持', update: '更新' }[m.state]}</span></div>`).join('')}</div><pre>${esc(JSON.stringify(plan.config, null, 2))}</pre>${plan.settings ? `<div class="cli-diff-file">${icon('folder')}<span>settings.json</span></div><pre>${esc(JSON.stringify(plan.settings, null, 2))}</pre>` : ''}<p class="cli-subtext">全量替换 Daylight 模型 · 其他 providers 保留 · 自动备份 · Key 已隐藏</p></div><div class="dialog-footer proxy-drawer-footer"><button type="button" class="secondary" data-diff-close>关闭</button></div></div>`, { titleId: 'cli-preview-title' });
    drawer.element.querySelector('[data-diff-close]').onclick = () => drawer.close();
  }
  async function operate(action) {
    if (busy) return;
    busy = true; renderActions();
    try { await action(); }
    catch (error) {
      if (error.status === 409) {
        try { await load(); } catch {}
        feedback(error.message + '；已尝试刷新，请再次操作。', true);
      } else feedback(error.message, true);
    }
    finally { busy = false; pendingAutomatic = undefined; renderActions(); }
  }
  root.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target || busy) return;
    if (target.dataset.modelConfig) configureModel(target.dataset.modelConfig);
    if (target.dataset.source) { source = target.dataset.source; render(); }
    if (target.hasAttribute('data-automatic')) {
      const enabled = !snapshot.automatic.enabled, operation = { ...input(), enabled, expectedVersion: snapshot.version, requestId: crypto.randomUUID() };
      pendingAutomatic = enabled;
      feedback(enabled ? '正在开启自动同步…' : '正在关闭自动同步…');
      void operate(async () => { const result = await request('automatic', operation); await load(); feedback(result.message); });
    }
    if (target.hasAttribute('data-preview')) void operate(showPreview);
    if (target.hasAttribute('data-apply')) void operate(async () => {
      const result = await request('apply', { ...input(), expectedVersion: snapshot.version, requestId: crypto.randomUUID() });
      overridesDirty = false; defaultEnabled = false; root.querySelector('[data-default]').checked = false;
      await load(); feedback(result.message + (snapshot.service.state === 'running' ? '' : '代理尚未启动。'));
    });
    if (target.hasAttribute('data-restore')) void operate(async () => { const result = await request('restore', {}); await load(); feedback(result.message); });
    if (target.hasAttribute('data-refresh')) void operate(async () => {
      setRefreshState(target, {loading:true});
      try { await load(); showStatus('已重新读取 Pi 配置与反向代理目录；未强制刷新上游。'); }
      finally { setRefreshState(target); }
    });
    if (target.hasAttribute('data-view')) location.hash = target.dataset.view;
    if (target.hasAttribute('data-clear-search') || target.hasAttribute('data-reset')) {
      query = ''; root.querySelector('input[type=search]').value = '';
      if (target.hasAttribute('data-reset')) { source = 'all'; onlyPending = false; root.querySelector('[data-pending]').checked = false; }
      render(); root.querySelector('input[type=search]').focus();
    }
  });
  root.addEventListener('change', event => {
    const target = event.target;
    if (target.hasAttribute('data-pending')) { onlyPending = target.checked; render(); }
    if (target.hasAttribute('data-default')) { defaultEnabled = target.checked; renderActions(); }
    if (target.id === 'cli-default-model') defaultModel = target.value;
    if (target.id === 'cli-api') { api = target.value; snapshot = undefined; void operate(async () => { await load(); feedback('Pi 接口已选择：' + apis.find(a => a.value === api).label + '。配置未写入。'); }); }
  });
  root.querySelector('input[type=search]').oninput = event => { query = event.target.value; render(); };
  function showStatus(message = '配置已读取。') {
    const error = snapshot.catalogError || snapshot.automatic.error || (snapshot.pending ? '上次写入中断，请恢复上次接入。' : '') || catalog().find(m => m.unavailableReason)?.unavailableReason;
    feedback(error || message, !!error);
  }
  render();
  return { element: root, setVisible(value) {
    const opening = root.hidden && value; root.hidden = !value;
    clearInterval(poll);
    if (!value) { drawer.close(); root.querySelectorAll('workbench-select').forEach(select => select.setOpen(false)); }
    else {
      if (opening && Date.now() - loadedAt > 5000) void operate(async () => { await load(); showStatus(snapshot.service.state === 'running' ? '配置已读取。' : '代理已停止；同步后需启动代理才能调用。'); });
      poll = setInterval(() => {
        if (!busy && !drawer.element.open && !defaultEnabled && !root.contains(document.activeElement)) void refreshBackground();
      }, 15000);
    }
  } };
}
