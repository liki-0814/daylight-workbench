import {normalizeQuota} from '../shared/quota.js';
// Grok subscription percentage and reset period.
export function grokQuota({config}){
      const result = { available: !!config, updatedAt: new Date().toISOString(),
        usedPercent: Number.isFinite(config?.creditUsagePercent) ? config.creditUsagePercent : undefined,
        period: config?.currentPeriod, shared: config?.isUnifiedBillingUser,
        ...(config?{message:'账户订阅额度 · 包含其他 Grok 客户端使用'}:{}),
      };
      result.buckets=config?[{id:'subscription',name:'订阅额度',unit:'percent',usedPercent:result.usedPercent,period:result.period?.type==='USAGE_PERIOD_TYPE_WEEKLY'?'本周':result.period?.type==='USAGE_PERIOD_TYPE_MONTHLY'?'本月':undefined,resetsAt:result.period?.end}]:[];
 return normalizeQuota(result);
}
