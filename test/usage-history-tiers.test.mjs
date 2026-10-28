import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {UsageHistory} from '../proxy/shared/usage-history.js';
const now=()=>new Date('2026-10-27T08:00:00Z');
const info={basis:'llm-pricing',currency:'USD',unit:'per_1M_tokens',sources:['https://example.invalid/prices'],updatedAt:'2026-10-27'};
const pricing=(above=272000,tier={input:4,output:15,cacheRead:.2,cacheWrite:5})=>({cost:{input:2,output:10,cacheRead:.1,cacheWrite:2.5,tiers:[{inputTokensAbove:above,...tier}]},info,tiers:[{above,atMost:null,...tier}]});
const model=(id,referencePricing)=>({id,aliases:[],referencePricing});
let counter=0;
const row=(input,{read=0,write,output=10,day='2026-10-27',source='p',sourceModel='big',usage}={})=>({id:'r'+counter++,time:day+'T01:00:00Z',provider:source,sourceModel,outcome:'completed',status:200,usage:usage||{inputTokens:input,outputTokens:output,cacheReadTokens:read,...(write===undefined?{}:{cacheWriteTokens:write})}});
async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'daylight-tiers-'));t.after(()=>rm(dir,{recursive:true,force:true}));return path.join(dir,'usage-history.json');}
const cost=(rows,rates)=>rows.reduce((sum,r)=>sum+((r.usage.inputTokens>272000?rates.long:rates.short)(r)),0)/1e6;
const short=r=>(r.usage.inputTokens-r.usage.cacheReadTokens-(r.usage.cacheWriteTokens||0))*2+r.usage.cacheReadTokens*.1+(r.usage.cacheWriteTokens||0)*2.5+r.usage.outputTokens*10;
const long=r=>(r.usage.inputTokens-r.usage.cacheReadTokens-(r.usage.cacheWriteTokens||0))*4+r.usage.cacheReadTokens*.2+(r.usage.cacheWriteTokens||0)*5+r.usage.outputTokens*15;
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-12,`${a} !== ${b}`);
const totals=report=>{const {summary}=report;return{requests:summary.requests,input:summary.inputTokens,output:summary.outputTokens,read:summary.cacheReadTokens};};
// Rewrites the stored file as an older app would have left it: totals only, no pricing histogram.
async function downgrade(file){const state=JSON.parse(await readFile(file,'utf8'));state.buckets=state.buckets.map(({tiers,...bucket})=>bucket);delete state.tieredIds;delete state.tierBackfilledRequests;await writeFile(file,JSON.stringify(state));return state;}

test('new requests are priced per request by input length and only a bounded histogram is stored',async t=>{
 const file=await fixture(t),history=await UsageHistory.load(file,[],{now,timeZone:'Asia/Shanghai'});
 history.setModelCatalog('p',[model('big',pricing())]);
 const rows=[row(1000,{read:500}),row(272000,{read:100000,write:1000}),row(272001,{read:100000,write:1000,output:7}),row(900000,{read:1,output:3}),{...row(5,{}),prompt:'PRIVATE PROMPT',response:'PRIVATE ANSWER'}];
 for(const item of rows)await history.append(item);
 const report=history.report({}),expected=cost(rows,{short,long});
 near(report.summary.referenceCostUsd,expected);near(report.summary.referenceCostMinUsd,report.summary.referenceCostMaxUsd);
 assert.equal(report.summary.pricedRequests,5);assert.equal(report.summary.estimatedRequests,0);assert.equal(report.summary.requests,5);
 assert.deepEqual(report.references[0].tiers,[{above:272000,atMost:null}]);
 assert.ok(!(await readFile(file,'utf8')).includes('PRIVATE'));
 // Bounded growth: thousands of requests never grow the stored detail beyond the fixed edges.
 let seed=3;for(let i=0;i<3000;i++){seed=(seed*1103515245+12345)%2147483648;await history.append(row(1+seed%1500000,{read:0,output:1}));}
 const bucket=history.state.buckets[0];assert.ok(bucket.tiers.length<=20,`bins ${bucket.tiers.length}`);assert.equal(bucket.tiers.reduce((sum,bin)=>sum+bin.requests,0),bucket.tokenRequests);
 assert.ok(history.state.tieredIds.length<=2000);const size=(await readFile(file,'utf8')).length;assert.ok(size<100000,'file size '+size);
 assert.equal(history.report({}).summary.estimatedRequests,0);
});

test('old aggregates are recovered from retained records, repeated startups change nothing, and unrecoverable requests become a labelled range',async t=>{
 const file=await fixture(t),all=[row(1000,{read:10}),row(300000,{read:1000,output:20}),row(500000,{read:5,write:5,output:30}),row(40000,{read:0,output:4}),row(272001,{read:3,output:4})];
 let history=await UsageHistory.load(file,all,{now,timeZone:'Asia/Shanghai'});
 history.setModelCatalog('p',[model('big',pricing())]);await history.flush();
 const truth=cost(all,{short,long}),legacyState=await downgrade(file);
 assert.ok(legacyState.buckets.every(b=>!b.tiers));
 // Before: legacy file, no detail retained at all -> estimate range that must contain the truth.
 history=await UsageHistory.load(file,[],{now});
 const before=history.report({}).summary;assert.equal(before.estimatedRequests,5);assert.equal(before.referenceCostUsd,null);
 assert.ok(before.referenceCostMinUsd<=truth&&truth<=before.referenceCostMaxUsd);assert.ok(before.referenceCostMinUsd<before.referenceCostMaxUsd);
 // Partial retention: only the latest two rows remain, so two requests are recovered and three stay estimated.
 history=await UsageHistory.load(file,all.slice(-2),{now});
 const partial=history.report({}).summary;assert.equal(history.state.tierBackfilledRequests,2);assert.equal(partial.estimatedRequests,3);
 assert.ok(partial.referenceCostMinUsd<=truth&&truth<=partial.referenceCostMaxUsd);assert.ok(partial.referenceCostMaxUsd-partial.referenceCostMinUsd<=before.referenceCostMaxUsd-before.referenceCostMinUsd);
 // Full retention recovers everything exactly. Totals are untouched and repeated startups are idempotent.
 await downgrade(file);
 history=await UsageHistory.load(file,all,{now});
 const exact=history.report({});near(exact.summary.referenceCostUsd,truth);assert.equal(exact.summary.estimatedRequests,0);assert.equal(exact.summary.pricedRequests,5);
 const stored=await readFile(file,'utf8');
 for(let i=0;i<3;i++){history=await UsageHistory.load(file,all,{now});assert.equal(await readFile(file,'utf8'),stored);near(history.report({}).summary.referenceCostUsd,truth);}
 assert.equal(history.state.tierBackfilledRequests,5);assert.deepEqual(totals(history.report({})),{requests:5,input:all.reduce((s,r)=>s+r.usage.inputTokens,0),output:all.reduce((s,r)=>s+r.usage.outputTokens,0),read:all.reduce((s,r)=>s+r.usage.cacheReadTokens,0)});
 // A new request after migration is added once, even if the retained log is replayed again.
 const fresh=row(350000,{read:1,output:2});await history.append(fresh);
 history=await UsageHistory.load(file,[...all,fresh],{now});history=await UsageHistory.load(file,[...all,fresh],{now});
 near(history.report({}).summary.referenceCostUsd,cost([...all,fresh],{short,long}));assert.equal(history.report({}).summary.requests,6);
});

test('statistics filters keep amount, covered counts, daily trend and distributions consistent',async t=>{
 const file=await fixture(t),rows=[
  row(1000,{read:1}),row(400000,{read:2,output:5}),row(272001,{read:0}),row(5000,{day:'2026-10-26',read:1}),row(300000,{day:'2026-10-26',read:7}),
  row(300000,{day:'2026-10-26',source:'q',sourceModel:'small',read:7}),row(100,{source:'q',sourceModel:'small',read:0}),row(100,{source:'q',sourceModel:'nopricing',read:0})];
 const history=await UsageHistory.load(file,rows,{now,timeZone:'Asia/Shanghai'});
 history.setModelCatalog('p',[model('big',pricing())]);history.setModelCatalog('q',[model('small',{cost:{input:1,output:1,cacheRead:.5,cacheWrite:null},info}),model('nopricing')]);
 const check=query=>{
  const report=history.report(query),sum=key=>list=>list.reduce((total,item)=>total+(item[key]||0),0);
  for(const key of ['referenceCostMinUsd','referenceCostMaxUsd','pricedRequests','estimatedRequests','requests']){
   for(const list of [report.daily,report.models,report.sources])near(sum(key)(list),report.summary[key]||0);
  }
  assert.ok(report.summary.referenceCostMinUsd<=report.summary.referenceCostMaxUsd);return report;
 };
 const everything=check({from:'2026-10-26',to:'2026-10-27'});assert.equal(everything.summary.requests,8);assert.equal(everything.summary.pricedRequests,7);assert.equal(everything.summary.estimatedRequests,0);
 near(everything.summary.referenceCostUsd,cost(rows.slice(0,5),{short,long})+(299993+7*.5+10+100+10)/1e6);
 const big=check({from:'2026-10-26',to:'2026-10-27',source:'p',model:'big'});assert.equal(big.summary.requests,5);near(big.summary.referenceCostUsd,cost(rows.slice(0,5),{short,long}));
 assert.equal(check({from:'2026-10-27',to:'2026-10-27',source:'p'}).summary.requests,3);
 const none=check({from:'2026-10-26',to:'2026-10-27',source:'q',model:'nopricing'});assert.equal(none.summary.pricedRequests,0);assert.equal(none.summary.referenceCostUsd,null);assert.equal(none.summary.referenceCostMinUsd,null);
 // The unpriceable model does not drag down priced requests in the same source.
 const q=check({from:'2026-10-26',to:'2026-10-27',source:'q'});assert.equal(q.summary.requests,3);assert.equal(q.summary.pricedRequests,2);
 assert.equal(q.models.find(m=>m.id==='nopricing').referenceCostUsd,null);assert.ok(q.models.find(m=>m.id==='small').referenceCostUsd>0);
 assert.deepEqual(check({from:'2026-10-26',to:'2026-10-26'}).daily.map(d=>d.day),['2026-10-26']);
});

test('price refresh recomputes history with the current catalog and moving a threshold only widens bins it cuts',async t=>{
 const file=await fixture(t),rows=[row(300000,{read:10,output:10}),row(350000,{read:10,output:10})];
 const history=await UsageHistory.load(file,rows,{now,timeZone:'Asia/Shanghai'});
 history.setModelCatalog('p',[model('big',pricing())]);
 const first=history.report({}).summary;near(first.referenceCostUsd,cost(rows,{short,long}));
 history.setModelCatalog('p',[model('big',pricing(272000,{input:8,output:30,cacheRead:.4,cacheWrite:10}))]);
 const repriced=history.report({}).summary;assert.ok(repriced.referenceCostUsd>first.referenceCostUsd);assert.equal(repriced.inputTokens,first.inputTokens);
 // The threshold now falls between the two requests: they are in one bin whose lengths straddle it.
 history.setModelCatalog('p',[model('big',pricing(320000))]);
 const cut=history.report({}).summary;assert.equal(cut.estimatedRequests,2);assert.equal(cut.referenceCostUsd,null);
 near(cut.referenceCostMinUsd,(649980*2+20*.1+20*10)/1e6);near(cut.referenceCostMaxUsd,(649980*4+20*.2+20*15)/1e6);
 history.setModelCatalog('p',[model('big',pricing(272000))]);near(history.report({}).summary.referenceCostUsd,first.referenceCostUsd);
});

test('unusable stored pricing detail is dropped without disabling permanent totals; missing prices are never zero',async t=>{
 const file=await fixture(t),rows=[row(300000,{read:1}),row(1000,{read:1})];
 let history=await UsageHistory.load(file,rows,{now,timeZone:'Asia/Shanghai'});history.setModelCatalog('p',[model('big',pricing())]);await history.flush();
 const state=JSON.parse(await readFile(file,'utf8'));state.buckets[0].tiers=[{upTo:5,requests:-1}];await writeFile(file,JSON.stringify(state));
 history=await UsageHistory.load(file,rows,{now});assert.equal(history.disabled,false);assert.equal(history.report({}).summary.requests,2);
 assert.equal(history.report({}).summary.pricedRequests,2);assert.equal(history.report({}).summary.estimatedRequests,2);
 const miss={cacheRead:null,input:4,output:15,cacheWrite:5};
 history.setModelCatalog('p',[model('big',{cost:{input:2,output:10,cacheRead:null,cacheWrite:2.5,tiers:[{inputTokensAbove:272000,...miss}]},info,tiers:[{above:272000,atMost:null,...miss}]})]);
 const report=history.report({}).summary;assert.equal(report.pricedRequests,0);assert.equal(report.referenceCostUsd,null);assert.equal(report.referenceCostMinUsd,null);
});
