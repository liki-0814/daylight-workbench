import { morph } from '../ui/core/morph.js';
import { html } from '../ui/core/html.js';
import { settingsGroup, settingsRow, settingsReadout } from '../ui/patterns/settings/settings.js';
import { input } from '../ui/components/input/input.js';
import { switchControl } from '../ui/components/switch/switch.js';
import { button } from '../ui/components/button/button.js';
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
// 专注设置（0.8）：每个控件改动即保存（controller.act focus.settings，只提交变化的那一项），没有「保存」按钮。
const permissionText = (platform, permission, lastKnown) => {
  const text = platform.isNative ? ({ default: '尚未授权系统提醒', granted: '系统提醒已授权', denied: '系统提醒已拒绝，可在系统设置中开启', unavailable: '系统提醒不可用' }[permission?.permission] || '系统提醒状态待核对') : '普通网页提供页内到期结果；关闭网页后不保证系统提醒。';
  const state = value => value === null ? '未知' : value ? '开启' : '关闭';
  return (lastKnown && permission ? '上次读取：' : '') + text + (permission?.permission === 'granted' ? ` · 提示${state(permission.alertEnabled)} · 声音${state(permission.soundEnabled)}` : '');
};
export function mountFocusSettings(root, { controller, notify, document: page = globalThis.document, window: host = globalThis.window }) {
  const element = document.createElement('section'); element.className = 'focus-settings'; const abort = new AbortController(); const platform = createFocusPlatform({ window: host });
  let visible = true, permission, permissionBusy = false, generation = 0, snapshot = controller.getSnapshot(), message = '', permissionError = '', permissionDetails = '', lastKnown = false;
  root.append(element);
  const minutes = key => Math.round((snapshot.settings?.[key] || 0) / 60);
  const blocked = () => !snapshot.settings || snapshot.busy || snapshot.degraded || snapshot.unavailable || snapshot.unknownRequest;
  function view() {
    const settings = snapshot.settings || {}, off = blocked(), delivery = focusNotificationFeedback(snapshot);
    const toggle = (name, label, hint) => settingsRow({ key: name, label, hint, control: switchControl({ name, checked: !!settings[name], label, disabled: off }) });
    const permissionActions = platform.isNative ? html`${button({ label: '开启系统提醒', variant: 'primary', disabled: permissionBusy, attrs: { 'data-focus-setting': 'authorize' } })}${button({ label: '系统通知设置', disabled: permissionBusy, attrs: { 'data-focus-setting': 'openSettings' } })}${button({ label: '刷新权限', variant: 'ghost', disabled: permissionBusy, attrs: { 'data-focus-setting': 'getStatus' } })}` : '';
    return html`${settingsGroup({ key: 'focus-main', flush: true, rows: [
      settingsRow({ key: 'workMinutes', label: '工作时长（分钟）', hint: '1–180', control: input({ name: 'workMinutes', value: String(minutes('workSeconds')), label: '工作时长（分钟）', type: 'number', disabled: off, attrs: { min: '1', max: '180', step: '1' } }) }),
      settingsRow({ key: 'breakMinutes', label: '短休息（分钟）', hint: '1–60', control: input({ name: 'breakMinutes', value: String(minutes('shortBreakSeconds')), label: '短休息（分钟）', type: 'number', disabled: off, attrs: { min: '1', max: '60', step: '1' } }) }),
      toggle('notificationsEnabled', '到期提醒', '工作或短休息结束时提供到期提示。'),
      toggle('soundEnabled', '提醒声音', '系统允许提醒时，播放提示音。'),
      toggle('showTrayTimer', '菜单栏显示剩余时间', '在 macOS 菜单栏查看当前轮次的计时。'),
      settingsRow({ key: 'tz', label: '统计时区', hint: '首次初始化后固定' + (snapshot.runtime?.largeHistory ? '；专注记录较大，查询可能需要更长时间。' : ''), control: html`${settingsReadout({ text: settings.statisticsTimeZone || '', mono: true })}` }),
    ] })}<p class="px-note" data-key="focus-note">设置只影响新会话。休息需要手动启动，不会自动连续计时。</p>${message ? html`<p class="px-note px-note--error" role="alert" data-key="focus-error">${message}</p>` : ''}${settingsGroup({ title: '系统通知', flush: true, key: 'focus-permission', rows: [
      settingsRow({ key: 'permission', label: '系统提醒权限', hint: permissionError || (delivery ? delivery.message : ''), hintTone: permissionError || delivery ? 'error' : undefined, control: html`${settingsReadout({ text: permissionText(platform, permission, lastKnown) })}` }),
      ...(platform.isNative ? [settingsRow({ key: 'permission-actions', label: '授权与系统设置', hint: permissionDetails || delivery?.details || '', control: permissionActions })] : []),
    ] })}`;
  }
  const paint = () => { morph(element, view()); const syncSwitch = el => { const on = !!(snapshot.settings || {})[el.dataset.name]; el.setAttribute('aria-checked', String(on)); }; element.querySelectorAll('.dl-switch').forEach(syncSwitch); };
  const unsubscribe = controller.subscribe(({ snapshot: next, tick }) => { if (tick) return; snapshot = next; paint(); });
  async function save(name, value) {
    const patch = {};
    if (name === 'workMinutes' || name === 'breakMinutes') {
      const limit = name === 'workMinutes' ? 180 : 60, number = Number(value);
      if (!Number.isInteger(number) || number < 1 || number > limit) { message = `${name === 'workMinutes' ? '工作时长' : '短休息'}需为 1–${limit} 的整数分钟`; return paint(); }
      patch[name === 'workMinutes' ? 'workSeconds' : 'shortBreakSeconds'] = number * 60;
    } else patch[name] = !!value;
    const key = Object.keys(patch)[0]; if (snapshot.settings?.[key] === patch[key]) { message = ''; return paint(); }
    try { await controller.act({ type: 'focus.settings', settings: patch }); message = ''; notify('专注设置已保存'); }
    catch (error) { message = error.message; }
    snapshot = controller.getSnapshot(); paint();
  }
  element.addEventListener('ui:change', event => { const name = event.target.closest('[data-name]')?.dataset.name; if (name) void save(name, event.detail.value); }, { signal: abort.signal });
  async function readPermission(op = 'getStatus', event) {
    if (permissionBusy || (op === 'getStatus' && (!visible || page?.hidden))) return;
    const current = ++generation;
    if (op !== 'getStatus') { permissionBusy = true; paint(); }
    try { const value = await platform[op](event); if (visible && current === generation) { permission = value; lastKnown = false; permissionError = ''; permissionDetails = ''; } }
    catch (error) { if (visible && current === generation) { lastKnown = true; permissionError = focusPermissionError(error, op); permissionDetails = error.message || ''; } }
    finally { if (current === generation && op !== 'getStatus') permissionBusy = false; paint(); }
  }
  const permissionLifecycle = createFocusPermissionRefresh({ readPermission, isVisible: () => visible, document: page, window: host });
  element.addEventListener('click', event => { const control = event.target.closest('[data-focus-setting]'); if (!control || !element.contains(control)) return; void readPermission(control.dataset.focusSetting, event); }, { signal: abort.signal });
  paint(); void readPermission();
  return { element, setVisible(value) { if (visible === value) return; visible = value; if (value) { paint(); void readPermission(); } }, dispose() { visible = false; generation++; permissionLifecycle.dispose(); unsubscribe(); abort.abort(); platform.dispose(); element.remove(); } };
}
