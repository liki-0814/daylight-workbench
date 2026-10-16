import {quotaNumber,quotaResetTime} from '../shared/quota.js';

export function copilotQuota(data){
 return{source:'copilot',checkedAt:new Date().toISOString(),message:[data.copilot_plan?`Copilot ${data.copilot_plan}`:'', '额度按请求计量；未提供的值保持未知。'].filter(Boolean).join(' · '),buckets:Object.entries(data.quota_snapshots||{}).map(([id,q])=>{
  const limit=q.unlimited?undefined:quotaNumber(q.entitlement),remaining=q.unlimited?undefined:quotaNumber(q.quota_remaining??q.remaining),percent=quotaNumber(q.percent_remaining);
  return{id,name:({chat:'对话',completions:'代码补全',premium_interactions:'Premium 请求'}[id]||id)+(q.unlimited?'（不限量）':''),unit:'requests',limit,remaining,used:limit!==undefined&&remaining!==undefined?Math.max(0,limit-remaining):undefined,usedPercent:!q.unlimited&&percent!==undefined?Math.max(0,100-percent):undefined,resetsAt:quotaResetTime(data.quota_reset_date)};
 })};
}
