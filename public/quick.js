import { resolveQuickInput } from './quick-search.js';
import { segmentedControl, mountSegmentedControl } from './components/segmented-control.js';
import { actionButton } from './components/button.js';
import { markdown } from './components/ai-message.js';
import { icon } from './components/icons.js';

const $ = selector => document.querySelector(selector);
const form = $('#quick-form'), input = $('#quick-input'), action = $('#quick-action');
const result = $('#quick-result'), answer = $('#quick-answer'), status = $('#quick-status');
const bridge = globalThis.webkit?.messageHandlers?.quick;
document.documentElement.classList.toggle('embedded', Boolean(bridge) || new URLSearchParams(location.search).has('embed'));
let mode = 'ai', generation = 0, jobId = null, timer, used = false, text = '', tokenPromise;

$('#quick-mode').innerHTML = segmentedControl({ id: 'quick-mode-control', label: '快捷面板模式', value: mode, options: [{ value: 'ai', label: 'AI 问答' }, { value: 'search', label: 'Google' }] });
$('#quick-buttons').innerHTML = actionButton({ label: '复制回答', attrs: { id: 'quick-copy', disabled: true }, variant: 'text' });
mountSegmentedControl($('#quick-mode-control'), { onChange(value) { clear(); mode = value; update(); input.focus(); } });

async function api(route, data) {
  tokenPromise ||= fetch('/api/state', { cache: 'no-store' }).then(async response => {
    if (!response.ok) throw new Error('无法连接工作台，请重新打开面板');
    return (await response.json()).token;
  }).catch(error => { tokenPromise = null; throw error; });
  const token = await tokenPromise;
  const response = await fetch('/api/ai/quick' + route, { method: data ? 'POST' : 'GET', cache: 'no-store', headers: { 'X-Workbench-Token': token, 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '临时问答失败，请重试');
  return value;
}
function resize() {
  const first = answer.firstElementChild, last = answer.lastElementChild;
  const contentHeight = first ? last.getBoundingClientRect().bottom - first.getBoundingClientRect().top : 0;
  const height = result.hidden ? 110 : Math.min(480, Math.ceil(204 + contentHeight));
  $('#quick').style.setProperty('--quick-height', `${height}px`);
  bridge?.postMessage({ type: 'resize', height });
}
function update() {
  const ai = mode === 'ai';
  $('.quick-glyph').innerHTML = icon(ai ? 'chat' : 'search');
  input.placeholder = ai ? '问一个问题，关闭即清空' : '搜索 Google，或输入网址';
  input.setAttribute('aria-label', ai ? '临时问答' : '快速搜索');
  action.textContent = ai ? used ? '单轮问答 · 关闭即清空' : '向 AI 提问 · 不保存记录' : resolveQuickInput(input.value).kind === 'url' ? '打开网址' : '用 Google 搜索';
  resize();
}
function clear() {
  generation++; clearTimeout(timer);
  const id = jobId; jobId = null;
  if (id) void api(`/${id}/cancel`, {}).catch(() => {});
  used = false; text = ''; input.value = ''; input.readOnly = false;
  result.hidden = true; answer.replaceChildren(); status.textContent = ''; $('#quick-model').textContent = '';
  $('#quick-copy').disabled = true; $('#quick-copy').textContent = '复制回答';
}
function close() {
  clear(); update();
  bridge?.postMessage({ type: 'close' });
}
async function poll(id, current) {
  try {
    const value = await api('/' + id);
    if (current !== generation) return;
    if (text !== value.text) { text = value.text; answer.innerHTML = markdown(text); }
    $('#quick-copy').disabled = !text;
    status.textContent = value.status === 'running' ? text ? '正在回答…' : '正在思考…' : value.error || '回答完成 · 关闭即清空';
    resize();
    if (value.status === 'running') timer = setTimeout(() => poll(id, current), 300);
    else jobId = null;
  } catch (error) {
    if (current !== generation) return;
    status.textContent = error.message;
    const id = jobId; jobId = null;
    if (id) void api(`/${id}/cancel`, {}).catch(() => {});
  }
}
async function submit() {
  if (mode === 'search') {
    const { url } = resolveQuickInput(input.value);
    if (!url) return;
    if (bridge) { clear(); bridge.postMessage({ type: 'open', url }); }
    else window.open(url, '_blank', 'noopener');
    return;
  }
  if (used || !input.value.trim()) return;
  used = true; input.readOnly = true; result.hidden = false;
  status.textContent = '正在连接 AI…'; update();
  const current = generation;
  try {
    const started = await api('', { text: input.value });
    if (current !== generation) { void api(`/${started.id}/cancel`, {}).catch(() => {}); return; }
    jobId = started.id;
    $('#quick-model').textContent = `${started.backend === 'qoder' ? 'Qoder' : 'Codex'} · ${started.model}`;
    void poll(jobId, current);
  } catch (error) { if (current === generation) status.textContent = error.message; }
}
form.addEventListener('submit', event => { event.preventDefault(); void submit(); });
input.addEventListener('input', update);
input.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || input.value || input.readOnly || event.isComposing || event.keyCode === 229 || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  event.preventDefault();
  const buttons = [...$('#quick-mode-control').querySelectorAll('[data-segment-value]:not(:disabled)')];
  const index = buttons.findIndex(button => button.getAttribute('aria-checked') === 'true');
  buttons[(index + (event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length]?.click();
});
$('#quick-close').addEventListener('click', close);
$('#quick-copy').addEventListener('click', async () => {
  const current = generation;
  try { await navigator.clipboard.writeText(text); if (current === generation) $('#quick-copy').textContent = '已复制'; }
  catch { if (current === generation) status.textContent = '请选中回答后按 ⌘C 复制'; }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); close(); }
});
window.addEventListener('pagehide', clear);
// Native dismissal includes Esc, shortcut toggle, loss of focus, and App shutdown.
window.quickDismiss = () => { clear(); update(); };
window.quickReset = () => { clear(); update(); input.focus(); };
update(); input.focus();
