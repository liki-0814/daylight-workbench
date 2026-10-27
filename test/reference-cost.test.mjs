import test from 'node:test';
import assert from 'node:assert/strict';
import {referenceCost} from '../proxy/shared/reference-cost.js';
import {formatTokens,formatUsd} from '../public/components/format-number.js';
const bucket={tokenRequests:1,cacheRequests:1,inputTokens:1000,outputTokens:100,cacheReadTokens:800,cacheWriteTokens:50};
const reference={cost:{input:3,output:15,cacheRead:.3,cacheWrite:4},info:{currency:'USD',unit:'per_1M_tokens',basis:'official-reference',sources:['https://example.invalid/official-pricing']}};

test('API reference arithmetic separates cache from input, includes reasoning only within output and supports included cache writes',()=>{
 assert.equal(referenceCost(bucket,reference),.00239);
 assert.equal(referenceCost(bucket,{...reference,info:{...reference.info,cacheWriteIncluded:true}}),.00234);
 assert.equal(referenceCost({...bucket,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0},reference),0);
});
test('unknown usage, unsupported tiers or missing official reference never become a zero fee',()=>{
 for(const [b,r] of [[{...bucket,cacheRequests:0},reference],[bucket,{...reference,cost:{...reference.cost,cacheRead:null}}],[bucket,{...reference,cost:{...reference.cost,cacheWrite:null}}],[bucket,{...reference,cost:{...reference.cost,tiers:[{inputTokensAbove:200000}]}}],[bucket,{...reference,info:{...reference.info,basis:'upstream'}}],[bucket,{...reference,info:{...reference.info,unit:'per_token'}}],[bucket,undefined]])assert.equal(referenceCost(b,r),null);
});
test('Token display consistently uses M/B at the billion boundary and preserves small counts',()=>{
 assert.equal(formatTokens(2458000000),'2.46B');assert.equal(formatTokens(1e9),'1B');assert.equal(formatTokens(999000000),'999M');assert.equal(formatTokens(1e6),'1M');assert.equal(formatTokens(39400),'0.0394M');assert.equal(formatTokens(0),'0M');assert.equal(formatTokens(null),'—');assert.equal(formatUsd(.000001),'<$0.0001');assert.equal(formatUsd(0),'$0.00');assert.equal(formatUsd(null),'—');
});
