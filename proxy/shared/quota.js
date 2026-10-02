// Keep missing upstream values unknown; quota percentages are not token counts.
const number = value => {
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) value=Number(value);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
};
const resetTime = value => {
  if (value == null) return undefined;
  const time = typeof value === 'number' ? value * 1000 : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
};
export function kimiQuota(payload) {
  const rows = [...(payload.usage ? [{detail:payload.usage,name:'订阅额度'}] : []), ...(Array.isArray(payload.limits) ? payload.limits : [])];
  return {buckets:rows.map((row,index) => {
    const detail = row.detail || row, window = row.window || {};
    const limit = number(detail.limit), remaining = number(detail.remaining);
    const used = number(detail.used) ?? (limit !== undefined && remaining !== undefined ? Math.max(0,limit-remaining) : undefined);
    const duration = number(window.duration);
    const unit = {TIME_UNIT_MINUTE:'分钟',TIME_UNIT_HOUR:'小时',TIME_UNIT_DAY:'天'}[window.timeUnit];
    const period=unit==='分钟' && duration%60===0 ? `${duration/60} 小时` : `${duration} ${unit}`;
    return {id:String(index),name:row.name || detail.name || detail.title || (duration && unit ? `${period}额度` : index ? `周期额度 ${index}` : '订阅额度'),limit,used,remaining:remaining ?? (limit !== undefined && used !== undefined ? Math.max(0,limit-used) : undefined),usedPercent:limit > 0 && used !== undefined ? used/limit*100 : undefined,resetsAt:resetTime(detail.reset_at ?? detail.resetAt ?? detail.reset_time ?? detail.resetTime)};
  }),checkedAt:new Date().toISOString()};
}
export function codexQuota(payload) {
  const entries = Object.entries(payload.rateLimitsByLimitId || {});
  if (!entries.length && payload.rateLimits) entries.push([payload.rateLimits.limitId || 'codex',payload.rateLimits]);
  return {buckets:entries.flatMap(([id,quota]) => ['primary','secondary'].filter(key=>quota[key]).map(key => {
    const window=quota[key], minutes=number(window.windowDurationMins);
    const duration=minutes === undefined ? '周期未提供' : minutes%1440===0 ? `${minutes/1440} 天` : minutes%60===0 ? `${minutes/60} 小时` : `${minutes} 分钟`;
    return {id:`${id}:${key}`,name:`${quota.limitName || id} · ${duration}`,usedPercent:number(window.usedPercent),resetsAt:resetTime(window.resetsAt)};
  })),checkedAt:new Date().toISOString()};
}
