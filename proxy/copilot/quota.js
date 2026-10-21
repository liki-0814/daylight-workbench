import {quotaNumber,quotaResetTime,normalizeQuota} from '../shared/quota.js';

export function copilotQuota(data){
 return normalizeQuota({source:'copilot',plan:data.copilot_plan,checkedAt:new Date().toISOString(),buckets:Object.entries(data.quota_snapshots||{}).map(([id,q])=>{
  const limit=q.unlimited?undefined:quotaNumber(q.entitlement),remaining=q.unlimited?undefined:quotaNumber(q.quota_remaining??q.remaining),percent=quotaNumber(q.percent_remaining);
  const credits=(q.token_based_billing??data.token_based_billing)===true&&(id==='premium_interactions'||id==='premium_models'||id==='chat'&&!q.unlimited);
  const used=limit!==undefined&&remaining!==undefined?Math.max(0,limit-remaining):undefined;
  return{id,name:credits?'AI Credits':({chat:'对话',completions:'代码补全',premium_interactions:'Premium 请求',premium_models:'Premium 请求'}[id]||id),unlimited:q.unlimited===true,unit:credits?'credits':'requests',limit,remaining,used,usedPercent:limit>0&&used!==undefined?used/limit*100:!q.unlimited&&percent!==undefined?Math.max(0,100-percent):undefined,resetsAt:q.unlimited?undefined:quotaResetTime(q.quota_reset_at)||quotaResetTime(data.quota_reset_date_utc)||quotaResetTime(data.quota_reset_date)};
 })});
}
