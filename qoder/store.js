import { mkdir, readFile, writeFile, rename, unlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error(`${path.basename(file)} 无法读取，原文件已保留`); }
}
export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally { await unlink(temporary).catch(() => {}); }
}
export function serial() {
  let tail = Promise.resolve();
  return fn => { const next = tail.then(fn); tail = next.catch(() => {}); return next; };
}
export class AccountStore {
  constructor(file) { this.file = file; this.run = serial(); }
  async load() {
    const account = await readJson(this.file, null);
    if (account && (!account.credential?.access || !account.credential?.uid)) throw new Error('账号文件无效，请重新登录');
    return account;
  }
  async require() { const value = await this.load(); if (!value) throw new Error('请先登录 Qoder'); return value; }
  save(account) { return writeJson(this.file, account); }
  logout() { return this.run(() => unlink(this.file).catch(error => { if (error.code !== 'ENOENT') throw error; })); }
}
