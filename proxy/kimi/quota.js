import {quotaNumber as number,quotaResetTime as resetTime} from '../shared/quota.js';

export function kimiQuota(payload) {
  const rows = [...(payload.usage ? [{detail:payload.usage,name:'订阅额度'}] : []), ...(Array.isArray(payload.limits) ? payload.limits : [])];
  return {buckets:rows.map((row,index) => {
    const detail = row.detail || row, window = row.window || {};
    const limit = number(detail.limit), remaining = number(detail.remaining);
    const used = number(detail.used) ?? (limit !== undefined && remaining !== undefined ? Math.max(0,limit-remaining) : undefined);
    const duration = number(window.duration);
    const unit = {TIME_UNIT_MINUTE:'分钟',TIME_UNIT_HOUR:'小时',TIME_UNIT_DAY:'天'}[window.timeUnit];
    const period=unit==='分钟' && duration%60===0 ? `${duration/60} 小时` : `${duration} ${unit}`;
    return {id:String(index),unit:'unknown',name:row.name || detail.name || detail.title || (duration && unit ? `${period}额度` : index ? `周期额度 ${index}` : '订阅额度'),limit,used,remaining:remaining ?? (limit !== undefined && used !== undefined ? Math.max(0,limit-used) : undefined),usedPercent:limit > 0 && used !== undefined ? used/limit*100 : undefined,resetsAt:resetTime(detail.reset_at ?? detail.resetAt ?? detail.reset_time ?? detail.resetTime)};
  }),checkedAt:new Date().toISOString()};
}
