import { createDiagnostics } from './components/proxy-diagnostics.js';
import { modelGroups, proxyPage } from './components/proxy-page.js';
import {createCustomPage} from './custom-proxy.js';
import { renderAgyQuota } from './components/agy-quota.js';
import { selectField } from './components/select.js';

function createProviderPage({ getToken, source, common = false, getExampleModel }) {
  const isAgy = source === 'agy', isGrok = source === 'grok', isCodex = source === 'codex', isLocal = isAgy || isGrok || isCodex;
  const localName = isCodex ? 'Codex' : isGrok ? 'Grok' : 'AGY';
  const root = document.createElement('section');
  root.id = `proxy-panel-${source}`; root.className = 'proxy-provider-page'; root.hidden = true;
  root.setAttribute('role', 'tabpanel'); root.setAttribute('aria-labelledby', `proxy-tab-${source}`);
  root.innerHTML = proxyPage;
  root.querySelector('.topbar').remove(); root.querySelector('.page-heading').remove();
  root.querySelector('.proxy-account .proxy-caption').textContent = isLocal ? `${localName} 登录` : 'Qoder 账号';
  root.querySelector('.proxy-account').closest('section').setAttribute('aria-label', isLocal ? `${localName} 账号` : 'Qoder 账号');
  const nodes = new Map([...root.querySelectorAll('[id]')].map(node => [node.id, node]));
  const $ = id => nodes.get(id);
  const sourceNote = document.createElement('p'); sourceNote.className = 'proxy-hint proxy-source-note'; sourceNote.setAttribute('role', 'status');
  root.querySelector('.proxy-account').after(sourceNote);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  $('protocol-control').innerHTML = selectField({ id: 'protocol', name: 'protocol', label: '客户端协议', value: isCodex ? 'responses' : 'chat', compact: true, hideLabel: true, options: [{ value: 'chat', label: 'Chat Completions' }, { value: 'responses', label: 'Responses' }, { value: 'messages', label: 'Anthropic Messages' }] });
  nodes.set('protocol', root.querySelector('#protocol'));
  $('connection-result').textContent = '所有来源共用此地址、API Key 和代理开关。';
  let status, visible = false, refreshing = false, working = false, checking = false, loginPolling = false, apiKey = '', models = [], settingsDirty = false, modelLoading = false;
  let creditsOwner = '', creditsVersion = 0, creditsLoading = false, creditsCheckedAt = 0, creditsUpdatedAt = '';
  let savingSettings = false, savingNode = false;
  const names = { stopped: '已停止', starting: '启动中…', running: '运行中', stopping: '停止中…' };
  async function api(path, body) {
    const provider = isLocal && (path.startsWith('models') || path === 'quota' || path === 'auth/refresh') ? (isCodex ? 'codex-proxy' : source) : 'qoder';
    const response = await fetch(`/api/${provider}/${path === 'auth/refresh' ? 'status?refresh=1' : path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-workbench-token': getToken(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(65_000) });
    let result;
    try { result = await response.json(); } catch { throw new Error('代理服务暂时无法连接，请稍后重试'); }
    if (!response.ok) throw new Error(result.error || '操作失败，请重试');
    return result;
  }
  const sourceError = document.createElement('p'); sourceError.className = 'proxy-error'; sourceError.hidden = true; sourceError.setAttribute('role', 'alert'); sourceNote.after(sourceError);
  function error(message = '') { const target = common ? $('service-error') : sourceError; target.textContent = message; target.hidden = !message; }
  function paint() {
    if (!status) return;
    const running = status.state === 'running', transition = working || ['starting', 'stopping'].includes(status.state), unavailable = !!status.runtimeError;
    const settingsLocked = running || transition;
    if (common) {
      $('service-state').textContent = working ? (running ? '停止中…' : '启动中…') : unavailable ? '运行环境待设置' : names[status.state] || '正在准备…';
      $('service-dot').classList.toggle('running', running);
      $('service-switch').setAttribute('aria-checked', String(running));
      $('service-switch').setAttribute('aria-label', running ? '停止代理' : '开启代理');
      $('service-switch').setAttribute('aria-busy', String(transition));
      $('service-switch').disabled = transition || unavailable || checking;
      $('service-note').textContent = unavailable ? '在下方设置中选择 Node 22 或更新版本。' : running ? `${status.activeRequests} 个请求进行中 · 所有来源共用此开关` : '统一代理 · 至少一个来源可用即可开启';
    }
    $('account-name').textContent = status.account ? [status.account.organization, status.account.uid].filter(Boolean).join(' · ') : '尚未登录';
    if (isLocal) $('account-name').textContent = status.sources?.[source]?.error || (status.sources?.[source]?.connected ? `已连接本机 ${localName}` : `尚未连接 · 请在终端运行 ${isCodex ? 'codex login' : isGrok ? 'grok login --oauth' : 'agy'} 登录后刷新`);
    const owner = isLocal ? (status.sources?.[source]?.connected ? source : '') : status.account ? [status.account.uid, status.account.organization].join(':') : '';
    if (owner !== creditsOwner) {
      creditsOwner = owner; creditsVersion++; creditsLoading = false; creditsCheckedAt = 0; creditsUpdatedAt = ''; $('usage-trend').replaceChildren();
      $('usage-list').replaceChildren(); $('usage-list').setAttribute('aria-busy', 'false'); $('usage-note').hidden = true;
      $('usage-summary').textContent = owner ? '' : isLocal ? '刷新登录后可查看额度状态。' : '登录 Qoder 后可查看 Credits 用量。';
      $('refresh-usage').disabled = !owner; $('refresh-usage').textContent = '刷新';
      if (visible && owner && !isCodex && $('usage-details').open) void loadUsage();
    }
    $('account-action').textContent = isLocal ? '刷新登录' : status.account ? '退出账号' : '登录 Qoder';
    $('account-action').hidden = !isLocal && settingsLocked;
    $('account-action').disabled = (!isLocal && running) || transition || unavailable;
    if (common) {
      $('base-url').value = $('protocol').value === 'messages' ? status.baseUrl?.replace(/\/v1$/, '') || '' : status.baseUrl || '';
      $('copy-url').disabled = !$('base-url').value;
      $('test-connection').disabled = !running || transition || checking;
      $('copy-example').disabled = !apiKey || unavailable;
      $('settings-edit').hidden = settingsLocked;
      $('settings-readonly').hidden = !settingsLocked;
      $('settings-readonly').textContent = `本机端口 ${status.port} · ${status.autoStart ? '随 Daylight 自动启动' : '手动启动'}`;
      $('settings-actions').hidden = settingsLocked;
      $('settings-result').hidden = settingsLocked;
      $('save-settings').disabled = running || transition || unavailable || savingSettings;
      $('proxy-port').disabled = running || transition;
      $('auto-start').disabled = running || transition;
      $('rotate-key').disabled = running || transition || unavailable;
      if (!settingsDirty) { $('proxy-port').value = status.port || 4319; $('auto-start').checked = !!status.autoStart; }
      $('node-info').textContent = status.runtimeError || `${status.node?.version || ''} · ${status.node?.path || ''}`;
      $('node-setting').hidden = !status.native || settingsLocked;
      $('save-node').disabled = running || transition || savingNode;
      $('node-path').disabled = running || transition;
    }
    $('login-panel').hidden = isLocal || !status.login;
    if (status.login) $('login-link').href = status.login.url;
    if (common && (status.runtimeError || status.lastError)) error(status.runtimeError || status.lastError);
    if (common && status.conflicts?.length) error(`模型名称冲突：${status.conflicts.join('、')}。请停用其中一个来源的同名模型。`);
  }
  async function refresh() {
    if (!getToken() || document.hidden || refreshing) return;
    refreshing = true;
    try { status = await api('status'); paint(); if (!apiKey && !status.runtimeError) await loadKey(); if (visible && !isCodex && $('usage-details').open && (isLocal ? status.sources?.[source]?.connected : status.account) && Date.now() - creditsCheckedAt >= 60000) void loadUsage(); }
    catch (e) { error(e.message); $('service-switch').disabled = true; }
    finally { refreshing = false; }
    return status;
  }
  async function loadKey() {
    apiKey = (await api('key')).apiKey;
    $('api-key').value = apiKey; $('show-key').disabled = false; $('copy-key').disabled = false; paint();
  }
  async function copy(button, value) {
    try {
      await navigator.clipboard.writeText(value); const label = button.textContent; button.textContent = '已复制'; button.disabled = true;
      setTimeout(() => { button.textContent = label; button.disabled = false; }, 1600);
    } catch { error('复制未完成，请选中输入框内容后手动复制。'); }
  }
  function confirmAction(title, message, label) {
    return new Promise(resolve => {
      const dialog = $('proxy-confirm'); $('confirm-title').textContent = title; $('confirm-message').textContent = message; $('confirm-ok').textContent = label;
      const finish = value => { dialog.close(); resolve(value); };
      $('confirm-cancel').onclick = () => finish(false); $('confirm-ok').onclick = () => finish(true);
      dialog.oncancel = event => { event.preventDefault(); finish(false); };
      dialog.showModal(); $('confirm-cancel').focus();
    });
  }
  if (common) {
    $('service-switch').onclick = async () => {
      if (working || !status) return;
      error();
      const enabled = status.state !== 'running'; let force = false;
      if (!enabled && status.activeRequests) {
        force = await confirmAction('停止代理？', `当前有 ${status.activeRequests} 个请求正在进行，停止会中断这些请求。`, '停止代理');
        if (!force) return;
      }
      working = true; paint();
      try { status = await api('service', { enabled, force }); error(); }
      catch (e) { error(e.message); }
      finally { working = false; await refresh(); paint(); }
    };
  }
  $('account-action').onclick = async () => {
    $('account-action').disabled = true; error();
    try {
      if (isLocal) { const result = await api('auth/refresh'); await refresh(); if (!result.connected) error(result.error); else if ($('models-details').open) await loadModels(); return; }
      if (status.account) {
        if (!await confirmAction('退出 Qoder？', '本机保存的 Qoder 登录凭证将被删除。重新登录后可继续使用代理。', '退出账号')) return;
        status = await api('auth/logout', {}); models = []; $('models-list').replaceChildren();
      } else {
        const login = await api('auth/device', {}); status.login = login;
        // Explicit link works both in browsers and the native app, without popup races.
        $('login-note').textContent = '点击下方链接，在浏览器中完成授权，此页会自动更新。';
      }
      paint(); if (status.login) $('login-link').focus();
    } catch (e) { error(e.message); } finally { paint(); }
  };
  $('login-cancel').onclick = async () => { try { await api('auth/cancel', {}); status.login = null; paint(); } catch (e) { error(e.message); } };
  async function pollLogin() {
    if (isLocal || !status?.login || loginPolling || document.hidden) return;
    loginPolling = true;
    try {
      if (Date.now() > status.login.expiresAt) { await api('auth/cancel', {}); status.login = null; error('登录链接已过期，请重新登录。'); paint(); return; }
      const result = await api('auth/poll', {});
      if (result.authorized) { await refresh(); if ($('models-details').open) await loadModels(); }
    } catch (e) { $('login-note').textContent = `${e.message}。可重试登录。`; }
    finally { loginPolling = false; }
  }
  if (common) {
    $('protocol').onchange = paint;
    $('copy-url').onclick = () => copy($('copy-url'), $('base-url').value);
    $('copy-key').onclick = () => copy($('copy-key'), apiKey);
    $('show-key').onclick = () => { const visible = $('api-key').type === 'password'; $('api-key').type = visible ? 'text' : 'password'; $('show-key').textContent = visible ? '隐藏' : '显示'; };
    $('copy-example').onclick = () => {
      const protocol = $('protocol').value, model = getExampleModel() || '替换为模型 ID';
      const body = protocol === 'responses' ? { model, input: '你好', stream: true } : { model, messages: [{ role: 'user', content: '你好' }], ...(protocol === 'messages' ? { max_tokens: 1024 } : {}), stream: true };
      const route = protocol === 'chat' ? '/chat/completions' : protocol === 'responses' ? '/responses' : '/messages';
      const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
      copy($('copy-example'), `curl -N ${quote(status.baseUrl + route)} \\\n  -H ${quote(`Authorization: Bearer ${apiKey}`)} \\\n  -H 'Content-Type: application/json' \\\n  -d ${quote(JSON.stringify(body))}`);
    };
    $('test-connection').onclick = async () => {
      checking = true; paint(); $('test-connection').textContent = '测试中…'; $('connection-result').textContent = '正在验证本机接口、鉴权与模型目录…';
      try { $('connection-result').textContent = (await api('test', {})).message; } catch (e) { $('connection-result').textContent = e.message; }
      finally { checking = false; $('test-connection').textContent = '测试连接'; paint(); }
    };
    $('settings-form').oninput = () => { settingsDirty = true; };
    $('settings-form').onsubmit = async event => {
      event.preventDefault(); if (savingSettings) return; savingSettings = true; $('save-settings').textContent = '保存中…'; paint();
      try { status = await api('settings', { port: Number($('proxy-port').value), autoStart: $('auto-start').checked }); settingsDirty = false; $('settings-result').textContent = '设置已保存'; error(); }
      catch (e) { $('settings-result').textContent = e.message; } finally { savingSettings = false; $('save-settings').textContent = '保存设置'; paint(); }
    };
    $('save-node').onclick = async () => {
      if (savingNode) return; savingNode = true; $('save-node').disabled = true; $('node-info').textContent = '正在检测 Node…';
      try { await api('runtime', { nodePath: $('node-path').value.trim() }); await refresh(); error(); }
      catch (e) { error(e.message); } finally { savingNode = false; paint(); }
    };
    $('rotate-key').onclick = async () => {
      if (!await confirmAction('更换 API Key？', '现有客户端中的旧密钥将立即失效，需要重新复制配置。', '更换密钥')) return;
      try { await api('key/rotate', {}); await loadKey(); $('settings-result').textContent = '密钥已更换，请更新客户端配置'; } catch (e) { error(e.message); }
    };
  }
  function paintModels() {
    const field = (m, name, label, value, options) => `<div class="proxy-model-field" data-model="${esc(m.id)}" data-field="${name}">${selectField({ name, label, value, options, compact: true })}</div>`;
    const open=$('models-list').querySelector('.proxy-disabled-models')?.open||false;
    $('models-list').innerHTML = modelGroups(models,m => `<div class="proxy-model"><div class="proxy-model-heading"><div>${esc(m.displayName || m.id)}<small>${esc(m.id)}</small></div><label class="proxy-checkbox"><input type="checkbox" data-model="${esc(m.id)}" data-field="enabled" ${m.enabled ? 'checked' : ''} aria-label="启用 ${esc(m.id)}">启用</label></div>${isGrok || isCodex ? `<p class="proxy-hint">CLI 上下文 ${m.contextWindow ? Number(m.contextWindow).toLocaleString() : '未提供'} · 最大输出 ${m.maxOutputTokens ? Number(m.maxOutputTokens).toLocaleString() : 'CLI 未声明'} · 中转默认不限制输出</p>` : ''}<div class="proxy-model-options">${m.contextWindows.length ? field(m, 'context', '默认上下文', m.contextWindows.find(w => w.isDefault)?.length, m.contextWindows.map(w => ({ value: w.length, label: Number(w.length).toLocaleString() }))) : ''}${m.reasoningEfforts.length ? field(m, 'effort', '默认推理强度', m.effort || 'auto', [{ value: 'auto', label: '自动' }, ...m.reasoningEfforts.map(level => ({ value: level, label: level }))]) : ''}${isGrok ? `<label class="proxy-model-budget">默认输出预算（可选）<input type="number" min="1" step="1" placeholder="不额外限制" value="${m.defaultMaxTokens || ''}" data-model="${esc(m.id)}" data-field="maxTokens" aria-label="${esc(m.displayName)} 默认正文输出"></label>` : ''}${isCodex ? field(m, 'serviceTier', '默认速度', m.serviceTier || 'auto', [{value:'auto',label:'跟随上游'},{value:'default',label:'标准'},...(m.serviceTiers || []).map(t=>({value:t.id,label:t.name}))]) : ''}${m.supportsFast ? `<label><input type="checkbox" data-model="${esc(m.id)}" data-field="fast" ${m.fast ? 'checked' : ''}>Fast</label>` : ''}</div></div>`,{open});
  }
  async function loadModels(force = false) {
    if (modelLoading) return; modelLoading = true; $('refresh-models').disabled = true; $('models-message').textContent = '正在获取模型…';
    try { models = (await api(force === true ? 'models?refresh=1' : 'models')).models; paintModels(); $('models-message').textContent = models.length ? (isLocal ? '模型目录已缓存 · 点击刷新可重新发现' : '') : '账号暂无可用模型'; }
    catch (e) { $('models-message').textContent = isLocal ? `请刷新 ${localName} 登录后重试。` : status.account ? e.message : '登录 Qoder 后可查看和设置模型。'; }
    finally { modelLoading = false; $('refresh-models').disabled = false; }
  }
  $('models-list').onchange = async event => {
    const input = event.target, { model, field } = input.closest('[data-model]')?.dataset || {}; if (!model) return;
    input.disabled = true;
    try { const value = input.type === 'checkbox' ? input.checked : field === 'context' ? Number(input.value) : field === 'maxTokens' ? input.value === '' ? null : Number(input.value) : input.value; models = (await api('models/setting', { id: model, field, value })).models; $('models-message').textContent = '已保存'; if(field==='enabled')paintModels(); }
    catch (e) {
      $('models-message').textContent = e.message;
      const original = models.find(m => m.id === model);
      if (input.type === 'checkbox') input.checked = field === 'enabled' ? original.enabled : original.fast;
      else input.value = field === 'maxTokens' ? original.defaultMaxTokens || '' : field === 'context' ? original.contextWindows.find(w => w.isDefault)?.length : field === 'serviceTier' ? original.serviceTier || 'auto' : original.effort || 'auto';
    }
    finally { input.disabled = false; }
  };
  $('models-details').ontoggle = () => { if ($('models-details').open && getToken()) void loadModels(); };
  $('refresh-models').onclick = () => loadModels(true);
  async function loadUsage() {
    if (creditsLoading) return;
    if (isGrok) {
      creditsLoading = true; creditsCheckedAt = Date.now(); $('refresh-usage').disabled = true;
      try {
        const result = await api('quota'); $('usage-summary').textContent = result.message;
        const known = Number.isFinite(result.usedPercent), remaining = known ? Math.max(0, Math.min(100, 100 - result.usedPercent)) : 0;
        const period = result.period?.type === 'USAGE_PERIOD_TYPE_WEEKLY' ? '本周' : result.period?.type === 'USAGE_PERIOD_TYPE_MONTHLY' ? '本月' : '当前周期';
        $('usage-list').classList.add('agy-quotas');
        $('usage-list').innerHTML = `<div class="agy-quota-card"><div class="agy-quota-card-heading"><div><strong>Grok</strong><span>${esc(period)}共享额度 · 剩余</span></div></div><div class="agy-pool-meter"><div class="agy-meter-heading"><span>${esc(period)}</span><small></small><strong>${known ? remaining.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + '%' : '—'}</strong></div><meter class="grok-quota-meter" min="0" max="100" value="${remaining}" aria-label="Grok 剩余额度" ${known ? '' : 'hidden'}></meter><time>${result.period?.end ? esc(new Date(result.period.end).toLocaleString('zh-CN')) + ' 重置' : '上游未提供重置时间'}</time></div></div>`;
        $('usage-trend').replaceChildren(); $('usage-note').hidden = true;
      }
      catch (e) { $('usage-summary').textContent = e.message; }
      finally { creditsLoading = false; $('refresh-usage').disabled = false; }
      return;
    }
    if (isAgy) {
      creditsLoading = true; creditsCheckedAt = Date.now(); $('refresh-usage').disabled = true;
      $('usage-summary').textContent = '正在读取 AGY 模型额度…';
      try {
        const result = await api('quota');
        $('usage-summary').textContent = '同组模型共享额度 · 包含其他客户端使用';
        $('usage-list').classList.add('agy-quotas');
        $('usage-list').innerHTML = renderAgyQuota(result.groups);
        $('usage-trend').replaceChildren(); $('usage-note').hidden = true;
      } catch { $('usage-summary').textContent = 'AGY 额度获取失败，请刷新登录后重试。'; }
      finally { creditsLoading = false; $('refresh-usage').disabled = false; }
      return;
    }
    if (!status?.account) { $('usage-summary').textContent = '登录 Qoder 后可查看 Credits 用量。'; return; }
    const version = ++creditsVersion; creditsCheckedAt = Date.now();
    creditsLoading = true; $('refresh-usage').disabled = true; $('refresh-usage').textContent = '刷新中…';
    $('usage-summary').textContent = '正在读取 Credits 用量…'; $('usage-list').setAttribute('aria-busy', 'true');
    try {
      const result = await api('credits'); if (version !== creditsVersion) return;
      creditsUpdatedAt = new Date(result.updatedAt).toLocaleString('zh-CN', { hour12: false });
      const format = n => n > 0 && n < 0.01 ? '<0.01' : n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
      $('usage-summary').textContent = result.buckets.length ? `账户额度 · 获取于 ${creditsUpdatedAt} · 展开时每分钟刷新`  : 'Qoder 暂未提供可读取的 Credits 额度。';
      $('usage-list').innerHTML = result.buckets.map(bucket => {
        const percentage = bucket.total > 0 ? bucket.used / bucket.total * 100 : null;
        const percentText = percentage === null ? '—' : percentage > 0 && percentage < 0.01 ? '<0.01%' : `${format(percentage)}%`;
        const progress = Math.min(100, percentage ?? 0);
        const label = `${bucket.label}：已用 ${format(bucket.used)}，剩余 ${format(bucket.remaining)}，总额度 ${format(bucket.total)} Credits`;
        return `<article class="proxy-credit-bucket"><div class="proxy-credit-ring" role="img" aria-label="${esc(label)}"><svg viewBox="0 0 120 120" aria-hidden="true"><circle class="proxy-credit-track" cx="60" cy="60" r="50"/><circle class="proxy-credit-progress" cx="60" cy="60" r="50" pathLength="100" stroke-dasharray="${progress} 100" transform="rotate(-90 60 60)"/></svg><div aria-hidden="true"><strong>${esc(percentText)}</strong><span>${percentage === null ? '暂无占比' : '已使用'}</span></div></div><div class="proxy-credit-data"><h3>${esc(bucket.label)}</h3><dl><div><dt><i class="proxy-credit-key"></i>已用 Credits</dt><dd>${esc(format(bucket.used))}</dd></div><div><dt><i class="proxy-credit-key remaining"></i>剩余 Credits</dt><dd>${esc(format(bucket.remaining))}</dd></div><div><dt>总额度</dt><dd>${esc(format(bucket.total))}</dd></div></dl></div></article>`;
      }).join('');
      $('usage-note').hidden = !result.buckets.length;
      $('usage-trend').innerHTML = result.buckets.map(bucket => {
        const points = (result.history || []).map(row => ({ at: Date.parse(row.updatedAt), value: row.buckets.find(b => b.id === bucket.id)?.used })).filter(p => Number.isFinite(p.value));
        if (points.length < 2) return `<p class="proxy-hint">${esc(bucket.label)}：开始记录额度变化，积累两个小时的快照后显示趋势。</p>`;
        const max = Math.max(1, ...points.map(p => p.value)), start = points[0].at, end = points.at(-1).at;
        const coords = points.map(p => ({ ...p, x: 12 + (p.at - start) / Math.max(1, end - start) * 576, y: 130 - p.value / max * 112 }));
        return `<figure><figcaption>${esc(bucket.label)} · 已用 Credits 趋势</figcaption><svg viewBox="0 0 600 150" role="img" aria-label="${esc(bucket.label)}已用额度从 ${format(points[0].value)} 变化至 ${format(points.at(-1).value)} Credits"><path class="proxy-trend-line" d="${coords.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ')}"/>${coords.map(p => `<circle cx="${p.x}" cy="${p.y}" r="3"><title>${esc(new Date(p.at).toLocaleString())}：${format(p.value)} Credits</title></circle>`).join('')}</svg><div class="proxy-trend-labels"><span>${esc(new Date(start).toLocaleString())}</span><span>${esc(new Date(end).toLocaleString())}</span></div></figure>`;
      }).join('');
      if (result.historyError) { const note = document.createElement('p'); note.className = 'proxy-hint'; note.textContent = result.historyError; $('usage-trend').append(note); }

    } catch (e) {
      if (version === creditsVersion) $('usage-summary').textContent = `${e.message}。${$('usage-list').childElementCount ? `图表为上次数据（${creditsUpdatedAt}），可点击刷新重试。` : '可点击刷新重试。'}`;
    } finally {
      if (version === creditsVersion) { creditsLoading = false; $('refresh-usage').disabled = false; $('refresh-usage').textContent = '刷新'; $('usage-list').setAttribute('aria-busy', 'false'); }
    }
  }
  $('usage-details').ontoggle = () => { if ($('usage-details').open && getToken()) void loadUsage(); };
  $('refresh-usage').onclick = loadUsage;
  function hideKey() { $('api-key').type = 'password'; $('show-key').textContent = '显示'; }

  if (isCodex) $('usage-details').remove();
  if (isLocal && !isCodex) $('usage-details').querySelector('summary').firstChild.textContent = isGrok ? '订阅额度' : '模型额度';
  root.querySelector('.workspace-footer').lastElementChild.textContent = isCodex ? 'Codex' : isGrok ? 'Grok' : isAgy ? 'Antigravity' : 'Qoder';
  root.querySelectorAll('[id]').forEach(node => { node.dataset.localId = node.id; node.id = `${source}-${node.id}`; });
  root.querySelectorAll('[for], [aria-labelledby]').forEach(node => {
    for (const attr of ['for', 'aria-labelledby']) if (node.hasAttribute(attr)) node.setAttribute(attr, node.getAttribute(attr).split(' ').map(id => `${source}-${id}`).join(' '));
  });
  const service = document.createElement('div'); service.className = 'workspace proxy-common';
  const section = document.createElement('section'); section.className = 'proxy-panel';
  section.append(root.querySelector('.proxy-service'), $('service-error'));
  service.append(section, root.querySelector('.proxy-connect'), $('settings-details'), $('proxy-confirm'));
  root.querySelector('.workspace-footer').remove();
  return {
    element: root, service,
    refresh,
    updateStatus(value) { status = value; paint(); if (visible && !isCodex && $('usage-details').open && Date.now() - creditsCheckedAt >= 60000) void loadUsage(); },
    updateSource(text) { sourceNote.textContent = text; },
    setVisible(value) {
      if (visible === value) return;
      visible = value; root.hidden = !value;
      if (value && status && !isCodex && $('usage-details').open) void loadUsage();
      if (!value) { hideKey(); root.querySelectorAll('workbench-select').forEach(select => select.setOpen(false)); }
    },
    pollLogin, hideKey,
    getModel() { return models.find(m => m.enabled)?.id; },
  };

}

export function createProxyPage({ getToken }) {
  const root = document.createElement('main'); root.id = 'proxy-page'; root.className = 'proxy-page'; root.hidden = true;
  root.innerHTML = `<header class="topbar"><span>我的工作空间 <span class="slash">/</span> 反向代理</span></header><div class="workspace proxy-heading"><section class="page-heading"><div><h1>反向代理</h1><p>一个地址，连接你的模型</p></div></section><div class="proxy-tabs" role="tablist" aria-label="模型来源"><button id="proxy-tab-qoder" role="tab" aria-controls="proxy-panel-qoder" aria-selected="true" tabindex="0">Qoder</button><button id="proxy-tab-agy" role="tab" aria-controls="proxy-panel-agy" aria-selected="false" tabindex="-1">AGY</button><button id="proxy-tab-grok" role="tab" aria-controls="proxy-panel-grok" aria-selected="false" tabindex="-1">Grok</button><button id="proxy-tab-codex" role="tab" aria-controls="proxy-panel-codex" aria-selected="false" tabindex="-1">Codex</button><button id="proxy-tab-custom" role="tab" aria-controls="proxy-panel-custom" aria-selected="false" tabindex="-1">自定义</button></div></div>`;
  const pages = { qoder: createProviderPage({ getToken, source: 'qoder', common: true, getExampleModel: () => pages[selected].getModel() }), agy: createProviderPage({ getToken, source: 'agy' }), grok: createProviderPage({ getToken, source: 'grok' }), codex: createProviderPage({getToken,source:'codex'}), custom:createCustomPage({getToken}) };
  root.querySelector('.proxy-tabs').before(pages.qoder.service);
  Object.values(pages).forEach(page => root.append(page.element));
  const diagnostics = createDiagnostics({ getToken, onSources(rows) {
    for (const row of rows) pages[row.id]?.updateSource(diagnostics.describe(row));
  } });
  root.append(diagnostics.element);
  let selected = 'qoder', visible = false, timer, refreshing = false;
  async function refresh() {
    if (!visible || document.hidden || refreshing) return;
    refreshing = true;
    try {
      const [status] = await Promise.all([pages.qoder.refresh(), diagnostics.refresh()]);
      if (status) for (const name of ['agy', 'grok', 'codex']) pages[name].updateStatus(status);
      await pages.qoder.pollLogin();
    } finally { refreshing = false; }
  }
  function select(source) {
    selected = source;
    for (const [name, page] of Object.entries(pages)) {
      const button = root.querySelector(`#proxy-tab-${name}`); button.setAttribute('aria-selected', String(name === source)); button.tabIndex = name === source ? 0 : -1;
      page.setVisible(visible && name === source);
    }
  }
  for (const source of Object.keys(pages)) {
    const button = root.querySelector(`#proxy-tab-${source}`);
    button.onclick = () => select(source);
    button.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const keys = Object.keys(pages); const next = event.key === 'Home' ? keys[0] : event.key === 'End' ? keys.at(-1) : keys[(keys.indexOf(selected) + (event.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length];
      select(next); root.querySelector(`#proxy-tab-${next}`).focus();
    };
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); else pages.qoder.hideKey(); });
  return { element: root, setVisible(value) {
    visible = value; root.hidden = !value; select(selected); clearInterval(timer);
    if (value) { void refresh(); timer = setInterval(refresh, 3000); }
    else pages.qoder.hideKey();
  } };
}
