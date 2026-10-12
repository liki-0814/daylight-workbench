import { parse as parseToml } from 'smol-toml';
import { parseForESLint } from 'toml-eslint-parser';
import { parseTree, getNodeValue, modify, applyEdits } from 'jsonc-parser';
import { error } from './files.mjs';

const keys = node => node.keys.map(key => key.name ?? key.value);
const keyText = key => /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const prefix = (a, b) => a.every((key, index) => b[index] === key);
const literal = value => value instanceof Date ? value.toISOString() : Array.isArray(value) ? '[' + value.map(literal).join(', ') + ']' : value && typeof value === 'object' ? '{ ' + Object.entries(value).map(([key, item]) => JSON.stringify(key) + ' = ' + literal(item)).join(', ') + ' }' : JSON.stringify(value);
function assign(object, parts, value) {
  const key = parts[0];
  if (parts.length > 1) { if (!Object.hasOwn(object, key)) Object.defineProperty(object, key, { value: {}, writable: true, enumerable: true, configurable: true }); assign(object[key], parts.slice(1), value); }
  else if (value === undefined) delete object[key]; else Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
}

// Parse the complete file first; editing ranges retains unrelated bytes and comments.
export function configDocument(raw, format) {
  raw ??= format === 'json' ? '{}\n' : '';
  let data, ast;
  try {
    if (format === 'toml') { data = parseToml(raw); ast = parseForESLint(raw).ast; }
    else {
      const errors = []; ast = parseTree(raw, errors, { allowTrailingComma: true });
      if (errors.length || ast?.type !== 'object') throw new Error();
      const unique = node => { if (node.type === 'object' && new Set(node.children.map(child => child.children[0].value)).size !== node.children.length) throw new Error(); node.children?.forEach(unique); };
      unique(ast); data = getNodeValue(ast);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
  } catch { throw error('CLI 配置格式无效，原文件已保留；请修复后重新扫描', 409, 'EXTENSIONS_CLIENT_FORMAT'); }
  function patch(parts, value) {
    if (format === 'json') return applyEdits(raw, modify(raw, parts, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: raw.includes('\r\n') ? '\r\n' : '\n' } }));
    const top = ast.body[0], tables = top.body.filter(node => node.type === 'TOMLTable');
    const entries = top.body.flatMap(node => node.type === 'TOMLKeyValue' ? [{ node, path: keys(node.key) }] : node.body.map(entry => ({ node: entry, path: [...node.resolvedKey, ...keys(entry.key)] })));
    const containing = entries.find(entry => prefix(entry.path, parts));
    if (containing) {
      const node = containing.node;
      if (same(containing.path, parts)) {
        const [start, end] = value === undefined ? node.range : node.value.range;
        return raw.slice(0, start) + (value === undefined ? '' : literal(value)) + raw.slice(end);
      }
      const object = structuredClone(containing.path.reduce((result, key) => result?.[key], data));
      if (!object || typeof object !== 'object') throw error('CLI 配置字段类型冲突');
      assign(object, parts.slice(containing.path.length), value);
      return raw.slice(0, node.value.range[0]) + literal(object) + raw.slice(node.value.range[1]);
    }
    if (value === undefined) {
      // Remove only syntax nodes belonging to this object; leave comments in place.
      const ranges = entries.filter(entry => prefix(parts, entry.path)).map(entry => entry.node.range);
      for (const table of tables.filter(table => prefix(parts, table.resolvedKey))) ranges.push([table.range[0], raw.indexOf(']', table.key.range[1]) + 1]);
      let result = raw; for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) result = result.slice(0, start) + result.slice(end);
      return result;
    }
    // Scalars/maps/arrays use inline TOML values, avoiding a second serializer policy.
    const table = tables.filter(table => prefix(table.resolvedKey, parts) && table.resolvedKey.length < parts.length).sort((a, b) => b.resolvedKey.length - a.resolvedKey.length)[0];
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    if (table) {
      const nextLine = raw.indexOf('\n', table.range[1]), at = nextLine < 0 ? raw.length : nextLine + 1;
      const text = parts.slice(table.resolvedKey.length).map(keyText).join('.') + ' = ' + literal(value) + eol;
      return raw.slice(0, at) + (at === raw.length && raw && !raw.endsWith('\n') ? eol : '') + text + raw.slice(at);
    }
    if (parts.length === 1) return parts.map(keyText).join('.') + ' = ' + literal(value) + eol + raw;
    return raw + (raw.endsWith('\n') || !raw ? '' : eol) + eol + '[' + parts.slice(0, -1).map(keyText).join('.') + ']' + eol + keyText(parts.at(-1)) + ' = ' + literal(value) + eol;
  }
  return { data, patch };
}

export function patchConfig(raw, format, changes) {
  for (const [parts, value] of changes) raw = configDocument(raw, format).patch(parts, value);
  configDocument(raw, format); // Never save syntactically invalid output.
  return raw;
}
