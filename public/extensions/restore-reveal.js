import { extensionCapability } from './capabilities.js';

// 扩展页「从备份恢复」与「在访达中显示」（0.7 后续项）：纯函数，无 DOM；状态、事件、焦点在 page.js。
// 后端契约：api-contract-skill-enable.md「H. 在访达中显示 / 从备份恢复」（#36）。
// 红线：reveal 的请求体只有 kind + id / clientId，绝不带路径（后端也会拒绝）；恢复点只显示元数据，不显示任何配置内容。

export const revealSupported = capabilities => extensionCapability(capabilities, 'reveal');
export const restoreBackupSupported = capabilities => extensionCapability(capabilities, 'restoreBackup');

// GET /backups?kind=mcpConfig → {kind, version, backups:[{operationId, at, summary, servers}]}；也兼容直接给数组。
// 只保留四个元数据键，别的键（即使后端多给了）一律丢掉，不进 DOM。
export function backupList(result) {
  const list = Array.isArray(result) ? result : Array.isArray(result?.backups) ? result.backups : [];
  return list.filter(item => item && typeof item.operationId === 'string' && item.operationId)
    .map(item => ({ operationId: item.operationId, summary: typeof item.summary === 'string' ? item.summary : '', at: typeof item.at === 'string' ? item.at : '', servers: Number.isInteger(item.servers) && item.servers >= 0 ? item.servers : null }));
}

// 时间按本机时区显示到分钟；读不出来就原样给（不抛错）。
export function backupTime(at, locale = 'zh-CN') {
  const time = Date.parse(at);
  if (!at || Number.isNaN(time)) return String(at || '');
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(time);
}
export const backupMeta = backup => [backupTime(backup.at), backup.servers == null ? '' : `${backup.servers} 个服务`].filter(Boolean).join(' · ');

// 恢复成功后的提示条文案；撤销走 operation.restore（恢复前的内容是该操作的 before 快照）。
export const restoreNoticeText = '已把 MCP 配置恢复到所选恢复点。不是想要的结果，可以撤销，回到恢复前的内容。';

// reveal 请求体：kind 只认三种；缺 id / clientId 返回 null（不发请求）。
export function revealBody(kind, ids = {}) {
  if (kind === 'mcpConfig') return { kind };
  if (kind === 'skill') return ids.id ? { kind, id: String(ids.id) } : null;
  if (kind === 'client') return ids.clientId ? { kind, clientId: String(ids.clientId) } : null;
  return null;
}

// 失败提示：三段式（发生了什么 / 为什么 / 怎么办）。501 的优先级最高（后端先判环境，参数错误也先回 501）。
export function revealErrorMessage(error) {
  const status = Number(error?.status) || 0, code = String(error?.code || '');
  if (status === 501 || code === 'EXTENSIONS_UNSUPPORTED') return '无法在访达中显示：当前环境不支持（只有 macOS 版 Daylight 可以打开访达）。可以改用「复制路径」。';
  if (status === 404 || code === 'EXTENSIONS_OBJECT_MISSING') return '无法在访达中显示：这个位置已经不存在了。请先点「重新扫描」，再试一次。';
  if (code === 'EXTENSIONS_REVEAL_FAILED' || status >= 500) return '无法在访达中显示：访达没有打开。可以改用「复制路径」。';
  if (status === 400 || code === 'EXTENSIONS_INVALID') return '无法在访达中显示：这个位置不在 Daylight 管理的扩展目录里。';
  return '无法在访达中显示：' + (error?.message || '请求没有完成') + '。可以改用「复制路径」。';
}

// 失败后给「复制路径」用的路径（只用页面 state 里已有的字段，不向后端要）。
export function revealFallbackPath(kind, { item, problemPath = '' } = {}) {
  if (kind === 'skill') return item?.sourcePath || '';
  if (kind === 'client') return item?.configPath || item?.skillsRoot || '';
  if (kind === 'mcpConfig') return problemPath || '';
  return '';
}
