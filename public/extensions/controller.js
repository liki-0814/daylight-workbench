export function createExtensionsController({ client, storage = globalThis.localStorage, onChanged = () => {} }) {
  let snapshot, failure, visible = false, loading = false, request, timer, submission, storageKey, applying = false;
  const listeners = new Set(), drafts = new Map();
  const emit = () => listeners.forEach(listener => listener({ snapshot, failure, loading, submission }));
  function persist() { if (storageKey) storage?.setItem(storageKey, JSON.stringify(submission)); }
  async function refresh(force = false) {
    if (loading) return;
    loading = true; failure = null; request = new AbortController(); emit();
    try {
      snapshot = await (force ? client.refresh(request.signal) : client.state(request.signal));
      const key = 'daylight:extensions:submission:' + snapshot.root;
      if (storageKey !== key) { storageKey = key; try { submission = JSON.parse(storage?.getItem(key) || 'null'); } catch { submission = null; } }
    } catch (error) { if (error.name !== 'AbortError') failure = error; }
    finally { loading = false; request = null; emit(); }
  }
  async function submit(plan) {
    if (!snapshot || !storageKey) throw new Error('请等待来源清单加载完成后保存');
    if (applying) throw new Error('正在提交，请等待结果');
    if (submission && ['submitted', 'unknown'].includes(submission.status)) throw new Error('上次提交结果未知，请先核对原请求');
    submission = { status: 'submitted', request: { requestId: crypto.randomUUID(), expectedVersion: plan.expectedVersion, planId: plan.planId, action: plan.normalizedAction }, plan };
    persist(); emit(); return retry();
  }
  async function retry() {
    if (applying) throw new Error('正在核对原请求，请等待结果');
    if (!submission) throw new Error('没有待核对的扩展请求');
    applying = true;
    const original = submission;
    try {
      const result = await client.apply(original.request); original.status = 'applied'; original.result = result; original.error = null; persist();
      await refresh(true); onChanged({ kind: 'extensions', revision: result.version, changedIds: result.changedIds, operationId: result.operationId }); return result;
    } catch (error) { original.status = error.status >= 400 && error.status < 500 ? 'needs_review' : 'unknown'; original.error = error.message; persist(); emit(); throw error; }
    finally { applying = false; emit(); }
  }
  return { subscribe(listener) { listeners.add(listener); emit(); return () => listeners.delete(listener); }, refresh, submit, retry, getSnapshot: () => snapshot,
    getSubmission: () => submission, clearSubmission() { if (submission && ['submitted', 'unknown'].includes(submission.status)) throw new Error('请先核对结果未知的原请求'); submission = null; persist(); emit(); },
    drafts, setVisible(value) { visible = value; clearInterval(timer); if (!value) request?.abort(); else { void refresh(); timer = setInterval(() => { if (visible && !document.hidden) void refresh(true); }, 10000); } },
    dispose() { visible = false; clearInterval(timer); request?.abort(); listeners.clear(); } };
}
