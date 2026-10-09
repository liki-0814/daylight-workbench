/** One owner for legacy PUT and action undo. Never rebase an unknown action. */
export function createTaskClient({ getSnapshot, getToken, onBusy = () => {}, onCommitted = () => {}, onConflict = () => {}, fetch: request = globalThis.fetch, uuid = () => crypto.randomUUID() }) {
  let taskUndo = null, pending = null, busy = false, disposed = false, generation = 0;
  const invalidateUndo = () => { taskUndo = null; generation++; };
  const errorFor = (response, data) => Object.assign(new Error(data.error || '任务保存失败，请重试'), { status: response.status, code: data.code, ...data });
  async function send(url, options) {
    const response = await request(url, options);
    let data;
    try { data = await response.json(); } catch { throw Object.assign(new Error('任务写入结果未知，请核对后重试原请求'), { unknown: true }); }
    if (!response.ok) throw errorFor(response, data);
    return data;
  }
  async function conflict(error) {
    invalidateUndo();
    try {
      const latest = await send('/api/state', {});
      onCommitted(latest, { source: 'sync', undo: null });
    } catch { /* Preserve the last confirmed snapshot if readback is unavailable. */ }
    onConflict(error);
  }
  async function run(work) {
    if (disposed || busy) throw new Error('任务正在保存，请稍候');
    busy = true; onBusy(true);
    try { return await work(); }
    catch (error) { if (error.status === 409) await conflict(error); throw error; }
    finally { busy = false; if (!disposed) onBusy(false); }
  }
  function committed(result, undo, source) {
    taskUndo = undo;
    generation++;
    onCommitted(result, { source, undo: taskUndo });
    return result;
  }
  async function saveState(state, { allowUndo = true } = {}) {
    if (pending) throw new Error('上次日历操作结果待核对，请先重试原请求');
    return run(async () => {
      const before = getSnapshot(), saved = structuredClone(before.state);
      try {
        const result = await send('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': getToken(), 'If-Match': String(before.version) }, body: JSON.stringify(state) });
        return committed(result, allowUndo ? { kind: 'snapshot', version: result.version, state: saved } : null, 'put');
      } catch (error) {
        if (!error.status || error.status >= 500) {
          invalidateUndo();
          try { onCommitted(await send('/api/state', {}), { source: 'sync', undo: null }); } catch { /* A PUT has no replay receipt. */ }
          error.message = '保存结果待核对，已尝试读取最新任务；请检查修改后再操作';
        }
        throw error;
      }
    });
  }
  async function applyPending() {
    const operation = pending;
    return run(async () => {
      try {
        const result = await send('/api/task-actions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': getToken() }, body: operation.body });
        pending = null;
        const canUndo = operation.allowUndo && result.version === result.appliedVersion && generation === operation.generation;
        return committed(result, canUndo ? { kind: 'server', version: result.appliedVersion } : null, operation.source);
      } catch (error) {
        if (error.status && error.status < 500) pending = null;
        else { error.unknown = true; error.message = '日历操作结果待核对，请重试原请求'; }
        throw error;
      }
    });
  }
  async function act(action, { day, allowUndo = true } = {}) {
    if (disposed || busy) throw new Error(disposed ? '任务客户端已关闭' : '任务正在保存，请稍候');
    if (pending) throw new Error('上次日历操作结果待核对，请先重试原请求');
    const snapshot = getSnapshot();
    pending = { body: JSON.stringify({ requestId: uuid(), expectedVersion: snapshot.version, ...(day ? { day } : {}), action }), generation, allowUndo, source: action.type === 'undo' ? 'undo' : 'action' };
    return applyPending();
  }
  async function undo() {
    const operation = taskUndo;
    if (!operation || getSnapshot().version !== operation.version) { invalidateUndo(); throw new Error('任务已变化，上一次撤销已失效'); }
    if (operation.kind === 'snapshot') return saveState(operation.state, { allowUndo: false });
    return act({ type: 'undo' }, { allowUndo: false });
  }
  return { saveState, act, undo, invalidateUndo, getUndo: () => taskUndo, getPending: () => pending && JSON.parse(pending.body), retry: () => pending ? applyPending() : Promise.reject(new Error('没有待核对操作')), dispose() { disposed = true; taskUndo = null; } };
}
