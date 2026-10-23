// Bounds only the wait for response headers. A live body keeps its own idle timer.
export function headerDeadline(parent, ms = 300000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('上游连接超时'), { name: 'TimeoutError', code: 'ETIMEDOUT' })), ms);
  timer.unref?.();
  return {
    signal: parent ? AbortSignal.any([parent, controller.signal]) : controller.signal,
    settle() { clearTimeout(timer); },
  };
}
