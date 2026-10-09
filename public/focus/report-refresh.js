export function createReportRefresh({ controller, refresh, visible = true, getKey = snapshot => snapshot.version, matchesCurrent = () => true, onChange = () => {}, onHide = () => {}, document: page = globalThis.document, setTimeout: later = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout }) {
  let timer, disposed = false, initialized = false, lastKey; const events = new AbortController();
  const isVisible = () => visible && !page?.hidden && !disposed;
  function clearTimer() { if (timer !== undefined) cancel(timer); timer = undefined; }
  function schedule(snapshot = controller.getSnapshot()) {
    const active = isVisible() && !snapshot.degraded && snapshot.current?.phase === 'work' && snapshot.current?.status === 'running' && matchesCurrent(snapshot.current);
    if (!active) clearTimer();
    else if (timer === undefined) timer = later(async () => { timer = undefined; if (isVisible()) await refresh(); if (!disposed) schedule(); }, 15000);
  }
  const unsubscribe = controller.subscribe(({ snapshot, tick }) => {
    if (!tick) {
      const key = getKey(snapshot);
      if (!initialized || key !== lastKey) { const previousKey = lastKey; initialized = true; lastKey = key; onChange(snapshot, previousKey); if (isVisible()) void refresh(); }
    }
    schedule(snapshot);
  });
  page?.addEventListener('visibilitychange', () => { if (isVisible()) void refresh(); else onHide(); schedule(); }, { signal: events.signal });
  return {
    setVisible(value) { if (visible === value || disposed) return; visible = value; if (isVisible()) void refresh(); else onHide(); schedule(); },
    dispose() { disposed = true; unsubscribe(); events.abort(); clearTimer(); }
  };
}
