import test from 'node:test';
import assert from 'node:assert/strict';
import {referenceCost,referenceCostRange,priceSchedule,tierRules} from '../proxy/shared/reference-cost.js';
import {addTierBin,tierEdges} from '../proxy/shared/usage-tiers.js';

const info={currency:'USD',unit:'per_1M_tokens',basis:'llm-pricing',sources:['https://example.invalid/prices']};
// Same shape as the catalog: base rates plus one tier that applies above 272000 input tokens.
const two={cost:{input:2,output:10,cacheRead:.1,cacheWrite:2.5,tiers:[{inputTokensAbove:272000,input:4,output:15,cacheRead:.2,cacheWrite:5}]},info};
// Bounded tiers like the catalog's qwen entries: contiguous tiers, the last one closed.
const bounded={cost:{input:.05,output:.2,cacheRead:.005,cacheWrite:.06,tiers:null},info,tiers:[
 {above:32000,atMost:256000,input:.1,output:.4,cacheRead:.01,cacheWrite:.125},{above:256000,atMost:1000000,input:.2,output:.8,cacheRead:.02,cacheWrite:.25}]};
const request=(input,{read=0,write=0,output=0}={})=>({input,read,write,output});
const bucketOf=(requests,{binned=true,edges=tierEdges()}={})=>{
 const bucket={tokenRequests:requests.length,cacheRequests:requests.length,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0};
 for(const r of requests){bucket.inputTokens+=r.input;bucket.outputTokens+=r.output;bucket.cacheReadTokens+=r.read;bucket.cacheWriteTokens+=r.write;if(binned)bucket.tiers=addTierBin(bucket.tiers,r,edges);}
 return bucket;
};
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-12,`${actual} !== ${expected}`);

test('tier is selected per request by total input length: exactly at the threshold is the lower tier, one token above is the higher tier',()=>{
 const at=referenceCostRange(bucketOf([request(272000,{output:1000})]),two),above=referenceCostRange(bucketOf([request(272001,{output:1000})]),two);
 near(at.minUsd,(272000*2+1000*10)/1e6);near(above.minUsd,(272001*4+1000*15)/1e6);
 assert.equal(at.exactRequests,1);assert.equal(above.exactRequests,1);assert.equal(at.minUsd,at.maxUsd);
});

test('a whole request is priced at its tier: plain input, cache read, cache write and output, with reasoning only inside output',()=>{
 const long=request(300000,{read:200000,write:20000,output:5000});
 near(referenceCost(bucketOf([long]),two),(80000*4+200000*.2+20000*5+5000*15)/1e6);
 const short=request(100000,{read:60000,write:10000,output:5000});
 near(referenceCost(bucketOf([short]),two),(30000*2+60000*.1+10000*2.5+5000*10)/1e6);
 // Cache hits count towards the length even when the plain input alone is below the threshold.
 near(referenceCost(bucketOf([request(280000,{read:279000,output:0})]),two),(1000*4+279000*.2)/1e6);
});

test('short and long requests on the same day are priced separately and stay exact',()=>{
 const requests=[request(1000,{output:10}),request(272000,{read:100000,output:10}),request(272001,{read:100000,output:10}),request(900000,{write:1000,output:10})];
 const result=referenceCostRange(bucketOf(requests),two);
 const expected=(1000*2+10*10+(172000*2+100000*.1+10*10)+(172001*4+100000*.2+10*15)+(899000*4+1000*5+10*15))/1e6;
 near(result.minUsd,expected);near(result.maxUsd,expected);assert.equal(result.exactRequests,4);assert.equal(result.estimatedRequests,0);
});

test('multiple bounded tiers include the lower base range, close each boundary and leave lengths beyond the last tier unpriceable',()=>{
 const price=length=>referenceCostRange(bucketOf([request(length,{output:100})]),bounded);
 near(price(32000).minUsd,(32000*.05+100*.2)/1e6);near(price(32001).minUsd,(32001*.1+100*.4)/1e6);
 near(price(256000).minUsd,(256000*.1+100*.4)/1e6);near(price(256001).minUsd,(256001*.2+100*.8)/1e6);near(price(1000000).minUsd,(1000000*.2+100*.8)/1e6);
 assert.equal(price(1000001),null);
 assert.deepEqual(tierRules(bounded),[{above:32000,atMost:256000},{above:256000,atMost:1000000}]);
 const gapped={...bounded,tiers:[{above:32000,atMost:64000,input:1,output:1,cacheRead:1,cacheWrite:1},{above:128000,atMost:null,input:2,output:2,cacheRead:2,cacheWrite:2}]};
 assert.equal(referenceCostRange(bucketOf([request(100000)]),gapped),null);assert.ok(referenceCostRange(bucketOf([request(130000)]),gapped));
});

test('invalid or overlapping tier tables are rejected instead of guessed',()=>{
 for(const tiers of [[{above:10,atMost:5,input:1,output:1}],[{above:10,atMost:null,input:1,output:1},{above:20,atMost:null,input:1,output:1}],[{above:20,atMost:30,input:1,output:1},{above:10,atMost:15,input:1,output:1}],[{above:-1,atMost:null}],[{above:1.5,atMost:null}]])assert.equal(priceSchedule({...two,tiers}),null);
});

test('missing prices in the applicable tier make only those requests unpriceable and never zero',()=>{
 const incomplete={...two,cost:{...two.cost,tiers:[{inputTokensAbove:272000,input:4,output:15,cacheRead:null,cacheWrite:5}]}};
 assert.equal(referenceCostRange(bucketOf([request(300000,{read:10})]),incomplete),null);
 assert.ok(referenceCostRange(bucketOf([request(300000,{read:0})]),incomplete));
 const mixed=referenceCostRange(bucketOf([request(1000,{read:500,output:1}),request(300000,{read:10,output:1})]),incomplete);
 assert.equal(mixed.coveredRequests,1);near(mixed.minUsd,(500*2+500*.1+1*10)/1e6);
 assert.equal(referenceCostRange(bucketOf([request(1000,{read:1})]),{...two,cost:{...two.cost,cacheRead:null}}),null);
 assert.equal(referenceCostRange(bucketOf([request(1000,{write:1})]),{...two,cost:{...two.cost,cacheWrite:null}}),null);
});

test('cache writes included in input are priced as input in every tier',()=>{
 const included={...two,info:{...info,cacheWriteIncluded:true},cost:{...two.cost,cacheWrite:null,tiers:[{inputTokensAbove:272000,input:4,output:15,cacheRead:.2,cacheWrite:null}]}};
 near(referenceCost(bucketOf([request(300000,{write:100000,output:0})]),included),300000*4/1e6);
});

test('unbinned legacy totals produce a range from every tier the request count and token total allow',()=>{
 const one=bucketOf([request(272001,{output:10})],{binned:false});
 near(referenceCostRange(one,two).minUsd,(272001*4+150)/1e6);assert.equal(referenceCostRange(one,two).estimatedRequests,0);
 const many=bucketOf([request(100000,{output:10}),request(100000,{output:10}),request(100000,{output:10})],{binned:false});
 const range=referenceCostRange(many,two);
 assert.equal(range.estimatedRequests,3);assert.equal(range.exactRequests,0);assert.equal(referenceCost(many,two),null);
 near(range.minUsd,(300000*2+30*10)/1e6);near(range.maxUsd,(300000*4+30*15)/1e6);
 // 3 requests with 90000 tokens in total cannot include a 272001-token request, so the result is exact.
 const small=bucketOf([request(30000,{output:1}),request(30000,{output:1}),request(30000,{output:1})],{binned:false});
 assert.equal(referenceCostRange(small,two).estimatedRequests,0);assert.equal(referenceCostRange(small,two).exactRequests,3);
});

test('bounds stay valid when components move in opposite directions between tiers',()=>{
 // Long tier: dearer input and cache write, cheaper cache read and output.
 const mixed={cost:{input:2,output:10,cacheRead:1,cacheWrite:3,tiers:[{inputTokensAbove:1000,input:4,output:5,cacheRead:.5,cacheWrite:6}]},info};
 const legacy={tokenRequests:2,cacheRequests:2,inputTokens:3000,outputTokens:200,cacheReadTokens:2000,cacheWriteTokens:200};
 const range=referenceCostRange(legacy,mixed);
 near(range.minUsd,(800*2+2000*.5+200*3+200*5)/1e6);near(range.maxUsd,(800*4+2000*1+200*6+200*10)/1e6);
 // Neither all-short nor all-long totals bound the range; one short and one long request can fall outside both.
 const allShort=(800*2+2000*1+200*3+200*10)/1e6,allLong=(800*4+2000*.5+200*6+200*5)/1e6;
 assert.ok(range.minUsd<Math.min(allShort,allLong)&&range.maxUsd>Math.max(allShort,allLong));
});

// Deterministic generator so failures are reproducible.
const random=seed=>()=>(seed=(seed*1664525+1013904223)%4294967296)/4294967296;
test('property: aggregate and histogram ranges always contain the true per-request amount',()=>{
 const next=random(7),pick=list=>list[Math.floor(next()*list.length)],rate=()=>Math.round(next()*100)/10;
 for(let trial=0;trial<400;trial++){
  const thresholds=[...new Set(Array.from({length:1+Math.floor(next()*3)},()=>pick([1000,5000,32000,200000,272000])))].sort((a,b)=>a-b);
  const row=()=>({input:rate(),output:rate(),cacheRead:rate(),cacheWrite:rate()});
  const base=row(),tiers=thresholds.map(inputTokensAbove=>({inputTokensAbove,...row()}));
  const reference={cost:{...base,tiers},info};
  const requests=Array.from({length:1+Math.floor(next()*6)},()=>{
   const length=pick([1,999,1000,1001,4999,5001,31999,32001,200000,200001,272000,272001,500000,Math.floor(next()*600000)]);
   const read=Math.floor(next()*length),write=Math.floor(next()*(length-read));
   return request(length,{read,write,output:Math.floor(next()*50000)});
  });
  const truth=requests.reduce((sum,r)=>{
   const tier=[...tiers].reverse().find(t=>r.input>t.inputTokensAbove)||base;
   return sum+((r.input-r.read-r.write)*tier.input+r.read*tier.cacheRead+r.write*tier.cacheWrite+r.output*tier.output)/1e6;
  },0);
  const legacy=referenceCostRange(bucketOf(requests,{binned:false}),reference),binned=referenceCostRange(bucketOf(requests),reference);
  for(const range of [legacy,binned]){
   assert.ok(range.minUsd<=truth+1e-9&&truth<=range.maxUsd+1e-9,`trial ${trial}: ${range.minUsd} <= ${truth} <= ${range.maxUsd}`);
   assert.ok(Number.isFinite(range.minUsd)&&Number.isFinite(range.maxUsd)&&range.minUsd<=range.maxUsd);
  }
  assert.ok(binned.maxUsd-binned.minUsd<=legacy.maxUsd-legacy.minUsd+1e-9);
 }
});

test('non-finite, negative or oversized inputs never produce NaN, Infinity or a zero fee',()=>{
 const bucket=bucketOf([request(1000,{output:1})]);
 for(const reference of [{...two,cost:{...two.cost,input:Infinity}},{...two,cost:{...two.cost,output:NaN}},{...two,cost:{...two.cost,tiers:[{inputTokensAbove:Infinity,input:1,output:1}]}},{...two,cost:{...two.cost,input:-1}}])assert.equal(referenceCostRange(bucket,reference),null);
 const huge={...bucket,outputTokens:Number.MAX_VALUE,tiers:undefined,tokenRequests:1,cacheRequests:1,inputTokens:10,cacheReadTokens:0,cacheWriteTokens:0};
 assert.equal(referenceCostRange({...huge,outputTokens:Number.MAX_VALUE},{...two,cost:{...two.cost,output:Number.MAX_VALUE}}),null);
 assert.equal(referenceCostRange({...bucket,tokenRequests:0},two),null);
 assert.equal(referenceCostRange({...bucket,tiers:[{upTo:null,requests:1,minInput:5,maxInput:1,inputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0}]},two).coveredRequests,1);
});

test('mixed coverage prices known-cache requests and leaves cache-unknown ones out',()=>{
 const known=bucketOf([request(1000,{read:100,output:10}),request(400000,{read:1000,output:10})]);
 const bucket={...known,tokenRequests:3,inputTokens:known.inputTokens+777,outputTokens:known.outputTokens+5};
 const range=referenceCostRange(bucket,two);
 assert.equal(range.coveredRequests,2);assert.equal(range.exactRequests,2);
 near(range.minUsd,(900*2+100*.1+100+(399000*4+1000*.2+150))/1e6);
 assert.equal(referenceCost(bucket,two),null);
});

test('histogram detail that contradicts the bucket totals is ignored instead of dropping covered requests',()=>{
 const good=bucketOf([request(1000,{read:100,output:10}),request(400000,{read:1000,output:10})]);
 // Totals smaller than the detail (input/cache/output) or leaving a negative remainder cannot be right.
 const bad={...good,tokenRequests:3,cacheRequests:3,inputTokens:good.inputTokens+10,cacheReadTokens:good.cacheReadTokens+500,outputTokens:good.outputTokens+1};
 const range=referenceCostRange(bad,two);assert.equal(range.coveredRequests,3);assert.equal(range.estimatedRequests,3);
 const smaller={...good,outputTokens:5};assert.equal(referenceCostRange(smaller,two).estimatedRequests,2);
 const negativeOutput={...good,tokenRequests:3,cacheRequests:3,inputTokens:good.inputTokens+100,outputTokens:good.outputTokens-1};
 assert.ok(referenceCostRange(negativeOutput,two).minUsd>=0);
});
