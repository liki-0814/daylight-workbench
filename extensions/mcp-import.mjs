import { parseTree, getNodeValue, printParseErrorCode } from 'jsonc-parser';
import { fieldError } from './files.mjs';
import { normalizeServer } from './mcp-server.mjs';

// Converts pasted MCP JSON (`{"mcpServers": {...}}` or one server object) into Daylight servers.
// Daylight stores no credentials, so literal env/header values are rejected without echoing them.
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const reference = value => typeof value === 'string' && (value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/) || value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/))?.[1];
const known = ['id', 'name', 'type', 'transport', 'command', 'args', 'cwd', 'env', 'url', 'headers', 'enabled', 'disabled'];
export const importJsonLimit = 262144;
export const importServerLimit = 100;

function locate(text, offset) {
  const before = text.slice(0, offset), lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}
function convert(key, config, path, nativeKey) {
  const bad = (message, field) => fieldError('「' + key.slice(0, 60) + '」' + message, field);
  if (!plain(config)) throw bad('不是有效的服务对象。', path);
  const extra = Object.keys(config).filter(name => !known.includes(name));
  if (extra.length) throw bad('包含 Daylight 暂不支持的字段：' + extra.slice(0, 5).join('、').slice(0, 100) + '。请删除这些字段后重试。', path + '.' + extra[0]);
  const declared = config.transport ?? config.type;
  if (declared !== undefined && !['stdio', 'http', 'streamable-http', 'streamableHttp'].includes(declared)) throw bad(declared === 'sse' ? '使用 SSE 连接，Daylight 暂不支持；请改用 Streamable HTTP 地址。' : '连接方式无效，仅支持 stdio 或 http。', path + (config.transport !== undefined ? '.transport' : '.type'));
  const transport = declared ? declared === 'stdio' ? 'stdio' : 'http' : config.command ? 'stdio' : config.url ? 'http' : null;
  if (!transport) throw bad('缺少 command（stdio）或 url（http）。', path);
  if (config.disabled !== undefined && typeof config.disabled !== 'boolean') throw bad('disabled 需要布尔值。', path + '.disabled');
  const server = { id: key, name: config.name ?? key, transport, enabled: config.enabled ?? (config.disabled === true ? false : true) };
  if (transport === 'stdio') Object.assign(server, { command: config.command, ...(config.args !== undefined ? { args: config.args } : {}), ...(config.cwd !== undefined ? { cwd: config.cwd } : {}) });
  else Object.assign(server, { url: config.url });
  for (const [source, target] of [['env', 'envRefs'], ['headers', 'headerRefs']]) {
    if (config[source] === undefined) continue;
    if (!plain(config[source])) throw bad(source + ' 需要是对象。', path + '.' + source);
    const refs = {};
    for (const [name, value] of Object.entries(config[source])) {
      const ref = reference(value);
      if (!ref) throw bad('的 ' + source + '.' + name.slice(0, 60) + ' 是明文值。Daylight 不保存凭据：请先在系统环境变量中设置，再把它改成 ${变量名} 后导入。', path + '.' + source + '.' + name);
      refs[name] = ref;
    }
    server[target] = refs;
  }
  try { return normalizeServer(server, { nativeKey }); }
  catch (failure) {
    const rest = String(failure.field || 'server').replace(/^server\.?/, '');
    throw fieldError('「' + key.slice(0, 60) + '」' + failure.message, path + (rest ? '.' + rest : ''), failure.status, failure.code);
  }
}
export function parseMcpJson(text, { nativeKey = false } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw fieldError('请粘贴 MCP 配置 JSON。', 'json');
  if (text.length > importJsonLimit) throw fieldError('JSON 超过 256 KB，请只粘贴需要导入的服务。', 'json');
  const errors = [], tree = parseTree(text, errors, { allowTrailingComma: false, disallowComments: true });
  if (errors.length || !tree) {
    const position = locate(text, errors[0]?.offset ?? 0);
    throw Object.assign(fieldError('JSON 无法解析：第 ' + position.line + ' 行第 ' + position.column + ' 列附近有语法错误（' + (errors[0] ? printParseErrorCode(errors[0].error) : '内容为空') + '）。请修正后重试。', 'json'), position);
  }
  const duplicate = node => { if (node.type === 'object') { const names = node.children.map(child => child.children[0].value); const repeated = names.find((name, index) => names.indexOf(name) !== index); if (repeated !== undefined) return repeated; } for (const child of node.children || []) { const found = duplicate(child); if (found !== undefined) return found; } };
  const repeated = duplicate(tree);
  if (repeated !== undefined) throw fieldError('JSON 中有重复的键：' + String(repeated).slice(0, 60) + '。请删除重复项后重试。', 'json');
  const root = getNodeValue(tree);
  if (!plain(root)) throw fieldError('JSON 需要是对象：{"mcpServers": {...}} 或单个服务对象。', 'json');
  let entries;
  if (Object.hasOwn(root, 'mcpServers')) {
    if (!plain(root.mcpServers) || !Object.keys(root.mcpServers).length) throw fieldError('mcpServers 需要是包含至少一个服务的对象。', 'mcpServers');
    if (Object.keys(root).some(name => name !== 'mcpServers')) throw fieldError('mcpServers 旁边有其他字段，请只粘贴 mcpServers 部分。', 'json');
    entries = Object.entries(root.mcpServers).map(([key, config]) => [key, config, 'mcpServers.' + key]);
  } else {
    const key = typeof root.id === 'string' ? root.id : typeof root.name === 'string' ? root.name : null;
    if (!key) throw fieldError('单个服务对象需要 id 或 name 字段，或改用 {"mcpServers": {"服务名": {...}}} 格式。', 'json');
    const { id, ...config } = root;
    entries = [[key, config, 'server']];
  }
  if (entries.length > importServerLimit) throw fieldError('一次最多导入 ' + importServerLimit + ' 个服务。', 'mcpServers');
  return entries.map(([key, config, path]) => convert(key, config, path, nativeKey));
}
