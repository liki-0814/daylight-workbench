import { createHash } from 'node:crypto';
import { readJson, writeJson, serial } from './store.js';

// Account-wide snapshots, never inferred per-request billing. One point per hour,
// retained for 30 days; resets stay visible as changes in the recorded balance.
export class CreditsHistory {
  constructor(file) { this.file = file; this.run = serial(); }
  record(identity, snapshot) {
    return this.run(async () => {
      const owner = createHash('sha256').update(identity).digest('hex');
      const saved = await readJson(this.file, { accounts: {} });
      const now = Date.parse(snapshot.updatedAt), cutoff = now - 30 * 86400000;
      const accounts = Object.fromEntries(Object.entries(saved.accounts).map(([key, rows]) => [key, rows.filter(row => Date.parse(row.updatedAt) >= cutoff)]).filter(([, rows]) => rows.length));
      const rows = accounts[owner] || [];
      if (snapshot.buckets.length) {
        if (rows.length && Math.floor(Date.parse(rows.at(-1).updatedAt) / 3600000) === Math.floor(now / 3600000)) rows.pop();
        rows.push(snapshot);
      }
      accounts[owner] = rows.slice(-721);
      // Bound storage even when many accounts are switched locally.
      const bounded = Object.fromEntries(Object.entries(accounts).sort((a, b) => Date.parse(b[1].at(-1)?.updatedAt || 0) - Date.parse(a[1].at(-1)?.updatedAt || 0)).slice(0, 10));
      await writeJson(this.file, { accounts: bounded });
      return { ...snapshot, history: accounts[owner] };
    });
  }
}
