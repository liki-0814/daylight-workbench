// 原生「选择文件夹」桥接适配层（0.7 PR-8）。页面只依赖这个模块，不直接碰 window.webkit。
//
// 协议（api-contract-skill-enable.md §K；原生端在 feat/0.7-native-folder-picker 5b51523 / #44，Swift 尚未编译，未在真机验证）：
//   检测  window.webkit?.messageHandlers?.pickFolder
//   请求  pickFolder.postMessage({ requestId })        —— requestId 匹配 ^[a-zA-Z0-9_-]{8,100}$，不能带别的键
//   应答  window 上的 CustomEvent('daylight-folder-picked')，detail 三选一：
//           { requestId, ok: true, path } | { requestId, ok: false, cancelled: true } | { requestId, ok: false, error }
//   只处理 requestId 相同的应答；面板已打开时再发请求会立刻返回 error，所以进行中不重复发；
//   格式不对的请求会被静默丢弃，所以必须有超时（至少 5 分钟）。
// TODO(Jevis/原生端)：真机验证后，如消息名、payload、事件名有改动，只改本文件顶部的常量和 postMessage / 解析两处。
// 拿到的 path 只是填进路径框；是否合法仍以后端 skill.import 的校验为准。

export const FOLDER_PICKER_HANDLER = 'pickFolder';
export const FOLDER_PICKED_EVENT = 'daylight-folder-picked';
export const FOLDER_REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{8,100}$/;
export const FOLDER_PICK_TIMEOUT_MS = 5 * 60 * 1000;   // 契约要求「至少 5 分钟」；不要调小

export const FOLDER_PICK_MESSAGES = Object.freeze({
  error: '没能打开选择文件夹的窗口。可以再试一次，或直接在下面输入文件夹的完整路径。',
  timeout: '等了太久，没有收到选择结果。可以再试一次，或直接在下面输入文件夹的完整路径。',
  invalid: '选择文件夹时返回了无法使用的结果。可以再试一次，或直接在下面输入文件夹的完整路径。',
});

const handlerOf = win => win?.webkit?.messageHandlers?.[FOLDER_PICKER_HANDLER];
// 只有桥接真的存在才显示「选择文件夹…」；launcher 面板和普通浏览器里没有，页面回退到手输路径。
export const folderPickerAvailable = (win = globalThis.window) => typeof handlerOf(win)?.postMessage === 'function';

export function makeRequestId(cryptoImpl = globalThis.crypto) {
  const id = `pick-${typeof cryptoImpl?.randomUUID === 'function' ? cryptoImpl.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`}`;
  return FOLDER_REQUEST_ID_PATTERN.test(id) ? id : `pick-${Date.now().toString(36)}-${'0'.repeat(8)}`;
}

// 返回 { status }：'picked'（带 path）| 'cancelled'（不是错误）| 'error'（带 message）| 'timeout'（带 message）| 'unavailable' | 'busy'。
// 永不 reject；监听器和定时器在每条路径上都会清掉。
export function createFolderPicker({ win = globalThis.window, timeoutMs = FOLDER_PICK_TIMEOUT_MS, makeId = makeRequestId, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let pending = false;
  const pick = () => new Promise(resolve => {
    if (pending) { resolve({ status: 'busy' }); return; }              // 进行中不重复发请求（原生端会立刻回 error）
    const handler = handlerOf(win);
    if (typeof handler?.postMessage !== 'function') { resolve({ status: 'unavailable' }); return; }
    const requestId = makeId();
    let timer = null;
    const finish = result => { pending = false; clearTimer(timer); win.removeEventListener(FOLDER_PICKED_EVENT, onPicked); resolve(result); };
    function onPicked(event) {
      const detail = event?.detail;
      if (!detail || typeof detail !== 'object' || detail.requestId !== requestId) return;   // 别的请求的应答：忽略
      if (detail.ok === true) {
        if (typeof detail.path === 'string' && detail.path.trim()) finish({ status: 'picked', path: detail.path });
        else finish({ status: 'error', message: FOLDER_PICK_MESSAGES.invalid });
      } else if (detail.cancelled === true) finish({ status: 'cancelled' });             // 取消不报错
      else finish({ status: 'error', message: FOLDER_PICK_MESSAGES.error });             // 原生端的 error 文字不直接展示
    }
    pending = true;
    win.addEventListener(FOLDER_PICKED_EVENT, onPicked);
    timer = setTimer(() => finish({ status: 'timeout', message: FOLDER_PICK_MESSAGES.timeout }), timeoutMs);
    try { handler.postMessage({ requestId }); }
    catch { finish({ status: 'error', message: FOLDER_PICK_MESSAGES.error }); }
  });
  return { pick, get pending() { return pending; } };
}
