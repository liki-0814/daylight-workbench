const rate=value=>Number.isFinite(value)&&value>=0;
// A comparison against published API rates, never an account charge.
export function referenceCost(bucket,reference){
 if(!reference||reference.info?.currency!=='USD'||reference.info.unit!=='per_1M_tokens'||!['official-reference','llm-pricing'].includes(reference.info.basis)||!reference.info.sources?.some(url=>typeof url==='string'&&url.startsWith('https://')))return null;
 const cost=reference.cost;
 if(!cost||!rate(cost.input)||!rate(cost.output)||cost.tiers===null||cost.tiers?.length||!bucket.tokenRequests||bucket.cacheRequests!==bucket.tokenRequests)return null;
 const read=bucket.cacheReadTokens,write=bucket.cacheWriteTokens,normal=bucket.inputTokens-read-write;
 if(normal<0||read>0&&!rate(cost.cacheRead)||write>0&&!reference.info.cacheWriteIncluded&&!rate(cost.cacheWrite))return null;
 return (normal*cost.input+read*(cost.cacheRead??0)+write*(reference.info.cacheWriteIncluded?cost.input:cost.cacheWrite??0)+bucket.outputTokens*cost.output)/1e6;
}
