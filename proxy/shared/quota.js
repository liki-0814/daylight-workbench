// Keep missing upstream values unknown; quota percentages are not token counts.
export const quotaNumber = value => {
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) value=Number(value);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
};
export const quotaResetTime = value => {
  if (value == null) return undefined;
  const time = typeof value === 'number' ? value * 1000 : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
};

export function normalizeQuota(snapshot){
 return {...snapshot,checkedAt:snapshot.checkedAt||snapshot.updatedAt,buckets:(snapshot.buckets||[]).map(bucket=>{
  const limit=quotaNumber(bucket.limit),used=quotaNumber(bucket.used),remaining=quotaNumber(bucket.remaining);
  return {...bucket,unit:bucket.unit||'unknown',limit,used,remaining,usedPercent:quotaNumber(bucket.usedPercent)??(limit>0&&used!==undefined?used/limit*100:undefined)};
 })};
}
