import { homedir } from 'node:os';
import path from 'node:path';
import { access, copyFile, mkdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { validate } from './public/model.js';

export const defaultDataDir = path.join(homedir(), 'Library', 'Application Support', 'Daylight');
export const legacyDataDir = path.join(homedir(), 'liki_dev', 'daylight-workbench', '.local');

// Copy once, never overwrite destination data or remove the original files.
export async function migrateLegacyData(destination = defaultDataDir, source = legacyDataDir) {
  if (path.resolve(destination) === path.resolve(source)) return false;
  try { await access(path.join(destination, 'state.json')); return false; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let original;
  try { original = JSON.parse(await readFile(path.join(source, 'state.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  validate(original.state);
  if (!Number.isInteger(original.version) || original.version < 0) throw new Error('旧版数据版本无效');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  // State is copied last so an interrupted migration can safely resume.
  for (const file of ['agent-token', 'state.previous.json', 'state.json']) {
    try { await copyFile(path.join(source, file), path.join(destination, file), constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST' && !(error.code === 'ENOENT' && file !== 'state.json')) throw error; }
  }
  return true;
}
