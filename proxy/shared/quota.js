// Parse upstream numbers without inventing a value; quota percentages are not counts.
export const quotaNumber = value => {
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) value=Number(value);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
};
export const quotaResetTime = value => {
  if (value == null) return undefined;
  const time = typeof value === 'number' ? value * 1000 : Date.parse(value);
  const date=new Date(time);
  return Number.isFinite(date.getTime()) && date.getTime()>0 ? date.toISOString() : undefined;
};

export function normalizeQuotaBucket(bucket){
 if(!bucket||typeof bucket!=='object'||Array.isArray(bucket))return undefined;
 const result={};
 for(const key of ['id','name','group','period'])if(typeof bucket[key]==='string'&&bucket[key].trim())result[key]=bucket[key];
 if(bucket.unlimited===true)return {...result,unlimited:true};
 const limit=quotaNumber(bucket.limit),used=quotaNumber(bucket.used),remaining=quotaNumber(bucket.remaining);
 if(limit===0&&!used&&!remaining)return undefined;
 const percent=limit>0&&(used!==undefined||remaining!==undefined)?Math.max(0,used??limit-remaining)/limit*100:quotaNumber(bucket.usedPercent);
 if(['credits','tokens','requests'].includes(bucket.unit)){
  result.unit=bucket.unit;
  for(const [key,value] of Object.entries({limit,used,remaining}))if(value!==undefined)result[key]=value;
  if(limit===undefined&&used===undefined&&remaining===undefined&&percent===undefined)return undefined;
 }else if(percent!==undefined)result.unit='percent';
 else return undefined;
 if(percent!==undefined)result.usedPercent=percent;
 const resetsAt=quotaResetTime(bucket.resetsAt);if(resetsAt)result.resetsAt=resetsAt;
 return result;
}

export function normalizeQuota(snapshot){
 return {...snapshot,checkedAt:snapshot.checkedAt||snapshot.updatedAt,buckets:(snapshot.buckets||[]).map(normalizeQuotaBucket).filter(Boolean)};
}
