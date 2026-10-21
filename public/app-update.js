import { actionButton } from './components/button.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const releasePrefix = 'https://github.com/liki-0814/daylight-workbench/releases/';
const safeHref = value => typeof value === 'string' && value.startsWith(releasePrefix) ? value : '';
const statusText = {
  available: report => `发现新版本 ${report.latest?.version || ''}`.trim(),
  current: () => '已是最新正式发布',
  none: () => 'GitHub 上还没有正式发布',
  unrecognized: report => report.error || '发布版本号无法比较',
  unavailable: report => report.error || '暂时无法读取 GitHub 发布',
};

function formatWhen(value) {
  const date = new Date(value || '');
  if (!value || Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function fact(label, value, state = '') {
  return `<div><dt>${esc(label)}</dt><dd${state ? ` data-state="${esc(state)}"` : ''}>${esc(value)}</dd></div>`;
}

export function appUpdateMarkup(report, { busy = false } = {}) {
  const state = busy || !report ? '' : report.status;
  const label = busy || !report ? '正在检查…' : (statusText[report.status] || statusText.unavailable)(report);
  const latest = report?.latest;
  const page = safeHref(latest?.htmlUrl);
  const assetUrl = safeHref(latest?.asset?.url);
  const published = formatWhen(latest?.publishedAt);
  const checked = formatWhen(report?.checkedAt);
  const links = [
    page ? `<a class="text-button" href="${esc(page)}" target="_blank" rel="noreferrer">查看发布</a>` : '',
    report?.status === 'available' && assetUrl ? `<a class="text-button" href="${esc(assetUrl)}" target="_blank" rel="noreferrer">下载 ${esc(latest.asset.name)}</a>` : '',
    actionButton({ label: busy ? '正在检查…' : '重新检查', variant: 'text', attrs: { 'data-check-update': true, disabled: busy } }),
  ].filter(Boolean);
  return `<div class="settings-heading"><h2 id="app-update-heading">应用更新</h2><p>对照 GitHub 的正式发布，不自动安装</p></div><dl class="settings-facts">${fact('当前版本', report?.current || (report ? '未知' : '正在读取…'))}${fact('最新发布', latest?.version || (report ? '无' : '正在检查…'), state)}${published ? fact('发布时间', published) : ''}${fact('状态', label, state)}${checked ? fact('上次检查', checked) : ''}</dl>${latest?.notes ? `<p class="app-update-notes">${esc(latest.notes)}</p>` : ''}<div class="app-update-actions">${links.join('')}</div>`;
}

export function mountAppUpdate(parent, { getReport, onRefresh }) {
  const section = document.createElement('section');
  section.className = 'settings-panel app-update';
  section.setAttribute('aria-labelledby', 'app-update-heading');
  let busy = false;
  const paint = () => { section.innerHTML = appUpdateMarkup(getReport(), { busy }); };
  section.addEventListener('click', async event => {
    if (!event.target.closest('[data-check-update]') || busy) return;
    busy = true; paint();
    try { await onRefresh(); } finally { busy = false; paint(); }
  });
  parent.prepend(section);
  paint();
  return { paint };
}
