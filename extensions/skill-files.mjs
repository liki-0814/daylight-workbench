import path from 'node:path';
import { parseDocument } from 'yaml';
import { error, hash, safePath, readText } from './files.mjs';

export const skillId = relative => 'skill_' + hash(relative).slice(0, 24);
export function metadata(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 262144 || text.includes('\0')) throw error('SKILL.md 必须是小于 256 KB 的文本');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw error('SKILL.md 需要 YAML frontmatter');
  const doc = parseDocument(match[1], { uniqueKeys: true });
  if (doc.errors.length) throw error('Skill 的 YAML frontmatter 格式错误');
  let data;
  try { data = doc.toJS({ maxAliasCount: 100 }); } catch { throw error('Skill 的 YAML 引用过多'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(data.name) || typeof data.description !== 'string' || !data.description.trim()) throw error('Skill 需要合法的 name（小写字母、数字、短横线）和 description');
  const dependencies = data.metadata?.['mcp-dependencies'];
  if (dependencies !== undefined && (!Array.isArray(dependencies) || dependencies.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)))) throw error('metadata.mcp-dependencies 需要 MCP ID 数组');
  return { name: data.name, description: data.description.slice(0, 4000), dependencies: dependencies || null };
}
export async function skillFile(root, skill, relative = 'SKILL.md') {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part => !part || part === '..' || part.startsWith('.'))) throw error('Skill 文件路径无效');
  const target = path.resolve(root, 'skills', skill.relativePath, relative);
  await safePath(path.join(root, 'skills', skill.relativePath), target);
  return { target, content: await readText(target), relative };
}
