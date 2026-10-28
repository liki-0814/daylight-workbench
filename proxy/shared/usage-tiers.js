// Bounded per-day pricing detail. Requests are grouped into a small histogram of input length instead of being logged.
const num=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const sum=['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'];
// Storage grid only; prices and thresholds always come from the current reference catalog. Catalog thresholds are added
// as extra edges so bins line up with them, and each bin also keeps its observed min/max length.
const gridEdges=[8000,16000,32000,64000,100000,128000,200000,256000,272000,400000,512000,1000000,2000000];
const maxCatalogEdges=64;
export function tierEdges(catalogs=[]){
 const found=new Set();
 for(const entry of catalogs){
  const pricing=entry?.pricing;
  for(const tier of pricing?.tiers||[])for(const value of [tier?.above,tier?.atMost])found.add(value);
  for(const tier of pricing?.cost?.tiers||[])found.add(tier?.inputTokensAbove);
 }
 const extra=[...found].filter(value=>Number.isSafeInteger(value)&&value>0).sort((a,b)=>a-b).slice(0,maxCatalogEdges);
 return [...new Set([...gridEdges,...extra])].sort((a,b)=>a-b);
}
// A request is priceable only with real input/output and an explicit cache-read count; cache write defaults to none.
export function requestShape(usage){
 if(!usage||usage.estimated||!num(usage.inputTokens)||!num(usage.outputTokens)||!num(usage.cacheReadTokens))return null;
 const write=num(usage.cacheWriteTokens)?usage.cacheWriteTokens:0;
 if(usage.cacheReadTokens+write>usage.inputTokens)return null;
 return{input:usage.inputTokens,read:usage.cacheReadTokens,write,output:usage.outputTokens};
}
export function addTierBin(tiers=[],shape,edges){
 const upTo=edges.find(edge=>edge>=shape.input)??null,next=tiers.map(bin=>({...bin}));
 let bin=next.find(item=>item.upTo===upTo);
 if(!bin){bin={upTo,requests:0,minInput:shape.input,maxInput:shape.input,inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0};next.push(bin);}
 bin.requests++;bin.minInput=Math.min(bin.minInput,shape.input);bin.maxInput=Math.max(bin.maxInput,shape.input);
 bin.inputTokens+=shape.input;bin.cacheReadTokens+=shape.read;bin.cacheWriteTokens+=shape.write;bin.outputTokens+=shape.output;
 return next.sort((a,b)=>(a.upTo??Infinity)-(b.upTo??Infinity));
}
export function validBins(tiers){
 if(!Array.isArray(tiers))return false;
 const keys=new Set();
 return tiers.every(bin=>{
  if(!bin||typeof bin!=='object'||!(bin.upTo===null||Number.isSafeInteger(bin.upTo)&&bin.upTo>0)||keys.has(bin.upTo))return false;
  keys.add(bin.upTo);
  return Number.isSafeInteger(bin.requests)&&bin.requests>0&&sum.every(key=>num(bin[key]))&&num(bin.minInput)&&num(bin.maxInput)&&bin.minInput<=bin.maxInput&&
   bin.minInput*bin.requests<=bin.inputTokens&&bin.inputTokens<=bin.maxInput*bin.requests&&bin.cacheReadTokens+bin.cacheWriteTokens<=bin.inputTokens;
 });
}
