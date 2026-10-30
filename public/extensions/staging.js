// 扩展页「暂存变更」（0.7 PR-6）：纯函数，无 DOM。状态与事件仍在 page.js。
// 暂存 = 开关只记下“想要的值”，不弹窗、不请求；底部栏出现后，一次预览覆盖所有暂存项（方案 §4.1，E-09 / E-10）。
//   总开关：{ kind: 'skill', id, want }            → skill.enable / skill.disable
//   接入开关：{ kind: 'binding', id, clientId, want } → binding.connect / binding.disconnect
//   MCP 开关：{ kind: 'mcp', id, want }               → mcp.toggle（0.7 PR-7；只改 enabled，不启动也不停止服务）
// 后端没有批量动作，所以“应用”由 page.js 逐项提交（见计划 §3.1）；这里只负责数据与文案。

import { hasMcpSwitch } from './mcp.js';

export const connectedState = state => ['managed', 'existing'].includes(state);
export const stageKey = change => change.kind === 'skill' ? `skill:${change.id}` : change.kind === 'mcp' ? `mcp:${change.id}` : `binding:${change.id}:${change.clientId}`;

// 只有共享来源且非只读的 Skill 才有总开关（契约 B：其余行 enabled 恒为 true、不可停用）。后端没有 enabled 字段（旧服务）也不显示。
export const hasMasterSwitch = skill => !!skill && skill.scope === 'shared' && !skill.readOnly && typeof skill.enabled === 'boolean';
export const skillEnabled = skill => skill?.enabled !== false;   // 缺字段按已启用处理
export const rememberedIds = skill => Array.isArray(skill?.rememberedClientIds) ? skill.rememberedClientIds : [];

function actualFor(change, state) {
  if (change.kind === 'mcp') { const server = state?.servers?.find(item => item.id === change.id); return hasMcpSwitch(server) ? server.enabled : undefined; }
  const skill = state?.skills?.find(item => item.id === change.id);
  if (!skill) return undefined;
  if (change.kind === 'skill') return hasMasterSwitch(skill) ? skillEnabled(skill) : undefined;
  const binding = skill.bindings?.find(item => item.clientId === change.clientId);
  return binding ? connectedState(binding.state) : undefined;
}

// 点一下开关：想要的值与实际值相同就撤销暂存，否则记下。返回新 Map（不改入参）。
export function stageChange(staged, change, state) {
  const next = new Map(staged), actual = actualFor(change, state), key = stageKey(change);
  if (actual === undefined || change.want === actual) next.delete(key); else next.set(key, { ...change });
  return next;
}
export const stagedValue = (staged, change, fallback) => staged.has(stageKey(change)) ? staged.get(stageKey(change)).want : fallback;

// 同一个 Skill 不能同时暂存总开关和接入变更：返回当前占用的是哪一类（'skill' | 'binding' | null）。
export function stagedKindFor(staged, skillId) {
  let kind = null;
  for (const change of staged.values()) if (change.kind !== 'mcp' && change.id === skillId) { if (change.kind === 'skill') return 'skill'; kind = 'binding'; }
  return kind;
}

// 刷新之后：暂存值已等于实际值、对象或软件消失、停用后不能接入、冲突位置，都自动移除。返回 { staged, dropped }。
export function pruneStaged(staged, state) {
  const next = new Map(); let dropped = 0;
  for (const [key, change] of staged) {
    const actual = actualFor(change, state), skill = state?.skills?.find(item => item.id === change.id);
    const blocked = change.kind === 'binding' && change.want && skill && !skillEnabled(skill) || change.kind === 'binding' && skill?.bindings?.find(item => item.clientId === change.clientId)?.state === 'conflict';
    if (actual === undefined || actual === change.want || blocked) dropped++; else next.set(key, change);
  }
  return { staged: dropped ? next : staged, dropped };
}

export function actionFor(change, state) {
  if (change.kind === 'mcp') return { type: 'mcp.toggle', id: change.id, enabled: change.want };
  if (change.kind === 'skill') return { type: change.want ? 'skill.enable' : 'skill.disable', id: change.id };
  const skill = state?.skills?.find(item => item.id === change.id), binding = skill?.bindings?.find(item => item.clientId === change.clientId);
  return { type: change.want ? 'binding.connect' : 'binding.disconnect', id: change.id, clientId: change.clientId, ...(!change.want && binding?.state === 'existing' ? { includeExisting: true } : {}) };
}

const clientName = (state, id) => state?.clients?.find(client => client.id === id)?.name || id;   // 未登记的软件 ID 回退显示 ID（契约 B）
export const clientNames = (state, ids) => (ids || []).map(id => clientName(state, id));
// 「停用前接入：A、B」；没有记忆就返回空串。
export const rememberedLabel = (skill, state) => rememberedIds(skill).length ? '停用前接入：' + clientNames(state, rememberedIds(skill)).join('、') : '';

// 预览里一行的人话：{ tag: '接入', label: 'review-code → Codex' }
export function describeChange(change, state) {
  if (change.kind === 'mcp') return { tag: change.want ? '启用' : '停用', label: state?.servers?.find(item => item.id === change.id)?.name || change.id };
  const skill = state?.skills?.find(item => item.id === change.id), name = skill?.name || change.id;
  if (change.kind === 'skill') return { tag: change.want ? '启用' : '停用', label: name };
  return { tag: change.want ? '接入' : '取消接入', label: `${name} → ${clientName(state, change.clientId)}` };
}

// 路径缩写：家目录 → ~。优先用服务给的共享来源根（…/.agents）推出家目录，否则按 /Users/名 或 /home/名。
export function tildePath(path, root = '') {
  const text = String(path || ''), home = (/^(.*?)\/\.agents(\/|$)/.exec(String(root)) || [])[1] || (/^(\/Users\/[^/]+|\/home\/[^/]+)/.exec(String(root)) || [])[1] || (/^(\/Users\/[^/]+|\/home\/[^/]+)/.exec(text) || [])[1];
  return home && (text === home || text.startsWith(home + '/')) ? '~' + text.slice(home.length) : text;
}

// 一段话里的家目录缩成 ~（只用于预览里的说明文字和路径，不改文件内容）。
export function tildeText(text, root = '') {
  const value = String(text ?? ''), home = (/^(.*?)\/\.agents(\/|$)/.exec(String(root)) || [])[1] || (/^(\/Users\/[^/]+|\/home\/[^/]+)/.exec(String(root)) || [])[1];
  return home ? value.split(home + '/').join('~/') : value;
}

export const batchTitle = count => `应用 ${count} 项变更`;
export const barLabel = count => `${count} 项待应用的变更`;
// 部分成功（design-spec §6）：「已应用 2 项，1 项未完成」。
export function partialSummary({ done, failed, skipped = 0 }) {
  const pending = failed + skipped;
  return pending ? `已应用 ${done} 项，${pending} 项未完成` : `已应用 ${done} 项变更`;
}
// 成功回执的 toast 文案；name 是对象名。
export function appliedMessage(action, name = '') {
  const quoted = name ? `「${name}」` : '';
  switch (action?.type) {
    case 'skill.archive': case 'mcp.archive': return `已归档${quoted}`;
    case 'operation.restore': return '已撤销上一步变更';
    case 'skill.enable': return `已启用${quoted}`;
    case 'skill.disable': return `已停用${quoted}`;
    case 'binding.connect': return `已接入${quoted}`;
    case 'binding.disconnect': return `已取消接入${quoted}`;
    case 'mcp.toggle': return `${action.enabled ? '已启用' : '已停用'}${quoted}`;
    case 'mcp.probe': return '已开始检测连接';
    case 'skill.resolveConflict': return action.resolution === 'adoptShared' ? `已采用共享版本${quoted}` : action.resolution === 'keepLocal' ? `已保留软件内版本${quoted}` : `已重新标记为待处理${quoted}`;
    case 'mcp.importJson': return importedMessage(action);
    case 'mcp.save': /* 保留现有：写现有那条的 ID，不写新填写的名称 */ if (action.onConflict === 'keepExisting') return `已保留现有配置，没有改动${action.server?.id ? `「${action.server.id}」` : ''}`;  return action.onConflict === 'adoptNew' ? `已替换${quoted}` : `已保存${quoted}`;
    case 'skill.create': case 'skill.update': case 'client.save': return `已保存${quoted}`;
    default: return '变更已应用';
  }
}
// 能撤销的动作：只有产生了回执（operationId）、不是检测、不是撤销自己的成功。
export const undoable = (action, result) => !!result?.operationId && !['mcp.probe', 'operation.restore'].includes(action?.type) && !(action?.type === 'mcp.save' && action.onConflict === 'keepExisting');   // 保留现有没有改任何文件，不给「撤销」
// 批量撤销：逆序恢复，每个 operationId 一个动作。
export const undoActions = operationIds => [...operationIds].reverse().map(operationId => ({ type: 'operation.restore', operationId }));

// MCP 导入成功后的 toast 文案（0.7 PR-12）。
export function importedMessage(action) {
  const values = Object.values(action?.resolutions || {}), adopted = values.filter(value => value === 'adoptNew').length, kept = values.filter(value => value === 'keepExisting').length;
  return `已导入 MCP 配置${adopted ? `，替换 ${adopted} 个` : ''}${kept ? `，保留现有 ${kept} 个` : ''}`;
}
