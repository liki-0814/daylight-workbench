import * as fs from 'node:fs/promises';
import path from 'node:path';
import { error, fieldError, readText, stat } from './files.mjs';
import { metadata } from './skill-files.mjs';

// Local-folder import. The folder is copied byte-for-byte into a snapshot, never followed through links.
export const importLimits = { files: 500, bytes: 5_000_000, depth: 6 };
const skipped = name => name.startsWith('.') || name === 'node_modules';

export function validSourcePath(value) {
  if (typeof value !== 'string' || !value.trim()) throw fieldError('请填写要导入的 Skill 文件夹的绝对路径。', 'sourcePath');
  if (value.length > 4096 || /[\0\r\n]/.test(value) || !path.isAbsolute(value) || value.split(path.sep).some(part => part === '..' || part === '.')) throw fieldError('路径需要是不含 . 或 .. 的绝对路径，例如 /Users/你/my-skill。请检查后重新选择文件夹。', 'sourcePath');
  return path.resolve(value);
}

export async function readSkillFolder(sourcePath) {
  const source = validSourcePath(sourcePath), info = await stat(source);
  if (!info) throw fieldError('找不到这个文件夹：' + source + '。请确认路径后重新选择。', 'sourcePath');
  if (info.isSymbolicLink()) throw fieldError('不接受符号链接作为导入来源。请选择真实的 Skill 文件夹。', 'sourcePath', 400, 'EXTENSIONS_IMPORT_SYMLINK');
  if (!info.isDirectory()) throw fieldError('这是一个文件，不是文件夹。请选择包含 SKILL.md 的文件夹。', 'sourcePath');
  const document = await stat(path.join(source, 'SKILL.md'));
  if (!document) throw fieldError('该文件夹顶层没有 SKILL.md，不是有效的 Skill。请选择包含 SKILL.md 的文件夹。', 'sourcePath', 400, 'EXTENSIONS_IMPORT_NO_SKILL');
  if (document.isSymbolicLink() || !document.isFile()) throw fieldError('SKILL.md 必须是普通文件，不能是链接。', 'sourcePath', 400, 'EXTENSIONS_IMPORT_SYMLINK');
  let meta;
  try { meta = metadata(await readText(path.join(source, 'SKILL.md'))); }
  catch (failure) { throw fieldError('SKILL.md 无效：' + failure.message + '。请修正后重试。', 'sourcePath', 400, failure.code); }
  const counts = { files: 0, bytes: 0 }, ignored = [], listed = [];
  async function walk(directory, depth) {
    if (depth > importLimits.depth) throw fieldError('文件夹层级超过 ' + importLimits.depth + ' 层，已停止导入。请精简目录结构后重试。', 'sourcePath', 400, 'EXTENSIONS_IMPORT_LIMIT');
    const entries = {};
    for (const name of (await fs.readdir(directory)).sort()) {
      const target = path.join(directory, name), relative = path.relative(source, target);
      if (skipped(name)) { ignored.push(relative); continue; }
      const item = await stat(target);
      if (item.isSymbolicLink()) throw fieldError('导入不会跟随符号链接：' + relative + '。请移除该链接或把内容复制进文件夹后重试。', 'sourcePath', 400, 'EXTENSIONS_IMPORT_SYMLINK');
      if (item.isDirectory()) { entries[name] = await walk(target, depth + 1); continue; }
      if (!item.isFile()) throw fieldError('包含不支持的特殊文件：' + relative + '。', 'sourcePath', 400, 'EXTENSIONS_IMPORT_SPECIAL');
      if (++counts.files > importLimits.files || (counts.bytes += item.size) > importLimits.bytes) throw fieldError('文件夹过大（最多 ' + importLimits.files + ' 个文件、' + importLimits.bytes / 1_000_000 + ' MB）。请移除不需要的文件后重试。', 'sourcePath', 400, 'EXTENSIONS_IMPORT_LIMIT');
      entries[name] = { kind: 'file', data: (await fs.readFile(target)).toString('base64'), mode: (item.mode & 0o777) | 0o600 };
      listed.push(relative);
    }
    return { kind: 'directory', entries, mode: ((await stat(directory)).mode & 0o777) | 0o700 };
  }
  const tree = await walk(source, 0);
  return { source, name: meta.name, description: meta.description, tree, files: listed, ignored, bytes: counts.bytes };
}
