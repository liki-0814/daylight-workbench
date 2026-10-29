import { disclosureSection, mountDisclosures, refreshButton, setRefreshState } from './section.js';
import { modelGroups, modelHeading, onTabReturn, pinToggle, regroupPins, repaintKeepingControl } from './model-row.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const kindLabel = { image: '图像', video: '视频' };
const statusLabel = { ready: '已登录可用' };

export function mediaRowsHtml(models, options) {
  return modelGroups(models, (model, i, state = {}) => `<div class="proxy-model ui-media-model">${modelHeading(model, `<input type="checkbox" data-media-model="${esc(model.id)}" ${model.enabled !== false ? 'checked' : ''} aria-label="启用 ${esc(model.id)}">`, { pending: state.pending, selected: model.enabled !== false })}<p class="proxy-hint">${esc(kindLabel[model.output] || model.output)} · ${esc(statusLabel[model.status] || model.status)}${model.note ? ` · ${esc(model.note)}` : ''}</p></div>`, options);
}

export function createMediaModels({ source, load, save }) {
  const root = document.createElement('div');
  root.hidden = true;
  root.innerHTML = disclosureSection({ id: `${source}-media-models`, className: 'proxy-disclosure', title: '图像与视频', description: '启用设置 · 与聊天模型共用登录', actions: refreshButton({ ariaLabel: '刷新图像与视频', attrs: { 'data-refresh-media': true } }), content: '<div data-media-list></div><p class="proxy-hint proxy-model-message ui-feedback-row" role="status" data-media-message></p>' });
  mountDisclosures(root);
  const button = root.querySelector('[data-refresh-media]'), list = root.querySelector('[data-media-list]'), message = root.querySelector('[data-media-message]');
  const pins = new Map();
  const stopTabReturn = onTabReturn(() => { if (visible && !saving) regroupPins(pins, paint); });
  let models = [], snapshot, loaded = false, available = false, loading = false, saving = false, visible = false, version = 0;
  function setBusy(value) { list.querySelectorAll('[data-media-model]').forEach(input => { input.disabled = value; }); list.setAttribute('aria-busy', String(value)); }
  function paint(open = list.querySelector('.proxy-disabled-models')?.open || false) { list.innerHTML = mediaRowsHtml(models, { open, pins }); }
  async function refresh(force = false) {
    if (loading || saving) return;
    const current = version;
    loading = true;
    setBusy(true);
    message.textContent = loaded ? '正在刷新图像与视频…' : '正在获取图像与视频…';
    setRefreshState(button, { loading: true });
    let retry = false;
    try {
      const result = await load(force);
      if (current !== version) return;
      if (result === undefined) { retry = true; return; }
      const next = Array.isArray(result) ? result : result?.models || [];
      available ||= next.length > 0;
      root.hidden = !available;
      if (!loaded || force || snapshot !== result) { models = next; snapshot = result; if (force) pins.clear(); paint(); }
      loaded = true;
      message.textContent = models.length ? '' : '账号暂无可用图像与视频模型';
    } catch (error) {
      if (current !== version) return;
      if (error.name === 'AbortError') retry = true;
      else { root.hidden = false; message.textContent = error.message || '获取失败，请刷新重试'; }
    } finally {
      if (current === version) {
        loading = false; setBusy(false); setRefreshState(button);
        if (retry && visible) void refresh();
      }
    }
  }
  list.addEventListener('change', async event => {
    const input = event.target.closest('[data-media-model]');
    if (!input || saving) return;
    const original = models.find(model => model.id === input.dataset.mediaModel), current = version, value = input.checked;
    saving = true; setBusy(true); setRefreshState(button, { disabled: true }); message.textContent = '正在保存…';
    try {
      const result = await save({ id: original.id, field: 'enabled', value });
      if (current !== version) return;
      const restoreFocus = visible && (document.activeElement === input || document.activeElement === document.body);
      models = result.models; snapshot = result; pinToggle(pins, original.id, !value);
      repaintKeepingControl(list, `[data-media-model="${CSS.escape(original.id)}"]`, () => paint(), { focus: restoreFocus });
      message.textContent = '已保存';
    } catch (error) {
      if (current === version) { input.checked = original.enabled !== false; message.textContent = error.message || '保存失败，请重试'; }
    } finally {
      if (current === version) { saving = false; setBusy(false); setRefreshState(button); if (visible && input.isConnected && document.activeElement === document.body) input.focus({ preventScroll: true }); }
    }
  });
  button.addEventListener('click', () => { void refresh(true); });
  return { element: root, setVisible(value) { visible = value; if (value) { regroupPins(pins, paint); void refresh(); } }, refresh,
    reset() { pins.clear(); version++; loading = false; saving = false; loaded = false; available = false; snapshot = undefined; models = []; root.hidden = true; list.replaceChildren(); list.setAttribute('aria-busy', 'false'); message.textContent = ''; setRefreshState(button); },
    dispose() { version++; visible = false; stopTabReturn(); }
  };
}
