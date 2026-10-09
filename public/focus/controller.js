/** One global poller/ticker. Ticks carry tick:true and never persist state. */
export function createFocusController({ client, getToken, document: page = globalThis.document, window: host = globalThis.window, monotonic = () => performance.now(), uuid = () => crypto.randomUUID(), pollMs = 3000, tickMs = 1000 }) {
  let snapshot = null, receivedAt = 0, disposed = false, busy = false, degraded = false, errorMessage = '', refreshPromise, readAbort, generation = 0, pollTimer, tickTimer, zeroRefresh = null, pending;
  const subscribers = new Set(), events = new AbortController();
  function getSnapshot() {
    if (!snapshot) return { unavailable: true, degraded, connectionError: errorMessage, busy };
    const now = snapshot.serverNow + Math.max(0, monotonic() - receivedAt), current = snapshot.current && { ...snapshot.current };
    if (current?.status === 'running') current.remainingMs = Math.max(0, current.deadlineAt - now);
    return { ...snapshot, current, displayNow: now, degraded, connectionError: errorMessage, busy, unknownRequest: Boolean(pending) };
  }
  function publish(reason, tick = false) { const current = getSnapshot(); for (const subscriber of subscribers) subscriber({ snapshot: current, reason, tick }); }
  function ingest(next, reason) {
    if (snapshot && next.version < snapshot.version) return;
    const previousId = snapshot?.current?.id, nextId = next.current?.id, ended = previousId && previousId !== nextId;
    snapshot = next; receivedAt = monotonic(); degraded = false; errorMessage = '';
    if (next.current?.remainingMs > 0 || previousId !== nextId) zeroRefresh = null;
    publish(ended ? 'terminal' : reason);
  }
  function schedule() { clearTimeout(pollTimer); if (!disposed && !page?.hidden) pollTimer = setTimeout(async () => { await refresh().catch(() => {}); schedule(); }, pollMs); }
  async function refresh() {
    if (disposed) return;
    if (refreshPromise) return refreshPromise;
    const started = generation; readAbort = new AbortController();
    refreshPromise = (async () => {
      try {
        let next;
        try { next = await client.state({ signal: readAbort.signal }); }
        catch (error) {
          if (![401, 403].includes(error.status) || !getToken || disposed || started !== generation) throw error;
          await getToken({ refresh: true });
          next = await client.state({ signal: readAbort.signal });
        }
        if (!disposed && started === generation) ingest(next, 'sync'); return next;
      }
      catch (error) { if (!disposed && started === generation && error.name !== 'AbortError') { degraded = true; errorMessage = error.message; publish('degraded'); } throw error; }
      finally { refreshPromise = null; }
    })();
    return refreshPromise;
  }
  async function submitPending() {
    if (busy || disposed) throw new Error('专注操作正在处理，请稍候');
    busy = true; generation++; readAbort?.abort(); publish('action');
    try { const next = await client.act(pending.body); pending = null; if (!disposed) ingest(next, 'action'); return next; }
    catch (error) {
      if (error.status && error.status < 500) pending = null;
      else { error.unknown = true; error.message = '专注操作结果待核对，请重试原请求'; }
      if ([401, 403, 409].includes(error.status)) { await refresh().catch(() => {}); }
      throw error;
    } finally { busy = false; if (!disposed) publish('action'); }
  }
  async function act(action, { taskVersion } = {}) {
    if (busy || pending) throw new Error(pending ? '上次专注操作结果待核对，请先重试原请求' : '专注操作正在处理，请稍候');
    if (!snapshot || degraded) throw new Error('连接中断，计时状态待核对，请先刷新');
    pending = { body: JSON.stringify({ requestId: uuid(), expectedVersion: snapshot.version, ...(['focus.start', 'focus.switch'].includes(action.type) ? { expectedTaskVersion: taskVersion ?? snapshot.taskVersion } : {}), action }) };
    return submitPending();
  }
  function ticker() {
    clearTimeout(tickTimer); if (disposed || page?.hidden) return;
    tickTimer = setTimeout(() => {
      const value = getSnapshot(); publish('sync', true);
      if (value.current?.status === 'running' && value.current.remainingMs === 0 && zeroRefresh !== value.current.id) { zeroRefresh = value.current.id; void refresh().catch(() => {}); }
      ticker();
    }, tickMs);
  }
  function visible() { if (page?.hidden) { clearTimeout(pollTimer); clearTimeout(tickTimer); } else { void refresh().catch(() => {}); schedule(); ticker(); } }
  page?.addEventListener('visibilitychange', visible, { signal: events.signal }); host?.addEventListener('focus', visible, { signal: events.signal });
  visible();
  return { getSnapshot, subscribe(callback) { subscribers.add(callback); callback({ snapshot: getSnapshot(), reason: 'sync', tick: false }); return () => subscribers.delete(callback); }, refresh, act, retry: () => pending ? submitPending() : Promise.reject(new Error('没有待核对的专注操作')), dispose() { disposed = true; generation++; events.abort(); readAbort?.abort(); clearTimeout(pollTimer); clearTimeout(tickTimer); subscribers.clear(); } };
}
