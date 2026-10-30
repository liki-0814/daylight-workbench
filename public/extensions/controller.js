export function createExtensionsController({ client, storage = globalThis.localStorage, onChanged = () => {} }) {
  let snapshot, failure, visible = false, loading = false, request, timer, submission, storageKey, applying = false, cancelRequested = false, cancelled = false;
  const listeners = new Set(), drafts = new Map();
  // cancellable：只有「读取」能被取消；提交后的刷新（applying）不能，否则界面会停在旧数据上而服务端已变。cancelled：最近一次读取被用户取消（下一次读取开始时清除）。
  const emit = () => listeners.forEach(listener => listener({ snapshot, failure, loading, submission, cancelled, cancellable: loading && !applying }));
  function persist() { if (storageKey) storage?.setItem(storageKey, JSON.stringify(submission)); }
  async function refresh(force = false) {
    if (loading) return;
    const failureBefore = failure;
    loading = true; failure = null; cancelled = false; cancelRequested = false; request = new AbortController(); emit();
    try {
      // 先放进局部变量，成功才替换 snapshot：取消或失败都不会留下半截数据（0.7 PR-6，加载超过 1 秒可取消）。
      const next = await (force ? client.refresh(request.signal) : client.state(request.signal));
      if (cancelRequested) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });   // 就算请求没响应 abort，晚到的数据也不能写进来
      snapshot = next;
      const key = 'daylight:extensions:submission:' + snapshot.root;
      if (storageKey !== key) { storageKey = key; try { submission = JSON.parse(storage?.getItem(key) || 'null'); } catch { submission = null; } }
    } catch (error) { if (error.name !== 'AbortError') failure = error; else if (cancelRequested) { cancelled = true; failure = failureBefore; } }   // 取消 = 回到读取前：旧失败提示也原样恢复
    finally { loading = false; request = null; cancelRequested = false; emit(); }
  }
  // 用户取消读取：只在读取中、且不是提交后的刷新时有效；返回是否真的取消了。回到读取前的状态（snapshot / failure 不变），由页面显示「已取消」和「重试」。
  function cancel() {
    if (!loading || applying || !request) return false;
    cancelRequested = true; request.abort(); return true;
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
  return { subscribe(listener) { listeners.add(listener); emit(); return () => listeners.delete(listener); }, refresh, submit, retry, cancel, getSnapshot: () => snapshot,
    getSubmission: () => submission, clearSubmission() { if (submission && ['submitted', 'unknown'].includes(submission.status)) throw new Error('请先核对结果未知的原请求'); submission = null; persist(); emit(); },
    drafts, setVisible(value) { visible = value; clearInterval(timer); if (!value) request?.abort(); else { void refresh(); timer = setInterval(() => { if (visible && !document.hidden && !cancelled) void refresh(true); }, 10000); }   // 已取消时 timer 不自动重读，等用户点「重试」或重新扫描
    },
    dispose() { visible = false; clearInterval(timer); request?.abort(); listeners.clear(); } };
}

// ================= 表单校验与文案（0.7 PR-1）：纯函数，无 DOM 依赖；新文件须登记 core/web-assets.json（打包相关，本 PR 不动），所以并入本模块 =================

export const skillDirectoryPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const sharedIdPattern = /^[a-zA-Z0-9_-]{1,80}$/;
const reservedIds = ['codex', 'qoder', 'pi'];

export function skillDirectoryError(value) {
  if (!value) return '请填写 Skill 名称。';
  if (skillDirectoryPattern.test(value)) return '';
  if (value.length > 64) return 'Skill 名称最多 64 个字符。';
  if (/^-/.test(value)) return 'Skill 名称不能以短横线开头。';
  return 'Skill 名称只能使用小写字母、数字和短横线，例如 review-code。';
}

// native=true：软件本地配置里的键，只限长度和换行；否则是共享来源里的稳定 ID。
export function mcpIdError(value, { native = false } = {}) {
  if (!value) return '请填写稳定 ID。';
  if (native) return value.length > 200 || /[\r\n\0]/.test(value) ? 'ID 需为 1–200 个字符且不含换行。' : '';
  if (!sharedIdPattern.test(value)) return value.length > 80 ? 'ID 最多 80 个字符。' : 'ID 只能使用字母、数字、下划线和短横线。';
  if (/^(skill_|client_)/.test(value) || reservedIds.includes(value)) return '该 ID 是保留名称，请换一个。';
  return '';
}

// 同一保存位置下已存在的服务（新建时才检查；编辑自己不算重复）。
export function findDuplicateServer(servers, { id, clientId = '' }) {
  if (!id || !Array.isArray(servers)) return null;
  return servers.find(server => clientId ? server.scope === 'client' && server.clientId === clientId && (server.serverKey || server.id) === id : server.scope !== 'client' && server.id === id) || null;
}

const loopback = hostname => ['localhost', '127.0.0.1', '[::1]'].includes(hostname) || hostname.endsWith('.localhost');
export function parseHttpUrl(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url : null; } catch { return null; } }
export function mcpUrlError(value) {
  if (!value) return '请填写 HTTP 端点。';
  const url = parseHttpUrl(value);
  if (!url) return '请填写以 http:// 或 https:// 开头的完整地址。';
  if (url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => /token|key|secret|password|auth/i.test(key))) return 'URL 不能包含凭据；请通过请求头环境变量引用。';
  return '';
}
// 明文 http:// 且不是本机地址：请求头（可能含凭据）会未加密传输。仍允许保存，只给出警告。
export function insecureHttpWarning(value, { hasHeaders = false } = {}) {
  const url = typeof value === 'string' ? parseHttpUrl(value) : null;
  if (url?.protocol !== 'http:' || loopback(url.hostname)) return '';
  return hasHeaders ? '该地址使用明文 http://，所引用的请求头（可能含凭据）会未加密传输；建议改用 https://。' : '该地址使用明文 http://，通信内容未加密；建议改用 https://。';
}

// 把服务端 field（如 server.id、directory、content）映射到表单控件名。
const fieldAliases = { content: 'description' };
export function fieldInputName(field) {
  if (typeof field !== 'string' || !field) return null;
  const name = field.replace(/^(server|client)\./, '');
  return fieldAliases[name] || name;
}

// ---- 诊断：按分类过滤 ----
const diagnosticTabs = { MCP_FORMAT: 'mcp', CLIENT_MCP_FORMAT: 'mcp', ENV_MISSING: 'mcp', CLIENTS_FORMAT: 'clients' };
export const diagnosticTab = problem => problem?.tab || diagnosticTabs[problem?.code] || 'skills';
export const diagnosticsForTab = (diagnostics, tab) => (diagnostics || []).filter(problem => diagnosticTab(problem) === tab);
// 共享 MCP 配置损坏的说明；坏文件的位置来自 MCP_FORMAT 诊断（有行列就带上）。
export function corruptMcpConfig(state) {
  if (!state || state.mcpValid !== false) return null;
  const problem = (state.diagnostics || []).find(item => item.code === 'MCP_FORMAT') || {};
  const where = problem.path ? problem.path + (problem.line ? `，第 ${problem.line} 行${problem.column ? ` 第 ${problem.column} 列` : ''}` : '') : '';
  return { problem, where, reason: problem.reason || '' };
}

// ---- 详情读取失败：按对象类型给文案（E-07）----
const readFailures = { skill: '无法读取 Skill 详情', mcp: '无法读取 MCP 服务详情', client: '无法读取软件详情' };
export const tabKinds = { skills: 'skill', mcp: 'mcp', clients: 'client' };
export function detailErrorMessage(error, { tab, operation = false, mcpValid = true } = {}) {
  const missing = error?.status === 404 || error?.code === 'EXTENSIONS_OBJECT_MISSING';
  if (operation) return missing ? '找不到这条操作回执，它可能已被清理。' : '无法读取操作回执：' + (error?.message || '未知错误');
  const kind = error?.kind || tabKinds[tab] || null;
  if (missing) {
    if (kind === 'mcp') return mcpValid === false ? 'MCP 主配置当前无法读取，所以找不到这个服务。请先修复配置文件，再重新扫描。' : '这个 MCP 服务已归档或不存在。若刚修改过配置文件，请重新扫描后再试。';
    if (kind === 'client') return '这个软件已不在列表中，可能已移除登记。请返回清单重新选择。';
    return '这个 Skill 已归档、移动或不存在。请返回清单重新选择。';
  }
  return `${readFailures[kind] || '无法读取扩展详情'}：${error?.message || '未知错误'}`;
}

// ---- 引用表（环境变量 / 请求头）逐行校验，规则与服务端 mcp-server.mjs 一致 ----
export function refsError(text, label = '环境变量引用') {
  for (const line of String(text || '').split('\n').filter(line => line.trim())) {
    const at = line.indexOf('=');
    if (at < 1) return `${label}每行填写 名称=环境变量名。`;
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,100}$/.test(line.slice(0, at).trim())) return `“${line.slice(0, at).trim().slice(0, 40)}”不是有效的名称：只能含字母、数字、下划线和短横线，且不以数字开头。`;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,100}$/.test(line.slice(at + 1).trim())) return `“${line.slice(at + 1).trim().slice(0, 40)}”不是有效的环境变量名：只能含字母、数字和下划线，且不以数字开头。凭据请只填变量名，不要填值。`;
  }
  return '';
}

// ---- 整表校验：返回 [{ name, message, duplicate? }]，按表单自上而下排序，空数组表示通过 ----
const blank = value => typeof value !== 'string' || !value.trim();
export function validateExtensionForm({ kind, creating = false, values = {}, servers = [] }) {
  const errors = [], add = (name, message, extra = {}) => errors.push({ name, message, ...extra });
  if (kind === 'mcp') {
    const clientId = values.clientId || '';
    if (creating) {
      const message = mcpIdError(values.id || '', { native: !!clientId });
      const duplicate = !message && findDuplicateServer(servers, { id: values.id, clientId });
      if (message) add('id', message); else if (duplicate) add('id', duplicateMessage(duplicate), { duplicate });
    }
    if (blank(values.name)) add('name', '请填写服务名称。'); else if (values.name.length > 200) add('name', '服务名称最多 200 个字符。');
    if (values.transport === 'http') {
      const message = mcpUrlError((values.url || '').trim()); if (message) add('url', message);
      const refs = refsError(values.headerRefs, '请求头引用'); if (refs) add('headerRefs', refs);
    } else {
      if (blank(values.command)) add('command', '请填写可执行命令，例如 node 或绝对路径。');
      else if (/[\r\n\0]/.test(values.command) || values.command.length > 2000) add('command', '命令不能含换行，且不超过 2000 个字符。');
      if (values.cwd && !/^\//.test(values.cwd.trim())) add('cwd', '工作目录需要绝对路径，例如 /Users/名字/项目。');
      const refs = refsError(values.envRefs); if (refs) add('envRefs', refs);
    }
  } else if (kind === 'skill-create') {
    const message = skillDirectoryError(values.directory || ''); if (message) add('directory', message);
    if (blank(values.description)) add('description', '请填写用途说明，说明什么时候使用这个 Skill。');
  } else if (kind === 'skill-edit') {
    if (blank(values.content)) add('content', 'SKILL.md 内容不能为空。');
  } else if (kind === 'client') {
    for (const [name, label] of [['name', '软件名称'], ['command', 'CLI 命令'], ['root', '软件主目录'], ['skillsDirectory', 'Skills 相对目录']]) if (blank(values[name])) add(name, `请填写${label}。`);
  }
  return errors;
}
export const duplicateMessage = existing => `已存在 ID 为 ${existing.serverKey || existing.id} 的 MCP 服务${existing.name ? '（' + existing.name + '）' : ''}。请改用其他 ID，或查看并编辑现有服务。`;
