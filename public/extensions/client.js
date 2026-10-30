export function createExtensionsClient({ getToken, fetchImpl = fetch }) {
  async function request(route, input, options = {}) {
    const response = await fetchImpl('/api/extensions' + route, { method: options.method || (input === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': getToken() }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), ...(options.signal ? { signal: options.signal } : {}) });
    let value; try { value = await response.json(); } catch { throw new Error('扩展服务响应无法读取，请核对原请求'); }
    if (!response.ok) throw Object.assign(new Error(value.error || '扩展请求失败'), value, { status: response.status });
    return value;
  }
  return { state: signal => request('/state', undefined, { signal }), refresh: signal => request('/refresh', {}, { signal }), detail: (id, file, kind) => request('/objects/' + encodeURIComponent(id) + (file || kind ? '?' + new URLSearchParams({ ...(file ? { file } : {}), ...(kind ? { kind } : {}) }) : '')), prepare: action => request('/prepare', { action }), apply: requestBody => request('/actions', requestBody), reveal: body => request('/reveal', body), backups: kind => request('/backups?' + new URLSearchParams({ kind })), operation: id => request('/operations/' + encodeURIComponent(id)), probe: id => request('/probes/' + encodeURIComponent(id)), cancelProbe: id => request('/probes/' + encodeURIComponent(id), undefined, { method: 'DELETE' }), probeAll: (ids, expectedVersion) => request('/probes', { ids, expectedVersion }) };
}
