// Preserve raw groups for legacy clients; all normalized windows are percentages.
export function agyQuota(data){
 const groups=data.groups||[];
 const buckets=groups.flatMap((group,index)=>(group.buckets||[]).map(bucket=>({
  id:`${index}:${bucket.window}`,
  name:group.displayName,
  group:group.displayName,
  period:bucket.window==='5h'?'5 小时':bucket.window==='weekly'?'7 天':bucket.window,
  unit:'percent',
  usedPercent:Number.isFinite(bucket.remainingFraction)&&!bucket.disabled?(1-bucket.remainingFraction)*100:undefined,
  resetsAt:bucket.resetTime,
 })));
 return {groups,buckets,updatedAt:new Date().toISOString(),message:'同组模型共享额度，包含其他客户端使用'};
}
