import {quotaNumber as number,quotaResetTime as resetTime} from '../shared/quota.js';

export function codexQuota(payload) {
  const entries = Object.entries(payload.rateLimitsByLimitId || {});
  if (!entries.length && payload.rateLimits) entries.push([payload.rateLimits.limitId || 'codex',payload.rateLimits]);
  return {buckets:entries.flatMap(([id,quota]) => ['primary','secondary'].filter(key=>quota[key]).map(key => {
    const window=quota[key], minutes=number(window.windowDurationMins);
    const duration=minutes === undefined ? '周期未提供' : minutes%1440===0 ? `${minutes/1440} 天` : minutes%60===0 ? `${minutes/60} 小时` : `${minutes} 分钟`;
    return {id:`${id}:${key}`,unit:'percent',name:`${quota.limitName || id} · ${duration}`,usedPercent:number(window.usedPercent),resetsAt:resetTime(window.resetsAt)};
  })),checkedAt:new Date().toISOString()};
}
