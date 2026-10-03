import {createHash} from 'node:crypto';
import {readJson, writeJson, serial} from '../shared/store.js';

const USAGE_PATH = '/algo/api/v2/quota/usage';

function amount(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return undefined;
    value = Number(text);
  }
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? (value === 0 ? 0 : value) : undefined;
}

function bucket(raw, usageType, id, label, totalField) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const unit = raw.unit ?? usageType;
  if (typeof unit !== 'string' || unit.trim().toLowerCase() !== 'credits') return undefined;
  if (id === 'organization' && raw.available === false) return undefined;
  const used = amount(raw.used), remaining = amount(raw.remaining), total = amount(raw[totalField]);
  if (used === undefined || remaining === undefined || total === undefined) return undefined;
  return { id, label, used, remaining, total };
}

export async function fetchCredits(http, session) {
  let body;
  try {
    const response = await http.signedGet(http.algoUrl(USAGE_PATH), session);
    if (!response.ok) throw new Error('upstream request failed');
    body = await response.json();
  } catch {
    throw Object.assign(new Error('Credits 用量获取失败，请稍后重试'), { status: 502 });
  }
  const personal = bucket(body?.userQuota, body?.usageType, 'personal', '个人额度', 'total');
  const organization = bucket(body?.orgResourcePackage, body?.usageType, 'organization', '团队资源包', 'cap');
  const buckets = [];
  // Teams accounts can carry an empty personal quota alongside their real resource package.
  if (personal && !(organization && personal.used === 0 && personal.remaining === 0 && personal.total === 0)) buckets.push(personal);
  if (organization) buckets.push(organization);
  return { buckets, updatedAt: new Date().toISOString() };
}

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
