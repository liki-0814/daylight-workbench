import { actionButton } from './components/button.js';
import { segmentedControl, mountSegmentedControl } from './components/segmented-control.js';
import { createProgressMeter } from './components/progress-meter.js';
import { createDialogShell } from './components/dialog-shell.js';
import { icon } from './components/icons.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const repositoryURL = 'https://github.com/liki-0814/daylight-workbench';
const releasePrefix = `${repositoryURL}/releases/`;
const safeHref = value => typeof value === 'string' && value.startsWith(releasePrefix) ? value : '';
export const updateModes = [
  { value: 'notify', label: '仅提醒', note: '发现新版本时只在更新页和侧栏提醒，由你决定何时下载和安装。' },
  { value: 'download-quit', label: '退出时安装', note: '自动下载并校验；下次退出 Daylight 时静默安装，下次启动即是新版本。' },
  { value: 'download-prompt', label: '下载并提示重启', note: '自动下载并校验；准备好后询问是否立即重启（有代理请求或 AI 对话在进行时不会打扰）。' },
];
const releaseStatusText = {
  available: report => `发现新版本 ${report.latest?.version || ''}`.trim(),
  current: () => '已是最新正式发布',
  none: () => 'GitHub 上还没有正式发布',
  unrecognized: report => report.error || '发布版本号无法比较',
  unavailable: report => report.error || '暂时无法读取 GitHub 发布',
};
const busyPhases = new Set(['downloading', 'verifying', 'extracting', 'installing']);
const phaseText = { downloading: '正在下载', verifying: '正在校验', extracting: '正在解压并检查签名', installing: '正在安装并重启' };
const resultText = {
  success: result => result.kind === 'rollback' ? `已回滚到 ${result.to}` : `已更新到 ${result.to}`,
  failed: result => `${result.kind === 'rollback' ? '回滚' : '更新'}失败，已保持原版本${result.message ? `：${result.message}` : ''}`,
  'rolled-back': result => `${result.to} 启动后未通过健康检查，已自动回滚到 ${result.from}`,
};

export function formatWhen(value) {
  const date = new Date(value || '');
  if (!value || Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
export function formatBytes(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return '';
  return size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
}
export const progressFraction = updater => {
  const { received = 0, total = 0 } = updater?.progress || {};
  return total > 0 ? Math.max(0, Math.min(1, received / total)) : 0;
};
export function progressText(updater) {
  const { received = 0, total = 0 } = updater?.progress || {};
  const percent = Math.round(progressFraction(updater) * 100);
  const base = `${phaseText[updater?.phase] || ''}${updater?.target ? ` ${updater.target}` : ''}`;
  return updater?.phase === 'downloading' && total > 0 ? `${base} · ${percent}% (${formatBytes(received)} / ${formatBytes(total)})` : base;
}

function fact(label, valueHTML, state = '') {
  return `<div><dt>${esc(label)}</dt><dd${state ? ` data-state="${esc(state)}"` : ''}>${valueHTML}</dd></div>`;
}
function resultLine(result) {
  const text = (resultText[result.status] || (() => result.message || ''))(result);
  return `${esc(text)}${result.at ? ` · ${esc(formatWhen(result.at))}` : ''}`;
}

/** Pure markup for the whole page; the controller only supplies data. */
export function updateMarkup({ release = null, updater = null, checking = false, loadError = '', notesHtml = '' } = {}) {
  const latest = release?.latest;
  const phase = updater?.phase || 'idle';
  const working = busyPhases.has(phase);
  const install = latest?.install;
  const available = release?.status === 'available';
  const canInstall = available && updater?.supported === true && install?.ok === true;
  const page = safeHref(latest?.htmlUrl), dmg = safeHref(latest?.asset?.url);
  const status = checking || (!release && !loadError) ? '正在检查…' : release ? (releaseStatusText[release.status] || releaseStatusText.unavailable)(release) : (loadError || '暂时无法检查更新');
  const state = checking || !release ? '' : release.status;
  const staged = updater?.staged;
  const actions = [actionButton({ label: checking ? '正在检查…' : '检查更新', symbol: 'refresh', variant: working ? 'secondary' : (canInstall || phase === 'ready' ? 'secondary' : 'primary'), attrs: { 'data-update-check': true, disabled: checking || phase === 'installing' } })];
  if (phase === 'downloading') actions.push(actionButton({ label: '取消下载', variant: 'secondary', attrs: { 'data-update-cancel': true } }));
  else if (working) actions.push(actionButton({ label: phase === 'installing' ? '正在重启…' : '正在处理…', variant: 'primary', attrs: { disabled: true } }));
  else if (phase === 'ready') actions.push(actionButton({ label: `重启并安装 ${staged?.version || ''}`.trim(), symbol: 'check', variant: 'primary', attrs: { 'data-update-install': true } }), actionButton({ label: '放弃已下载的更新', variant: 'text', attrs: { 'data-update-discard': true } }));
  else if (canInstall) actions.push(actionButton({ label: `下载更新 ${latest.version}${install.size ? ` · ${formatBytes(install.size)}` : ''}`, symbol: 'down', variant: 'primary', attrs: { 'data-update-download': true } }));
  const links = [
    page ? `<a class="text-button" href="${esc(page)}" target="_blank" rel="noreferrer">查看发布页</a>` : '',
    available && dmg && !canInstall && phase === 'idle' ? `<a class="text-button" href="${esc(dmg)}" target="_blank" rel="noreferrer">下载 ${esc(latest.asset.name)}</a>` : '',
  ].filter(Boolean);

  const notices = [];
  const result = updater?.lastResult;
  if (result) notices.push(`<div class="update-notice" data-tone="${result.status === 'success' ? 'ok' : 'warn'}" data-update-result><span>${resultLine(result)}</span>${actionButton({ label: '知道了', variant: 'text', attrs: { 'data-update-ack': true } })}</div>`);
  if (updater?.error) notices.push(`<div class="update-notice" data-tone="warn" role="alert"><span>${esc(updater.error.message || '更新失败')}</span>${actionButton({ label: '知道了', variant: 'text', attrs: { 'data-update-ack': true } })}</div>`);
  if (updater?.needsReauth) notices.push(`<div class="update-notice" data-tone="warn"><span>${esc(updater.needsReauth.message)}</span>${dmg ? `<a class="text-button" href="${esc(dmg)}" target="_blank" rel="noreferrer">下载 DMG</a>` : ''}</div>`);
  if (available && !canInstall && phase === 'idle') {
    const reason = install && install.ok === false ? install.message : updater?.supported === false ? updater.message : '';
    if (reason) notices.push(`<div class="update-notice" data-tone="info"><span>${esc(reason)}</span></div>`);
  }
  if (phase === 'ready' && staged?.credentialsReset) notices.push('<div class="update-notice" data-tone="info"><span>这个版本更新了钥匙串辅助程序，更新后需要在设置里重新登录一次已保存的服务账号。</span></div>');
  if (loadError && release) notices.push(`<div class="update-notice" data-tone="warn" role="alert"><span>${esc(loadError)}</span></div>`);

  const live = `<div class="update-live" role="status" aria-live="polite" data-update-live>${working ? `<span data-update-progress-text>${esc(progressText(updater))}</span><div data-update-progress></div>` : phase === 'ready' ? `<span>${esc(staged?.version || '')} 已下载并通过校验，重启后完成更新</span>` : ''}</div>`;
  const mode = updater?.mode || 'notify';
  const note = updateModes.find(item => item.value === mode)?.note || '';
  const supported = updater?.supported === true;
  const history = Array.isArray(updater?.history) ? updater.history : [];
  const backup = updater?.backup;
  const sourceLink = `<a href="${repositoryURL}" target="_blank" rel="noreferrer">liki-0814/daylight-workbench</a>`;
  const signing = ({ 'self-signed': '自签名发布证书', 'ad-hoc': '临时签名', developer: '开发者签名', unsigned: '未签名' })[updater?.current?.signing];
  return `<header class="topbar"><span>我的工作空间 <span class="slash">/</span> 更新</span></header>
    <div class="workspace settings-workspace">
      <section class="page-heading"><div><h1>更新</h1><p>对照 GitHub 的正式发布；签名与校验通过后才会安装</p></div></section>
      <div class="ui-panel-grid settings-grid"><div class="ui-panel-stack">
        <section class="settings-panel" aria-labelledby="update-version-heading">
          <div class="settings-heading"><h2 id="update-version-heading">版本</h2><p>${esc(status)}</p></div>
          <dl class="settings-facts">
            ${fact('GitHub 仓库', `${sourceLink} <span class="update-inline-actions"><a class="text-button" href="${repositoryURL}" target="_blank" rel="noreferrer">打开</a>${actionButton({ label: '复制地址', symbol: 'copy', variant: 'text', attrs: { 'data-update-copy': true } })}</span>`)}
            ${fact('当前版本', esc(release?.current || updater?.current?.version || (loadError ? '未知' : '正在读取…')))}
            ${signing ? fact('当前签名', esc(signing)) : ''}
            ${fact('最新发布', esc(latest?.version || (release ? '无' : '正在检查…')), state)}
            ${latest?.publishedAt ? fact('发布时间', esc(formatWhen(latest.publishedAt))) : ''}
            ${fact('状态', esc(status), state)}
            ${release?.checkedAt ? fact('上次检查', esc(formatWhen(release.checkedAt))) : ''}
          </dl>
          ${notices.join('')}
          ${live}
          <div class="app-update-actions">${actions.join('')}${links.join('')}</div>
        </section>
        <section class="settings-panel" aria-labelledby="update-notes-heading">
          <div class="settings-heading"><h2 id="update-notes-heading">更新说明</h2><p>${latest ? esc(latest.name || latest.version) : '发布说明'}</p></div>
          ${latest?.body ? `<div class="update-notes" data-update-notes>${notesHtml || `<p>${esc(latest.notes)}</p>`}</div>` : `<p class="update-empty" data-update-notes-empty>${latest ? '该发布没有填写说明。' : '有新的正式发布后，完整说明会显示在这里。'}</p>`}
        </section>
      </div><div class="ui-panel-stack">
        <section class="settings-panel" aria-labelledby="update-mode-heading">
          <div class="settings-heading"><h2 id="update-mode-heading">自动更新</h2><p>${supported ? '选择新版本出现后的处理方式' : '当前环境不支持应用内安装'}</p></div>
          <div class="update-mode">${segmentedControl({ id: 'update-mode', label: '自动更新方式', value: mode, options: updateModes.map(item => ({ value: item.value, label: item.label, disabled: !supported && item.value !== 'notify' })) })}</div>
          <p class="update-mode-note" data-update-mode-note>${esc(supported ? note : (updater?.message || '网页版只能检查新版本。'))}</p>
        </section>
        <section class="settings-panel" aria-labelledby="update-history-heading">
          <div class="settings-heading"><h2 id="update-history-heading">更新历史</h2><p>${backup ? `保留着上一版本 ${esc(backup.version)} 以便回滚` : '最近的更新与回滚记录'}</p></div>
          ${history.length ? `<ul class="update-history" data-update-history>${history.map(item => `<li data-status="${esc(item.status)}"><div><strong>${esc(item.from)} → ${esc(item.to)}</strong><span>${resultLine(item)}</span></div></li>`).join('')}</ul>` : '<p class="update-empty" data-update-history-empty>还没有更新记录。</p>'}
          ${backup ? `<div class="app-update-actions">${actionButton({ label: `回滚到 ${backup.version}`, symbol: 'undo', variant: 'secondary', attrs: { 'data-update-rollback': true, disabled: working || !supported } })}${backup.sameSigner === false ? '<span class="update-inline-note">上一版本的签名与当前不同，回滚后可能需要重新授权。</span>' : ''}</div>` : ''}
        </section>
      </div></div>
      <footer class="workspace-footer"><span>更新包来自 GitHub，安装前在本机校验</span><span>Daylight</span></footer>
    </div>`;
}

function mount(root, { getToken, getRelease, refreshRelease, notify, onChange }) {
  let updater = null, checking = false, loadError = '', timer, visible = false, notesHtml = '', notesFor = '', signature = '', disposed = false;
  const meter = createProgressMeter({ label: '更新进度' });
  const headers = () => ({ 'x-workbench-token': getToken(), 'Content-Type': 'application/json' });

  async function request(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { ...headers(), ...(options.headers || {}) }, signal: AbortSignal.timeout(20000) });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  }
  async function loadUpdater() {
    try {
      const { ok, body } = await request('/api/app/updater');
      if (!ok) throw new Error(body.error || '无法读取更新状态');
      updater = body; loadError = '';
    } catch (error) { loadError = error.message || '无法读取更新状态'; }
    onChange?.(updater);
  }
  function focusKey() {
    const active = document.activeElement;
    if (!active || !root.contains(active)) return null;
    for (const name of ['updateCheck', 'updateDownload', 'updateCancel', 'updateInstall', 'updateDiscard', 'updateCopy', 'updateRollback', 'updateAck', 'segmentValue']) if (name in active.dataset) return [name, active.dataset[name]];
    return null;
  }
  function restoreFocus(key) {
    if (!key) return;
    const attribute = key[0].replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());
    const node = root.querySelector(key[1] ? `[data-${attribute}="${CSS.escape(key[1])}"]` : `[data-${attribute}]`);
    if (node && !node.disabled) node.focus({ preventScroll: true });
  }
  function paintProgress() {
    const text = root.querySelector('[data-update-progress-text]');
    if (text) text.textContent = progressText(updater);
    const holder = root.querySelector('[data-update-progress]');
    if (holder) { meter.setValue(progressFraction(updater), progressText(updater)); if (meter.element.parentNode !== holder) holder.replaceChildren(meter.element); }
  }
  async function paint(force = false) {
    const release = getRelease();
    const latest = release?.latest;
    if (latest?.body && notesFor !== `${latest.version}:${latest.body.length}`) {
      notesFor = `${latest.version}:${latest.body.length}`;
      try {
        const { markdown } = await import('./components/ai-message.js');
        const holder = document.createElement('div'); holder.innerHTML = markdown(latest.body);
        holder.querySelectorAll('a').forEach(link => { link.target = '_blank'; link.rel = 'noreferrer'; });
        notesHtml = holder.innerHTML;
      } catch { notesHtml = ''; }
    }
    if (disposed) return;
    const next = JSON.stringify([release, updater && { ...updater, progress: null }, checking, loadError, notesHtml]);
    if (next === signature && !force) { paintProgress(); return; }
    signature = next;
    const key = focusKey(), scroll = window.scrollY;
    root.innerHTML = updateMarkup({ release, updater, checking, loadError, notesHtml });
    paintProgress();
    restoreFocus(key);
    if (window.scrollY !== scroll) window.scrollTo(0, scroll);
  }
  function schedule() {
    clearTimeout(timer);
    if (!visible || disposed) return;
    const active = busyPhases.has(updater?.phase);
    timer = setTimeout(async () => { if (!visible) return; await loadUpdater(); await paint(); schedule(); }, active ? 700 : 15000);
  }
  async function refresh() { await loadUpdater(); await paint(); schedule(); }
  async function check() {
    if (checking) return;
    checking = true; await paint();
    try { await refreshRelease(true); } finally { checking = false; }
    await loadUpdater(); await paint(); schedule();
  }
  async function act(action, extra = {}) {
    const { ok, status, body } = await request('/api/app/updater', { method: 'POST', body: JSON.stringify({ action, ...extra }) });
    if (ok) { updater = body; onChange?.(updater); }
    else if (status !== 409 || body.code !== 'busy') { loadError = body.error || '操作失败'; await loadUpdater(); }
    await paint(); schedule();
    return { ok, status, body };
  }
  function confirmRestart({ title, description, label, action, body }) {
    const shell = createDialogShell({ title, description, onClose: () => shell.dispose() });
    shell.setContent(`<div class="update-confirm-actions">${actionButton({ label: '取消', variant: 'secondary', attrs: { 'data-update-confirm-cancel': true } })}${actionButton({ label, variant: 'danger', attrs: { 'data-update-confirm': true } })}</div>`);
    shell.element.addEventListener('click', async event => {
      if (event.target.closest('[data-update-confirm-cancel]')) shell.close();
      if (event.target.closest('[data-update-confirm]')) { shell.dispose(); await act(action, body); }
    });
    return shell.open();
  }
  async function install(force = false) {
    const result = await act('install', force ? { force: true } : {});
    if (!result.ok && result.body.code === 'busy') {
      confirmRestart({ title: '现在重启会中断正在进行的任务', description: `${result.body.error}。建议等它们结束后再更新。`, label: '仍然重启并安装', action: 'install', body: { force: true } });
    } else if (result.ok) notify?.('正在重启以完成更新…');
  }
  async function copyRepository() {
    try { await navigator.clipboard.writeText(repositoryURL); notify?.('已复制仓库地址'); }
    catch {
      const field = document.createElement('textarea'); field.value = repositoryURL; field.setAttribute('readonly', ''); field.style.position = 'fixed'; field.style.opacity = '0';
      document.body.append(field); field.select();
      const copied = document.execCommand?.('copy'); field.remove();
      notify?.(copied ? '已复制仓库地址' : '无法复制，请手动选择地址');
    }
  }
  root.addEventListener('click', async event => {
    const target = event.target.closest('button');
    if (!target || !root.contains(target) || target.disabled) return;
    if ('updateCheck' in target.dataset) await check();
    else if ('updateDownload' in target.dataset) await act('download');
    else if ('updateCancel' in target.dataset) await act('cancel');
    else if ('updateInstall' in target.dataset) await install();
    else if ('updateDiscard' in target.dataset) await act('discard');
    else if ('updateAck' in target.dataset) await act('ack');
    else if ('updateCopy' in target.dataset) await copyRepository();
    else if ('updateRollback' in target.dataset) confirmRestart({ title: `回滚到 ${updater?.backup?.version || '上一版本'}？`, description: 'Daylight 会退出并换回上一个版本，数据不受影响。', label: '回滚并重启', action: 'rollback', body: {} });
  });
  mountSegmentedControl(root, { onChange: async value => { if (updater && updater.mode !== value) await act('mode', { value }); } });
  return {
    paint: () => paint(),
    refresh,
    check,
    setVisible(value) { visible = value; root.hidden = !value; if (value) void refresh(); else clearTimeout(timer); },
    dispose() { disposed = true; clearTimeout(timer); meter.dispose(); },
  };
}

export function createUpdatePage(options) {
  const element = document.createElement('main');
  element.id = 'update-page'; element.className = 'settings-page'; element.hidden = true;
  const controller = mount(element, options);
  void controller.paint();
  return { element, ...controller };
}
