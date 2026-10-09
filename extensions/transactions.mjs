import * as fs from 'node:fs/promises';
import path from 'node:path';
import { error, hash, stat, safePath, snapshot, replace, atomicJSON, readJSON } from './files.mjs';

export function createTransactions({ root, assertTarget, fault = () => {} }) {
  const directory = path.join(root, 'daylight'), operations = path.join(directory, 'operations'), lockFile = path.join(directory, 'write.lock');
  const validId = id => { if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw error('requestId 无效'); return id; };
  const operationPath = id => path.join(operations, validId(id) + '.json');
  async function read(id) { await safePath(root, operationPath(id)); return readJSON(operationPath(id), null, 32_000_000); }
  function publicReceipt(record) {
    if (!record) throw error('未找到操作回执，请用原请求核对', 404, 'EXTENSIONS_RECEIPT_MISSING');
    return { requestId: record.requestId, status: record.status, action: record.action, createdAt: record.createdAt, result: record.result || null, error: record.error || null, steps: record.steps.map(({ path: file, completed, restored }) => ({ path: file, completed: !!completed, restored: !!restored })) };
  }
  async function save(record) { await safePath(root, operationPath(record.requestId)); await atomicJSON(operationPath(record.requestId), record); }
  async function acquire() {
    await safePath(root, lockFile);
    await fs.mkdir(operations, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await fs.open(lockFile, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid }));
        return async () => { await handle.close(); await fs.rm(lockFile, { force: true }); };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const info = await stat(lockFile);
        const lock = await readJSON(lockFile, null);
        if (!lock?.pid || !Number.isInteger(lock.pid)) throw error('写锁异常，请核对正在进行的操作', 409, 'EXTENSIONS_BUSY');
        try { process.kill(lock.pid, 0); throw error('另一个窗口或进程正在保存，请稍后用原请求重试', 409, 'EXTENSIONS_BUSY'); }
        catch (failure) {
          if (failure.code !== 'ESRCH') throw failure;
          if ((await stat(lockFile))?.ino !== info.ino) continue;
          await fs.rm(lockFile);
        }
      }
    }
    throw error('无法取得扩展写锁', 409, 'EXTENSIONS_BUSY');
  }
  async function rollback(record) {
    let drift = false;
    for (const step of [...record.steps].reverse()) {
      try {
        await assertTarget(step.path);
        const actual = hash(await snapshot(step.path));
        if (actual === hash(step.before)) { step.restored = true; continue; }
        if (actual !== hash(step.after)) { drift = true; continue; }
        await replace(step.path, step.before); step.restored = true; await save(record);
      } catch { drift = true; }
    }
    record.status = drift ? 'recovery_required' : 'rolled_back';
    record.error = drift ? '部分文件发生外部变化，已停止恢复。请按步骤核对，保留你的新内容。' : '操作未完成，已恢复修改前内容。请重新预览。';
    await save(record);
  }
  async function recoverInterrupted() {
    for (const name of await fs.readdir(operations)) {
      if (!/^[a-zA-Z0-9_-]{8,100}\.json$/.test(name)) continue;
      const record = await read(name.slice(0, -5));
      if (['applying', 'recovery_required'].includes(record.status)) await rollback(record);
      if (record.status === 'recovery_required') throw error('存在需要人工核对的扩展操作：' + record.requestId, 409, 'EXTENSIONS_RECOVERY_REQUIRED');
    }
  }
  async function execute(input, prepare, result) {
    validId(input.requestId);
    const fingerprint = hash({ expectedVersion: input.expectedVersion, planId: input.planId, action: input.action });
    const release = await acquire();
    try {
      await recoverInterrupted();
      const existing = await read(input.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw error('该 requestId 已用于其他变更', 409, 'EXTENSIONS_REQUEST_REUSED');
        if (existing.status === 'applied') return existing.result;
        throw error(existing.error || '旧操作需要核对', 409, 'EXTENSIONS_' + existing.status.toUpperCase());
      }
      const plan = await prepare(input.action);
      if (input.expectedVersion !== plan.expectedVersion || input.planId !== plan.planId) throw error('来源或接入文件已变化，请保留输入并重新预览', 409, 'EXTENSIONS_VERSION_CONFLICT');
      if (plan.conflicts.length) throw error(plan.conflicts.join('；'), 409, 'EXTENSIONS_CONFLICT');
      const record = { requestId: input.requestId, fingerprint, status: 'applying', action: plan.normalizedAction, createdAt: new Date().toISOString(), steps: plan.steps, result: null };
      await save(record);
      try {
        for (let index = 0; index < record.steps.length; index++) {
          const step = record.steps[index];
          await assertTarget(step.path);
          if (hash(await snapshot(step.path)) !== hash(step.before)) throw error('文件在保存期间发生变化', 409, 'EXTENSIONS_VERSION_CONFLICT');
          await fault('beforeStep', index, record);
          await assertTarget(step.path);
          if (hash(await snapshot(step.path)) !== hash(step.before)) throw error('文件在保存期间发生变化', 409, 'EXTENSIONS_VERSION_CONFLICT');
          await replace(step.path, step.after);
          await fault('afterStep', index, record);
          if (hash(await snapshot(step.path)) !== hash(step.after)) throw error('文件读回失败');
          step.completed = true; await save(record);
        }
        record.result = await result(plan, record);
        record.status = 'applied'; await save(record);
        await fault('afterReceipt', -1, record);
        return record.result;
      } catch (failure) {
        // A committed receipt survives a lost response; never undo it here.
        if (record.status !== 'applied') await rollback(record);
        throw failure;
      }
    } finally { await release(); }
  }
  return { execute, read, receipt: async id => publicReceipt(await read(id)), publicReceipt };
}
