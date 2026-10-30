// 扩展页 MCP 部分（0.7 PR-7）：纯函数，无 DOM。状态与事件仍在 page.js。
// 后端契约见 api-contract-skill-enable.md §F（#27）：`mcp.toggle`、`POST /probes {ids, expectedVersion}`、`refStatus`、probe 的 queued/cancelled/stale。
// 约定：这里不接触任何凭据的“值”——后端本来就不返回，前端只看 refStatus.set。

export const isShared = server => !!server && server.scope !== 'client';
// 只有共享来源、带 enabled 布尔的服务才有行级开关（契约 F：客户端本地配置的启停仍走检查器里的按钮）。
export const hasMcpSwitch = server => isShared(server) && typeof server.enabled === 'boolean';

// ---- 状态词汇：点 + 文字永远同时出现（不只靠颜色）----
const PROBE = {
  queued: ['排队中', 'accent'], running: ['正在检测', 'accent'], succeeded: ['握手成功', 'success'],
  failed: ['检测失败', 'danger'], timed_out: ['检测超时', 'danger'], cancelled: ['已取消', 'neutral'],
};
export const finishedProbe = probe => !!probe && !['queued', 'running'].includes(probe.status);
export const activeProbe = probe => !!probe && ['queued', 'running'].includes(probe.status);

// 一个服务现在该显示什么：{ key, label, tone, dot, detail }。detail 是副行（工具数、检测时间由页面拼接）。
export function mcpHealth(server, probe = server?.lastProbe) {
  if (!server) return { key: 'unknown', label: '未知状态', tone: 'neutral', dot: false };
  if (server.enabled === false) return { key: 'disabled', label: '已停用', tone: 'neutral', dot: true };
  if (!isShared(server)) return { key: 'client', label: '用户级配置', tone: 'neutral', dot: false };
  if (!probe) return { key: 'untested', label: '尚未检测', tone: 'neutral', dot: false };
  const known = PROBE[probe.status];
  if (!known) return { key: 'unknown', label: '未知状态', tone: 'neutral', dot: true };
  const [label, tone] = known;
  // 配置变了：旧结果不能再用绿/红点误导
  if (finishedProbe(probe) && (probe.stale || (server.revision && probe.configRevision && probe.configRevision !== server.revision))) return { key: 'stale', label: `配置已变更 · 上次${label}`, tone: 'neutral', dot: true, stale: true };
  return { key: probe.status, label, tone, dot: true };
}
export const toolCountLabel = probe => probe?.status === 'succeeded' && Number.isInteger(probe.toolCount) ? `${probe.toolCount} 个工具` : '';

// ---- 命令 / URL 行（E-20）----
const SECRET_KEY = /key|token|secret|passw(or)?d|auth|credential|bearer/i;
const SECRET_VALUE = /^(sk-|ghp_|gho_|github_pat_|xox[abprs]-|eyJ)|^[A-Za-z0-9_-]{32,}$/;
// 第二道防线：Daylight 本来不存凭据（只存引用），但 args 是自由文本。疑似凭据的值换成「…」。
export function redactArgs(args) {
  const out = []; let hideNext = false;
  for (const raw of Array.isArray(args) ? args : []) {
    const arg = String(raw);
    if (hideNext) { out.push('…'); hideNext = false; continue; }
    const eq = arg.indexOf('=');
    if (arg.startsWith('-') && eq > 0) { const key = arg.slice(0, eq), value = arg.slice(eq + 1); out.push(SECRET_KEY.test(key) || SECRET_VALUE.test(value) ? key + '=…' : arg); continue; }
    if (arg.startsWith('-') && SECRET_KEY.test(arg)) { out.push(arg); hideNext = true; continue; }
    out.push(SECRET_VALUE.test(arg) ? '…' : arg);
  }
  return out;
}
// http：origin + pathname（不带 query / hash / 用户信息）；stdio：命令 + 脱敏后的参数。
export function commandLine(server) {
  if (!server) return '';
  if (server.transport === 'http' || (!server.command && server.url)) {
    try { const url = new URL(server.url); return url.origin + (url.pathname === '/' ? '' : url.pathname); } catch { return ''; }
  }
  return [server.command, ...redactArgs(server.args)].filter(Boolean).join(' ');
}

// ---- 环境变量 / 请求头引用（E-23）----
export const refStatusLabels = { set: '已设置', unset: '未设置', internal: '内部凭据', unknown: '无法检测' };
export const refHints = {
  unset: 'Daylight 未检测到该环境变量',
  internal: 'Daylight 内部凭据，检测会拒绝；请改用其他变量',
  unknown: '由该软件读取，Daylight 无法检测',
};
export const refNote = 'Daylight 只检查变量是否存在，不读取、不显示值；从 Finder 启动的 App 可能比终端里的变量少。';
// 旧后端没有 refStatus 时返回 null，由页面回退成引用名列表。
export function refRows(server) {
  if (!server || !Array.isArray(server.refStatus)) return null;
  return server.refStatus.map(item => ({
    kind: item.kind === 'header' ? 'header' : 'env', key: String(item.key ?? ''), ref: String(item.ref ?? ''),
    purpose: (item.kind === 'header' ? '请求头 ' : '环境变量 ') + String(item.key ?? ''),
    status: !isShared(server) ? 'unknown' : item.internal ? 'internal' : item.set ? 'set' : 'unset',
  }));
}
// 行里的徽标：「缺 2 个变量」/「含内部凭据引用」；全部就绪或没有引用就没有徽标。
export function refBadge(server) {
  const rows = refRows(server)?.filter(row => row.status !== 'unknown') || [];
  const internal = rows.filter(row => row.status === 'internal').length, missing = rows.filter(row => row.status === 'unset').length;
  if (internal) return { label: '含内部凭据引用', tone: 'warning' };
  if (missing) return { label: `缺 ${missing} 个变量`, tone: 'warning' };
  return null;
}

// ---- 检测结果卡片 ----
const adviceText = {
  command: '检查命令是否已安装、是否在 PATH 里（从 Finder 启动的 App 的 PATH 可能比终端短）。',
  auth: '服务要求授权：检查环境变量引用对应的变量是否正确、是否有权限。',
  timeout: '确认服务能够启动、地址可以连通，然后重新检测。',
  generic: '检查配置与服务状态后重新检测；「让 AI 诊断或修改」可以帮忙看配置。',
};
export function adviceFor(probe, server) {
  if (!probe || !['failed', 'timed_out'].includes(probe.status)) return '';
  const rows = refRows(server) || [], missing = rows.filter(row => row.status === 'unset').map(row => row.ref), internal = rows.filter(row => row.status === 'internal').map(row => row.ref);
  if (internal.length && /内部|私有|private/i.test(probe.message || '')) return `引用了 Daylight 内部凭据（${internal.join('、')}）：换用其他变量。`;
  if (missing.length) return `在启动 Daylight 的环境里设置 ${missing.join('、')} 后重新检测。`;
  const message = probe.message || '';
  if (message.includes('找不到可执行命令')) return adviceText.command;
  if (message.includes('授权')) return adviceText.auth;
  if (probe.status === 'timed_out') return adviceText.timeout;
  return adviceText.generic;
}
// 卡片内容。tools 只取前 8 个名字（折叠展示），其余给出总数。
export function probeCard(probe, server) {
  if (!probe) return null;
  const health = mcpHealth({ ...server, enabled: true }, probe), tools = Array.isArray(probe.tools) ? probe.tools.map(tool => String(tool?.name ?? '')).filter(Boolean) : [];
  return {
    key: health.key, label: health.label, tone: health.tone, stale: !!health.stale, status: probe.status,
    cancellable: activeProbe(probe), message: probe.message || '', advice: adviceFor(probe, server),
    toolCount: Number.isInteger(probe.toolCount) ? probe.toolCount : null, tools: tools.slice(0, 8), moreTools: Math.max(0, (Number.isInteger(probe.toolCount) ? probe.toolCount : tools.length) - 8),
    version: probe.serverVersion ? String(probe.serverVersion) : '', protocol: probe.protocolVersion ? String(probe.protocolVersion) : '',
  };
}

// ---- 检测全部服务 ----
// 对象 = 当前可见的共享服务；已停用的单列为“不检测”；客户端本地配置不检测（后端没有对应入口）。
export function probeAllPlan(visibleServers) {
  const shared = (visibleServers || []).filter(isShared);
  return { targets: shared.filter(server => server.enabled !== false), skipped: shared.filter(server => server.enabled === false), clientLocal: (visibleServers || []).length - shared.length };
}
export function progressOf(probes) {
  const list = [...probes], count = status => list.filter(probe => probe.status === status).length;
  const queued = count('queued'), running = count('running');
  return { total: list.length, queued, running, active: queued + running, done: list.length - queued - running, succeeded: count('succeeded'), failed: count('failed') + count('timed_out'), cancelled: count('cancelled') };
}
export const progressText = progress => `检测中：完成 ${progress.done} / ${progress.total}${progress.queued ? ` · 排队 ${progress.queued}` : ''}`;
export const finishText = progress => `检测完成：成功 ${progress.succeeded}，失败 ${progress.failed}${progress.cancelled ? `，已取消 ${progress.cancelled}` : ''}`;

// 后端错误 → 一句人话（按 code）。没有认识的 code 就原样用后端消息。
export function mcpErrorMessage(error, name = '') {
  const quoted = name ? `「${name}」` : '该服务';
  switch (error?.code) {
    case 'EXTENSIONS_ALREADY_ENABLED': return `${quoted}已经是启用状态，已刷新。`;
    case 'EXTENSIONS_ALREADY_DISABLED': return `${quoted}已经是停用状态，已刷新。`;
    case 'EXTENSIONS_PROBE_BUSY': return error.message || '最多同时检测两个 MCP 服务，请等待或取消现有检测。';
    default: return error?.message || '操作没有完成';
  }
}
// 409 都意味着页面上的数据已过时（已是目标状态 / 配置版本变了 / 检测队列满）：出错后重新读取一次。
export const shouldRefresh = error => error?.status === 409;
export const disabledProbeHint = (enabled, stagedEnable) => enabled ? '' : stagedEnable ? '启用待应用，应用后才能检测' : '已停用，启用后可检测';
