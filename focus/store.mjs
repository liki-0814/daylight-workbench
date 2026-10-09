import path from 'node:path';
import { readFile, writeFile, mkdir, copyFile, rename, unlink, chmod } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { initialFocusRecord, validateFocusRecord } from '../core/focus-model.js';

export async function createFocusStore({ dataDir, timeZone = 'UTC', diagnostics, onSynchronousWork } = {}) {
  const file = path.join(dataDir, 'focus.json'), previous = path.join(dataDir, 'focus.previous.json'), temporary = path.join(dataDir, 'focus.tmp');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  let record;
  try { record = validateFocusRecord(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    record = initialFocusRecord({ timeZone });
    await writeFile(file, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
  }
  let lastTimings = null, historyBytes = Buffer.byteLength(JSON.stringify(record));
  return {
    get record() { return record; },
    get lastTimings() { return lastTimings; },
    get historyBytes() { return historyBytes; },
    async save(nextRecord) {
      const started = performance.now();
      const encoded = JSON.stringify(nextRecord), encodedAt = performance.now();
      // Report before the first I/O await so the service can add encoding to
      // the prepare/reconcile CPU work in the same event-loop turn.
      onSynchronousWork?.(encodedAt - started);
      await copyFile(file, previous); await chmod(previous, 0o600); const previousAt = performance.now();
      try {
        await writeFile(temporary, encoded, { mode: 0o600 }); await chmod(temporary, 0o600); const temporaryAt = performance.now();
        await rename(temporary, file); const replacedAt = performance.now();
        record = nextRecord;
        const committedAt = performance.now();
        historyBytes = Buffer.byteLength(encoded);
        lastTimings = { type: 'focus-save', encodeMs: encodedAt - started, previousMs: previousAt - encodedAt, temporaryMs: temporaryAt - previousAt, replaceMs: replacedAt - temporaryAt, bytes: Buffer.byteLength(encoded), totalMs: replacedAt - started };
        onSynchronousWork?.(performance.now() - committedAt);
        diagnostics?.(lastTimings);
        return record;
      } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    },
  };
}
