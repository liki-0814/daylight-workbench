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
