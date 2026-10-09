const replyEvent = 'daylight-focus-notification-reply';
export function createFocusPlatform({ window: host = globalThis.window, uuid = () => crypto.randomUUID(), timeouts = { getStatus: 5000, openSettings: 5000, authorize: 120000 } } = {}) {
  const native = host?.webkit?.messageHandlers?.focusNotifications, pending = new Map(); let disposed = false;
  const fallback = { permission: 'unavailable', alertEnabled: null, soundEnabled: null, mode: 'page-only' };
  function reply(event) {
    const data = event.detail; if (!data || typeof data !== 'object' || typeof data.requestId !== 'string') return;
    const request = pending.get(data.requestId); if (!request) return;
    if (typeof data.ok !== 'boolean' || !['default', 'granted', 'denied', 'unavailable'].includes(data.permission) || ![true, false, null].includes(data.alertEnabled) || ![true, false, null].includes(data.soundEnabled)) return;
    clearTimeout(request.timer); pending.delete(data.requestId);
    data.ok ? request.resolve(data) : request.reject(new Error(data.error || '系统提醒操作失败'));
  }
  host?.addEventListener(replyEvent, reply);
  function call(op, event) {
    if (disposed) return Promise.reject(new Error('提醒设置已关闭'));
    if (op !== 'getStatus' && !event?.isTrusted) return Promise.reject(new Error('请点击按钮开启或设置系统提醒'));
    if (!native) return Promise.resolve(fallback);
    const requestId = uuid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(Object.assign(new Error(op === 'authorize' ? '授权结果待核对，请刷新权限状态' : '系统提醒请求超时，请重试'), { unknown: true })); }, timeouts[op]);
      pending.set(requestId, { resolve, reject, timer });
      try { native.postMessage({ requestId, op }); } catch (error) { clearTimeout(timer); pending.delete(requestId); reject(error); }
    });
  }
  return { isNative: Boolean(native), getStatus: () => call('getStatus'), authorize: event => call('authorize', event), openSettings: event => call('openSettings', event), dispose() { disposed = true; host?.removeEventListener(replyEvent, reply); for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('提醒设置已关闭')); } pending.clear(); } };
}
