import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJSON } from '../core/extensions-contracts.js';

export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJSON(value)).digest('hex');
export const error = (message, status = 400, code = 'EXTENSIONS_INVALID') => Object.assign(new Error(message), { status, code });
export const within = (root, target) => { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
export async function stat(file) { try { return await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
export async function safePath(root, target) {
  if (!within(root, target)) throw error('路径超出扩展管理范围', 403, 'EXTENSIONS_PATH');
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part);
    if ((await stat(current))?.isSymbolicLink()) throw error('路径包含软链接，请在主来源的真实目录中编辑', 409, 'EXTENSIONS_SYMLINK');
  }
  return target;
}
export async function readText(file, limit = 262144) {
  const info = await stat(file);
  if (!info) return null;
  if (!info.isFile() || info.size > limit) throw error('文件不是文本文件或超过读取上限', 400, 'EXTENSIONS_FILE_LIMIT');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(file)); }
  catch (failure) { if (!(failure instanceof TypeError)) throw failure; throw error('文件不是 UTF-8 文本，不能在文本编辑器中修改', 400, 'EXTENSIONS_FILE_BINARY'); }
  if (text.includes('\0')) throw error('文件包含二进制内容，不能在文本编辑器中修改', 400, 'EXTENSIONS_FILE_BINARY');
  return text;
}
export async function readJSON(file, fallback, limit = 2_000_000) { const text = await readText(file, limit); if (text === null) return fallback; try { return JSON.parse(text); } catch { throw error('扩展管理 JSON 格式错误，原文件已保留', 409, 'EXTENSIONS_FORMAT'); } }
export async function atomicJSON(file, value) {
  const tmp = file + '.' + randomUUID() + '.tmp';
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try { await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }); }
}
// Snapshots never follow links. They are also the recovery material, with bounded size.
export async function snapshot(file, budget = { count: 0, bytes: 0 }) {
  if (++budget.count > 2500) throw error('操作包含过多文件，请缩小范围');
  const info = await stat(file);
  if (!info) return { kind: 'missing' };
  if (info.isSymbolicLink()) return { kind: 'link', target: await fs.readlink(file) };
  if (info.isFile()) {
    budget.bytes += info.size;
    if (budget.bytes > 8_000_000) throw error('操作恢复材料超过 8 MB，请缩小范围');
    return { kind: 'file', data: (await fs.readFile(file)).toString('base64'), mode: info.mode & 0o777 };
  }
  if (!info.isDirectory()) throw error('不支持操作特殊文件');
  const entries = {};
  for (const name of (await fs.readdir(file)).sort()) entries[name] = await snapshot(path.join(file, name), budget);
  return { kind: 'directory', entries, mode: info.mode & 0o777 };
}
export const fileSnapshot = text => ({ kind: 'file', data: Buffer.from(text).toString('base64'), mode: 0o600 });
export async function replace(file, next) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if (next.kind === 'missing') { await fs.rm(file, { recursive: true, force: true }); return; }
  const temp = path.join(path.dirname(file), '.daylight-' + path.basename(file) + '-' + randomUUID());
  async function materialize(target, value) {
    if (value.kind === 'link') return fs.symlink(value.target, target);
    if (value.kind === 'file') return fs.writeFile(target, Buffer.from(value.data, 'base64'), { mode: value.mode, flag: 'wx' });
    if (value.kind !== 'directory') throw error('恢复材料无效');
    await fs.mkdir(target, { mode: value.mode });
    for (const [name, entry] of Object.entries(value.entries)) {
      if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw error('恢复文件名无效');
      await materialize(path.join(target, name), entry);
    }
  }
  try {
    await materialize(temp, next);
    // File/link replacement uses rename; directory replacement is journaled, not globally atomic.
    if ((await stat(file))?.isDirectory()) await fs.rm(file, { recursive: true });
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
