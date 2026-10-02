import { unlink } from 'node:fs/promises';
import { readJson, writeJson, serial } from '../shared/store.js';

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
