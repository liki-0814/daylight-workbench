// 反向代理页「状态卡」的纯函数：把服务端状态 + 页面本地的乐观状态映射成 serviceHero 的 props。
// 不碰 DOM，方便单测。四态：running | starting | stopped | error。

export const START_SLOW_MS = 5000; // 启动超过 5 秒才出现「取消」
export const PORT_MIN = 1024, PORT_MAX = 65535;

export const validPort = value => /^\d+$/.test(String(value).trim()) && Number(value) >= PORT_MIN && Number(value) <= PORT_MAX;
export const alternatePort = port => (Number(port) === 4320 ? 4321 : 4320);

export function uptimeText(startedAt, now = Date.now()) {
  const started = Date.parse(startedAt || '');
  if (!Number.isFinite(started)) return '';
  const minutes = Math.max(0, Math.floor((now - started) / 60000));
  if (minutes < 1) return '不到 1 分钟';
  const hours = Math.floor(minutes / 60);
  if (hours < 1) return `${minutes} 分钟`;
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

// 当前显示哪一态。pending 是本页刚发出、服务端还没回的操作（乐观更新，100ms 内给反馈）。
export function viewState(status, pending = '') {
  if (!status) return 'stopped';
  if (pending === 'starting' || status.state === 'starting') return 'starting';
  if (pending === 'stopping' || status.state === 'stopping') return 'stopped';
  if (status.state === 'running') return 'running';
  if (status.runtimeError || status.lastError) return 'error';
  return 'stopped';
}

// 错误三段话：发生了什么 / 为什么 / 怎么办。
export function errorCopy(status) {
  const port = status.port;
  if (status.runtimeError) return { what: '没有可用的 Node 运行环境。', why: String(status.runtimeError), todo: '请在设置里选择 Node 22 或更新版本后重试。' };
  const text = String(status.lastError || '');
  if (/已被占用/.test(text)) return { what: `端口 ${port} 已被占用。`, why: '另一个程序正在使用这个端口。', todo: '换一个端口，或关闭占用它的程序后重试。' };
  if (/请先登录/.test(text)) return { what: '启动失败。', why: text, todo: '登录后点「重试」。' };
  return { what: '启动失败。', why: text || '没有收到具体原因。', todo: '检查模型来源的登录状态与网络，然后点「重试」；「查看日志」里有最近的请求记录。' };
}

// heroProps({ status, pending, slow, sources, today, now, announce })
//   sources: { available, total } | undefined；today: 今日请求数 | undefined（读取失败就不显示，不编造）
export function heroProps({ status, pending = '', slow = false, sources, today, now = Date.now(), announce = '' } = {}) {
  const state = viewState(status, pending);
  const port = status?.port ?? 4319;
  const address = status?.baseUrl || `http://127.0.0.1:${port}/v1`;
  const base = { state, title: '反向代理', announce, switchLabel: '启用反向代理' };
  if (state === 'running') {
    const meta = [];
    const up = uptimeText(status.startedAt, now);
    if (up) meta.push({ label: '已运行', value: up });
    if (Number.isFinite(today)) meta.push({ label: '今日请求', value: Number(today).toLocaleString('zh-CN') });
    if (status.activeRequests) meta.push({ label: '进行中', value: String(status.activeRequests) });
    if (sources && sources.total) meta.push({ label: '来源', value: `${sources.available}/${sources.total} 可用` });
    return { ...base, tagLabel: '运行中', address, meta };
  }
  if (state === 'starting') {
    return { ...base, tagLabel: '启动中…', addressNote: `正在监听 127.0.0.1:${port} …`, note: '通常 1 秒内完成。超过 5 秒会显示「取消」',
      cancel: slow ? { label: '取消', attrs: { 'data-action': 'cancel-start' } } : undefined };
  }
  if (state === 'error') {
    const copy = errorCopy(status);
    return { ...base, tagLabel: '启动失败', error: { ...copy, retry: true, alternate: /已被占用/.test(String(status.lastError || '')) ? alternatePort(port) : null } };
  }
  return { ...base, tagLabel: pending === 'stopping' || status?.state === 'stopping' ? '正在停止…' : '已停用', addressNote: `未在监听 · 启用后地址为 ${address}`, note: '配置保持可读可改，下次启用时生效。' };
}

export function portHint(state) {
  return {
    running: '修改端口会自动重启代理（约 1 秒）',
    starting: '可以继续修改；改动在启动完成后生效',
    stopped: '改动将在下次启用时生效',
    error: '修改后点「重试」',
  }[state] || '';
}
