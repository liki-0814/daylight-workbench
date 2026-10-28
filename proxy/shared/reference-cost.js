import {validBins} from './usage-tiers.js';
const rate=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const bound=value=>Number.isSafeInteger(value)&&value>=0;
const tierRate=tier=>({input:rate(tier?.input)?tier.input:null,output:rate(tier?.output)?tier.output:null,cacheRead:rate(tier?.cacheRead)?tier.cacheRead:null,cacheWrite:rate(tier?.cacheWrite)?tier.cacheWrite:null});
// Price segments from the current catalog. Input length is the whole prompt (plain input + cache read + cache write).
// A tier applies when above < length <= atMost and, because the catalog notes describe "the whole request", then prices
// every component of that request. The catalog has no field for excess-only pricing, so that rule is not modelled.
// Gaps and ranges above the last bounded tier become unpriceable segments rather than guesses.
export function priceSchedule(reference){
 if(!reference||reference.info?.currency!=='USD'||reference.info.unit!=='per_1M_tokens'||!['official-reference','llm-pricing'].includes(reference.info.basis)||!reference.info.sources?.some(url=>typeof url==='string'&&url.startsWith('https://')))return null;
 const cost=reference.cost;
 if(!cost||!rate(cost.input)||!rate(cost.output))return null;
 const raw=Array.isArray(reference.tiers)?reference.tiers:cost.tiers===undefined?[]:Array.isArray(cost.tiers)?cost.tiers.map((tier,index,list)=>({...tier,above:tier?.inputTokensAbove,atMost:list[index+1]?.inputTokensAbove??null})):null;
 if(raw===null)return null;
 const included=!!reference.info.cacheWriteIncluded,write=rates=>included?rates.input:rates.cacheWrite;
 const segments=[];let lower=-1,upper=raw.length?raw[0]?.above:Infinity,rates=tierRate(cost);
 if(raw.length&&!bound(upper))return null;
 segments.push({above:lower,atMost:upper,rates:{...rates,cacheWrite:write(rates)}});
 for(const [index,tier] of raw.entries()){
  const top=tier?.atMost===null||tier?.atMost===undefined?Infinity:tier.atMost,next=raw[index+1];
  if(!bound(tier?.above)||top!==Infinity&&(!bound(top)||top<=tier.above)||tier.above<upper||top===Infinity&&next||next&&!bound(next.above))return null;
  if(tier.above>upper)segments.push({above:upper,atMost:tier.above,rates:null});
  const tierRates=tierRate(tier);segments.push({above:tier.above,atMost:top,rates:{...tierRates,cacheWrite:write(tierRates)}});
  upper=top;
 }
 if(upper!==Infinity)segments.push({above:upper,atMost:Infinity,rates:null});
 return segments;
}
export const tierRules=reference=>{const schedule=priceSchedule(reference);return schedule?.filter(segment=>segment.above>=0&&segment.rates).map(segment=>({above:segment.above,atMost:Number.isFinite(segment.atMost)?segment.atMost:null}))||[];};
const components=[['normal','input'],['read','cacheRead'],['write','cacheWrite'],['output','output']];
// Same-request components cannot be separated, so bounds use the cheapest/dearest rate of each component independently.
// This stays valid when some rates rise and others fall between tiers; it may be wider than the true amount.
function price(sums,schedule,lo,hi){
 const feasible=schedule.filter(segment=>hi>segment.above&&lo<=segment.atMost);
 if(!feasible.length||feasible.some(segment=>!segment.rates||!rate(segment.rates.input)||!rate(segment.rates.output)))return null;
 let min=0,max=0;
 for(const [field,key] of components){
  const tokens=sums[field];if(!tokens)continue;
  const rates=feasible.map(segment=>segment.rates[key]);if(rates.some(value=>!rate(value)))return null;
  min+=tokens*Math.min(...rates);max+=tokens*Math.max(...rates);
 }
 return Number.isFinite(min)&&Number.isFinite(max)?{min,max,exact:feasible.length===1}:null;
}
// Returns lower/upper USD bounds and the request counts they cover. Requests in `tiers` have an observed input-length
// range; requests without one (older aggregates) are bounded by every tier their count and token sum make possible.
export function referenceCostRange(bucket,reference){
 const schedule=priceSchedule(reference);
 if(!schedule||!bucket.tokenRequests)return null;
 const stored=bucket.tiers===undefined?[]:validBins(bucket.tiers)?bucket.tiers:[];
 // Detail that does not fit inside the bucket totals cannot be trusted; fall back to the aggregate-only estimate.
 const result=evaluate(bucket,schedule,stored);
 return result===undefined?evaluate(bucket,schedule,[]):result;
}
function evaluate(bucket,schedule,bins){
 const total=key=>bins.reduce((sum,bin)=>sum+bin[key],0),binned=total('requests');
 if(binned>bucket.tokenRequests||binned>bucket.cacheRequests||['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'].some(key=>total(key)>bucket[key]))return bins.length?undefined:null;
 let min=0,max=0,exact=0,estimated=0;
 const add=(result,requests)=>{if(!result)return;min+=result.min;max+=result.max;if(result.exact)exact+=requests;else estimated+=requests;};
 for(const bin of bins)add(price({normal:bin.inputTokens-bin.cacheReadTokens-bin.cacheWriteTokens,read:bin.cacheReadTokens,write:bin.cacheWriteTokens,output:bin.outputTokens},schedule,bin.minInput,bin.maxInput),bin.requests);
 const rest=bucket.tokenRequests-binned;
 if(rest>0&&bucket.cacheRequests-binned===rest){
  const input=bucket.inputTokens-total('inputTokens'),read=bucket.cacheReadTokens-total('cacheReadTokens'),write=bucket.cacheWriteTokens-total('cacheWriteTokens'),normal=input-read-write,output=bucket.outputTokens-total('outputTokens');
  if(normal<0||read<0||write<0||output<0)return bins.length?undefined:null;
  add(price({normal,read,write,output},schedule,rest===1?input:0,input),rest);
 }
 const covered=exact+estimated;
 return covered&&Number.isFinite(min)&&Number.isFinite(max)?{minUsd:min/1e6,maxUsd:max/1e6,exactRequests:exact,estimatedRequests:estimated,coveredRequests:covered}:null;
}
// A comparison against published API rates, never an account charge. Exact amount only; null while any part is estimated or unpriceable.
export function referenceCost(bucket,reference){
 const result=referenceCostRange(bucket,reference);
 return result&&result.coveredRequests===bucket.tokenRequests&&!result.estimatedRequests?result.minUsd:null;
}
