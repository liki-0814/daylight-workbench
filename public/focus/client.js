export function createFocusClient({ getToken, fetch: request = globalThis.fetch, timeoutMs = 10000 }) {
  async function call(path, { body, signal, method = body ? 'POST' : 'GET' } = {}) {
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), timeoutMs);
    const cancel = () => abort.abort(); signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) abort.abort();
    try {
      const response = await request('/api/focus/' + path, { method, headers: { 'X-Workbench-Token': getToken(), ...(body ? { 'Content-Type': 'application/json' } : {}) }, signal: abort.signal, ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
      let data; try { data = await response.json(); } catch { throw Object.assign(new Error('服务返回了无法解析的专注结果'), { unknown: method === 'POST' }); }
      if (!response.ok) throw Object.assign(new Error(data.error || '专注服务暂时不可用'), { status: response.status, ...data });
      return data;
    } catch (error) { if (error.name === 'AbortError') throw Object.assign(new Error('专注请求超时或已取消，结果待核对'), { name: 'AbortError', unknown: method === 'POST' }); throw error; }
    finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
  }
  const query = (params = {}) => { const search = new URLSearchParams(); for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined && value !== '') search.set(key, String(value)); return search.size ? '?' + search : ''; };
  return { state: options => call('state', options), act: (body, options = {}) => call('actions', { ...options, body }), prepare: (action, options = {}) => call('prepare', { ...options, body: { action } }), statistics: (params, options = {}) => call('statistics' + query(params), options), sessions: (params, options = {}) => call('sessions' + query(params), options), taskSummary: (taskId, options = {}) => call('task-summary' + query({ taskId, recentLimit: 5 }), options), export: options => call('export', options) };
}
