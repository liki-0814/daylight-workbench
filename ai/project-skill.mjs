import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const source = fileURLToPath(new URL('../skills/daylight-workbench/', import.meta.url));
const files = ['SKILL.md', 'references/api.md', 'scripts/workbench.py', 'agents/openai.yaml', 'config.json'];
const hash = content => createHash('sha256').update(content).digest('hex');
export const projectSkillPath = (backend, cwd) => path.join(cwd, backend === 'qoder' ? '.qoder' : '.agents', 'skills', 'daylight-workbench');

// Only Daylight's managed runtime workspace is passed here. Never install into a
// task's associated directory or a user's global CLI configuration.
export function installProjectSkill({ backend, cwd, dataDir, endpoint }) {
  const target = projectSkillPath(backend, cwd), parent = path.dirname(target);
  for (const part of [cwd, path.dirname(parent), parent]) {
    if (fs.existsSync(part) && (fs.lstatSync(part).isSymbolicLink() || !fs.lstatSync(part).isDirectory())) throw new Error('项目 Skill 目录必须是工作目录内的真实目录');
    fs.mkdirSync(part, { recursive: true, mode: 0o700 });
  }
  const manifestPath = path.join(target, '.daylight-managed.json');
  let previous;
  if (fs.existsSync(target)) {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('项目 Skill 是外部链接，未自动更新');
    for (const directory of ['references', 'scripts', 'agents']) {
      const entry = path.join(target, directory);
      if (!fs.existsSync(entry) || fs.lstatSync(entry).isSymbolicLink() || !fs.lstatSync(entry).isDirectory()) throw new Error('项目 Skill 子目录不是受管理的真实目录，未覆盖');
    }
    if (fs.lstatSync(manifestPath).isSymbolicLink()) throw new Error('项目 Skill 清单不能是链接');
    try { previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch { throw new Error('项目 Skill 已存在且不属于 Daylight 管理，未覆盖'); }
    for (const file of files) {
      const current = path.join(target, file);
      if (!fs.existsSync(current) || fs.lstatSync(current).isSymbolicLink() || hash(fs.readFileSync(current)) !== previous[file]) throw new Error('项目 Skill 有本地修改，请核对后再更新');
    }
  }
  const content = Object.fromEntries(files.map(file => [file, file === 'config.json'
    ? Buffer.from(JSON.stringify({ url: endpoint, data_dir: path.resolve(dataDir), app_dir: '' }, null, 2) + '\n')
    : fs.readFileSync(path.join(source, file))]));
  const manifest = Object.fromEntries(files.map(file => [file, hash(content[file])]));
  if (previous && files.every(file => manifest[file] === previous[file])) return target;
  const staging = path.join(parent, '.daylight-stage-' + randomUUID()), backup = path.join(parent, '.daylight-previous-' + randomUUID());
  let moved = false;
  try {
    if (previous) fs.cpSync(target, staging, { recursive: true });
    else fs.mkdirSync(staging, { mode: 0o700 });
    for (const file of files) {
      const dest = path.join(staging, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.writeFileSync(dest, content[file], { mode: 0o600 });
    }
    fs.writeFileSync(path.join(staging, '.daylight-managed.json'), JSON.stringify(manifest), { mode: 0o600 });
    if (previous) { fs.renameSync(target, backup); moved = true; }
    try { fs.renameSync(staging, target); }
    catch (error) { if (moved) fs.renameSync(backup, target); throw error; }
    if (moved) fs.rmSync(backup, { recursive: true, force: true });
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  return target;
}
