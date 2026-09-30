import { resolveQuickInput } from './quick-search.js';

const form = document.querySelector('#quick-form');
const input = document.querySelector('#quick-input');
const action = document.querySelector('#quick-action');
const closeButton = document.querySelector('#quick-close');
const bridge = globalThis.webkit?.messageHandlers?.quick;
const embedded = Boolean(bridge) || new URLSearchParams(location.search).has('embed');

document.documentElement.classList.toggle('embedded', embedded);

function update() {
  action.textContent = resolveQuickInput(input.value).kind === 'url' ? '打开网址' : '用 Google 搜索';
}

function close() {
  if (bridge) { bridge.postMessage({ type: 'close' }); return; }
  input.value = '';
  update();
}

function submit() {
  const { url } = resolveQuickInput(input.value);
  if (!url) return;
  if (bridge) { bridge.postMessage({ type: 'open', url }); return; }
  window.open(url, '_blank', 'noopener');
}

form.addEventListener('submit', event => { event.preventDefault(); submit(); });
input.addEventListener('input', update);
closeButton.addEventListener('click', close);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); close(); }
});

// The native panel calls this whenever it appears so each summon starts clean.
window.quickReset = () => { input.value = ''; update(); input.focus(); input.select(); };
update();
input.focus();
