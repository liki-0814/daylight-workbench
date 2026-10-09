import { actionButton, escapeButtonText as esc } from '../components/button.js';
import { sectionHeading, settingToggleRow } from '../components/section.js';
import { createFocusPlatform } from './platform.js';
import { focusNotificationFeedback } from './presentation.js';
export function focusPermissionError(error, op) {
  if (error.unknown) return op === 'authorize' ? '授权结果待核对，请刷新权限状态。' : '系统通知请求超时，请稍后重试。';
  if (/not.?allowed|denied|not permitted/i.test(error.message)) return '系统暂不允许此应用发送通知。请检查系统通知设置，再刷新权限状态。';
  return op === 'openSettings' ? '暂时无法打开系统通知设置，请稍后重试。' : op === 'authorize' ? '暂时无法开启系统提醒。请检查系统通知设置后重试。' : '暂时无法读取系统通知状态，请稍后刷新。';
}
export function createFocusPermissionRefresh({ readPermission, isVisible, document: page = globalThis.document, window: host = globalThis.window }) {
  const events = new AbortController();
  const refresh = () => { if (isVisible() && !page?.hidden) void readPermission('getStatus'); };
  page?.addEventListener('visibilitychange', refresh, { signal: events.signal }); host?.addEventListener('focus', refresh, { signal: events.signal });
  return { dispose() { events.abort(); } };
}
export function mountFocusSettings(root, { controller, notify, document: page = globalThis.document, window: host = globalThis.window }) {
  const element = document.createElement('section'); element.className = 'settings-panel focus-settings'; const abort = new AbortController(); const platform = createFocusPlatform({ window: host }); let visible = true, dirty = false, baseline, stale = false, permission, permissionBusy = false, generation = 0;
  element.innerHTML = sectionHeading({ title: '专注', description: '工作、短休息与到期提醒' }) + `<form data-focus-settings><div class="focus-settings-durations"><label>工作时长（分钟）<input class="ui-input" type="number" name="workMinutes" min="1" max="180" step="1" required></label><label>短休息（分钟）<input class="ui-input" type="number" name="breakMinutes" min="1" max="60" step="1" required></label></div><div class="focus-settings-options">${settingToggleRow({ name: 'notificationsEnabled', label: '到期提醒', description: '工作或短休息结束时提供到期提示。' })}${settingToggleRow({ name: 'soundEnabled', label: '提醒声音', description: '系统允许提醒时，播放提示音。' })}${settingToggleRow({ name: 'showTrayTimer', label: '菜单栏显示剩余时间', description: '在 macOS 菜单栏查看当前轮次的计时。' })}</div><p class="quiet-note" data-focus-timezone></p><p class="quiet-note">设置只影响新会话。休息需要手动启动，不会自动连续计时。</p><div class="focus-actions">${actionButton({ label: '保存专注设置', variant: 'primary', attrs: { type: 'submit' } })}${actionButton({ label: '读取最新设置', variant: 'text', attrs: { 'data-focus-setting': 'reset' } })}</div><p data-focus-setting-error role="status"></p></form><div class="focus-permission">${sectionHeading({ title: '系统通知', description: '到期提醒需要系统允许发送通知。', level: 3 })}<p data-focus-permission>正在读取系统提醒权限…</p><div class="focus-actions" data-focus-permission-actions>${actionButton({ label: '开启系统提醒', variant: 'primary', attrs: { 'data-focus-setting': 'authorize' } })}${actionButton({ label: '系统通知设置', variant: 'secondary', attrs: { 'data-focus-setting': 'openSettings' } })}${actionButton({ label: '刷新权限', variant: 'text', attrs: { 'data-focus-setting': 'getStatus' } })}</div><p class="ui-feedback" data-focus-permission-error role="status"></p><details class="focus-permission-details" data-focus-permission-details hidden><summary>查看系统返回详情</summary><p></p></details></div>`;
  element.querySelector('.focus-permission').insertAdjacentHTML('beforeend', '<div data-focus-delivery hidden><p class="ui-feedback" data-focus-delivery-error role="status"></p><details class="focus-permission-details" data-focus-delivery-details hidden><summary>查看发送失败详情</summary><p></p></details></div>');
  root.append(element); const form = element.querySelector('form');
  function reset(snapshot) {
    if (!snapshot.settings) return;
    baseline = { ...snapshot.settings }; dirty = false; stale = false;
    form.elements.workMinutes.value = baseline.workSeconds / 60; form.elements.breakMinutes.value = baseline.shortBreakSeconds / 60;
    for (const key of ['notificationsEnabled', 'soundEnabled', 'showTrayTimer']) form.elements[key].checked = baseline[key];
    element.querySelector('[data-focus-timezone]').textContent = '统计时区：' + baseline.statisticsTimeZone + '（首次初始化后固定）' + (snapshot.runtime?.largeHistory ? '；专注记录较大，查询可能需要更长时间。' : ''); element.querySelector('[data-focus-setting-error]').textContent = ''; form.querySelector('[type=submit]').disabled = snapshot.busy || snapshot.degraded || snapshot.unavailable || snapshot.unknownRequest;
  }
  const unsubscribe = controller.subscribe(({ snapshot, tick }) => {
    if (tick) return;
    const delivery = focusNotificationFeedback(snapshot), deliveryElement = element.querySelector('[data-focus-delivery]'), details = element.querySelector('[data-focus-delivery-details]');
    deliveryElement.hidden = !delivery; element.querySelector('[data-focus-delivery-error]').textContent = delivery?.message || '';
    details.querySelector('p').textContent = delivery?.details || ''; details.hidden = !delivery?.details;
    if (!delivery?.details) details.open = false;
    if (!dirty) reset(snapshot);
    else if (baseline && snapshot.settings && ['workSeconds', 'shortBreakSeconds', 'notificationsEnabled', 'soundEnabled', 'showTrayTimer'].some(key => baseline[key] !== snapshot.settings[key])) { stale = true; element.querySelector('[data-focus-setting-error]').textContent = '专注设置已被其他入口修改，输入已保留。请核对最新设置后再保存。'; }
    form.querySelector('[type=submit]').disabled = snapshot.busy || snapshot.degraded || snapshot.unavailable || snapshot.unknownRequest || stale;
  });
  form.addEventListener('input', () => { dirty = true; }, { signal: abort.signal });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!baseline || stale || !form.reportValidity()) return;
    const settings = { workSeconds: Number(form.elements.workMinutes.value) * 60, shortBreakSeconds: Number(form.elements.breakMinutes.value) * 60, ...Object.fromEntries(['notificationsEnabled', 'soundEnabled', 'showTrayTimer'].map(key => [key, form.elements[key].checked])) };
    const patch = Object.fromEntries(Object.entries(settings).filter(([key, value]) => baseline[key] !== value)); if (!Object.keys(patch).length) { notify('专注设置没有变化'); return; }
    try { await controller.act({ type: 'focus.settings', settings: patch }); reset(controller.getSnapshot()); notify('专注设置已保存'); }
    catch (error) { element.querySelector('[data-focus-setting-error]').textContent = error.message; }
  }, { signal: abort.signal });
  function showPermission({ lastKnown = false } = {}) { const text = platform.isNative ? ({ default: '尚未授权系统提醒', granted: '系统提醒已授权', denied: '系统提醒已拒绝，可在系统设置中开启', unavailable: '系统提醒不可用' }[permission?.permission] || '系统提醒状态待核对') : '普通网页提供页内到期结果；关闭网页后不保证系统提醒。'; element.querySelector('[data-focus-permission]').textContent = (lastKnown && permission ? '上次读取：' : '') + text + (permission?.permission === 'granted' ? ` · 提示${permission.alertEnabled === null ? '未知' : permission.alertEnabled ? '开启' : '关闭'} · 声音${permission.soundEnabled === null ? '未知' : permission.soundEnabled ? '开启' : '关闭'}` : ''); element.querySelector('[data-focus-permission-actions]').hidden = !platform.isNative; }
  async function readPermission(op = 'getStatus', event) {
    if (permissionBusy || (op === 'getStatus' && (!visible || page?.hidden))) return;
    const current = ++generation, buttons = element.querySelectorAll('[data-focus-permission-actions] button'), errorText = element.querySelector('[data-focus-permission-error]'), details = element.querySelector('[data-focus-permission-details]');
    if (op !== 'getStatus') { permissionBusy = true; for (const button of buttons) button.disabled = true; }
    try { const value = await platform[op](event); if (visible && current === generation) { permission = value; showPermission(); errorText.textContent = ''; details.hidden = true; details.open = false; } }
    catch (error) { if (visible && current === generation) { showPermission({ lastKnown: true }); errorText.textContent = focusPermissionError(error, op); details.querySelector('p').textContent = error.message; details.hidden = !error.message; details.open = false; } }
    finally { if (current === generation && op !== 'getStatus') { permissionBusy = false; for (const button of buttons) button.disabled = false; } }
  }
  const permissionLifecycle = createFocusPermissionRefresh({ readPermission, isVisible: () => visible, document: page, window: host });
  element.addEventListener('click', event => { const button = event.target.closest('[data-focus-setting]'); if (!button || !element.contains(button)) return; const op = button.dataset.focusSetting; if (op === 'reset') reset(controller.getSnapshot()); else void readPermission(op, event); }, { signal: abort.signal });
  showPermission(); void readPermission(); return { element, setVisible(value) { if (visible === value) return; visible = value; if (value) void readPermission(); }, dispose() { visible = false; generation++; permissionLifecycle.dispose(); unsubscribe(); abort.abort(); platform.dispose(); element.remove(); } };
}
