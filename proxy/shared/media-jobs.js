import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson, serial } from './store.js';

const MAX_JOBS = 50;
const OPEN_MS = 24 * 60 * 60 * 1000;
const terminal = status => status === 'succeeded' || status === 'failed' || status === 'expired';

export function createMediaJobs(dataDir, { now = () => Date.now() } = {}) {
  const file = path.join(dataDir, 'proxy', 'media-jobs.json');
  const queue = serial();
  const update = fn => queue(async () => {
    const stored = await readJson(file, []);
    const rows = Array.isArray(stored) ? stored : [];
    // Polling reads through here too: compare with what was read so an unchanged list never rewrites the file.
    const before = JSON.stringify(stored);
    const clock = now();
    for (const row of rows) {
      if (!terminal(row.status) && clock - Date.parse(row.createdAt) > OPEN_MS) {
        row.status = 'expired';
        row.updatedAt = new Date(clock).toISOString();
      }
    }
    const result = await fn(rows, clock);
    if (JSON.stringify(result.rows) !== before) await writeJson(file, result.rows);
    return result.value;
  });
  return {
    file,
    create(fields) {
      return update(rows => {
        const expired = rows.filter(row => row.status === 'expired');
        for (const row of expired) if (rows.length >= MAX_JOBS) rows.splice(rows.indexOf(row), 1);
        const done = rows.filter(row => terminal(row.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        while (rows.length >= MAX_JOBS && done.length) rows.splice(rows.indexOf(done.shift()), 1);
        if (rows.length >= MAX_JOBS) throw Object.assign(new Error('视频任务已满，请删除已完成的任务后重试'), { status: 429, code: 'job_limit' });
        const row = { id: `vid_${randomUUID()}`, operation: 'video.submit', status: 'in_progress', createdAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString(), ...fields };
        rows.push(row);
        return { rows, value: row };
      });
    },
    get(id) { return update(rows => ({ rows, value: rows.find(row => row.id === id) })); },
    save(row) { return update(rows => { const index = rows.findIndex(item => item.id === row.id); if (index >= 0) rows[index] = row; return { rows, value: row }; }); },
    remove(id) { return update(rows => { const index = rows.findIndex(row => row.id === id); return { rows, value: index < 0 ? undefined : rows.splice(index, 1)[0] }; }); },
    dropAccount(provider, account) { return update(rows => ({ rows: rows.filter(row => !(row.provider === provider && row.account === account)), value: true })); },
  };
}
