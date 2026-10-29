import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {UsageHistory,usageDay} from '../proxy/shared/usage-history.js';
import {RequestRecords} from '../proxy/shared/request-records.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const now=()=>new Date('2026-10-27T08:00:00Z');
const row=(id,extra={})=>({id,time:'2026-10-27T01:00:00Z',provider:'source',sourceModel:'model',outcome:'completed',status:200,usage:{inputTokens:100,outputTokens:20,cacheReadTokens:80},...extra});
async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'daylight-history-'));t.after(()=>rm(dir,{recursive:true,force:true}));return path.join(dir,'usage-history.json');}

test('permanent summaries survive more than 1000 requests, restart replay and dates older than 90 days',async t=>{
 const file=await fixture(t),rows=Array.from({length:1200},(_,i)=>row('id-'+i));
 rows[0]=row('id-0',{time:'2025-01-01T01:00:00Z'});
 let history=await UsageHistory.load(file,rows,{now,timeZone:'Asia/Shanghai'});
 assert.equal(history.report({}).summary.requests,1199);
 assert.equal(history.report({from:'2025-01-01',to:'2025-01-01'}).summary.requests,1);
 assert.equal(history.state.buckets.length,2);assert.equal(history.state.importedRequests,1200);
 history=await UsageHistory.load(file,rows.slice(-1000),{now});
 assert.equal(history.report({}).summary.requests,1199);assert.equal(history.state.timeZone,'Asia/Shanghai');
 await history.append(row('id-1200'));await history.append(row('id-1200'));await history.flush();
 assert.equal(history.report({}).summary.requests,1200);
 assert.equal((await UsageHistory.load(file,[row('id-1200')],{now})).report({}).summary.requests,1200);
 assert.equal(history.report({}).retention,'permanent');
});

test('tokens are authoritative, cache weighted and reasoning stays within output; tests and unknown usage are separate',async t=>{
 const file=await fixture(t),history=await UsageHistory.load(file,[row('a',{usage:{inputTokens:100,outputTokens:20,cacheReadTokens:80,cacheWriteTokens:10,outputDetails:{reasoning_tokens:5}},prompt:'PRIVATE',response:'PRIVATE'}),
 row('b',{usage:{inputTokens:900,outputTokens:80,cacheReadTokens:90}}),row('c',{usage:{inputTokens:50}}),row('d',{usage:{inputTokens:50,outputTokens:10,estimated:true}}),row('e',{origin:'test'}),
 row('f',{outcome:'cancelled',status:499,usage:undefined}),row('g',{outcome:'failed',status:502,usage:undefined}),row('h',{outcome:'timeout',status:504,usage:undefined})],{now,timeZone:'Asia/Shanghai'});
 const report=history.report({}),s=report.summary;
 assert.equal(s.requests,7);assert.equal(s.tokenRequests,2);assert.equal(s.totalTokens,1100);assert.equal(s.cacheHitRate,.17);assert.equal(s.cacheWriteTokens,10);assert.equal(s.reasoningTokens,5);
 assert.equal(s.succeeded,4);assert.equal(s.cancelled,1);assert.equal(s.failed,1);assert.equal(s.timedOut,1);assert.equal(s.successRate,4/6);
 assert.equal(report.partial,true);assert.equal(report.models[0].requests,7);
 assert.doesNotMatch(await readFile(file,'utf8'),/PRIVATE|prompt|response/);
});

test('calendar boundaries, filters, missing days and validation use the persisted statistics timezone',async t=>{
 const file=await fixture(t),history=await UsageHistory.load(file,[row('a',{time:'2026-10-26T15:59:59Z'}),row('b',{time:'2026-10-26T16:00:00Z',provider:'other',sourceModel:'other-model'})],{now,timeZone:'Asia/Shanghai'});
 assert.equal(usageDay('2026-10-26T16:00:00Z','Asia/Shanghai'),'2026-10-27');
 const report=history.report({from:'2026-10-25',to:'2026-10-27',source:'other'});
 assert.deepEqual(report.daily.map(d=>d.requests),[0,0,1]);assert.deepEqual(report.options.sources,['other','source']);assert.deepEqual(report.options.models,['other-model']);
 assert.equal(history.report({model:'missing'}).summary.totalTokens,null);assert.equal(history.report({model:'missing'}).summary.successRate,null);
 assert.throws(()=>history.report({from:'2026-02-30',to:'2026-10-27'}),{status:400});assert.throws(()=>history.report({to:'2026-10-28'}),{status:400});
});

test('corrupt history is preserved and leaves recent request logging operational',async t=>{
 const file=await fixture(t);await writeFile(file,'null');
 const records=await RequestRecords.load(path.join(path.dirname(file),'usage.json'));
 await records.append(row('real'));assert.equal(records.rows.length,1);assert.match(records.error,/历史统计/);assert.throws(()=>records.statistics(),{status:503});assert.equal(await readFile(file,'utf8'),'null');
});

test('a failed aggregate write remains visible and the next write persists the pending counters without duplication',async t=>{
 const file=await fixture(t),history=await UsageHistory.load(file,[],{now,timeZone:'Asia/Shanghai'});
 await rm(file);await mkdir(file);history.append(row('one'));await history.flush();assert.match(history.error,/保存失败/);
 await rm(file,{recursive:true});history.append(row('two'));await history.flush();assert.equal(history.error,'');
 const reloaded=await UsageHistory.load(file,[row('one'),row('two')],{now});assert.equal(reloaded.report({}).summary.requests,2);
});

test('a stale diagnostic snapshot cannot duplicate permanent totals even after the ID window rolls over',async t=>{
 const file=await fixture(t),seed=row('seed'),history=await UsageHistory.load(file,[seed],{now,timeZone:'Asia/Shanghai'});
 // Simulate aggregate commits while the recent-log destination remains unwritable.
 for(let i=0;i<2100;i++)history.next(row('new-'+i));
 assert.equal(history.state.seenIds.includes('seed'),false);
 await writeFile(file,JSON.stringify(history.state));
 const recovered=await UsageHistory.load(file,[seed],{now});
 assert.equal(recovered.report({}).summary.requests,2101);
});

test('invalid-request model metadata cannot make the persisted aggregate schema unreadable',async t=>{
 const file=await fixture(t),legacy=row(42,{sourceModel:undefined,model:42,provider:undefined,outcome:'failed',status:400});
 const history=await UsageHistory.load(file,[legacy],{now,timeZone:'Asia/Shanghai'});
 assert.equal(history.report({}).models[0].id,'42');
 const reloaded=await UsageHistory.load(file,[legacy],{now});assert.equal(reloaded.disabled,false);assert.equal(reloaded.report({}).summary.requests,1);
});

test('source-owned catalog aliases merge permanent historic totals and model filters, including native Qoder context suffixes',async t=>{
 const file=await fixture(t),rows=[...Array.from({length:790},(_,i)=>row('new-'+i,{provider:'qoder',sourceModel:'deepseek-flash'})),...Array.from({length:130},(_,i)=>row('old-'+i,{provider:'qoder',sourceModel:undefined,model:'dfmodel'})),row('custom',{provider:'custom:one',sourceModel:'dfmodel'}),row('window',{provider:'qoder',sourceModel:undefined,model:'dfmodel[200k]'})];
 const history=await UsageHistory.load(file,rows,{now,timeZone:'Asia/Shanghai'});
 history.setModelCatalog('qoder',[{id:'deepseek-flash',upstreamId:'dfmodel',aliases:['dfmodel']}]);await history.flush();
 const report=history.report({});assert.equal(report.models.find(m=>m.id==='deepseek-flash').requests,921);assert.equal(report.models.find(m=>m.id==='dfmodel').requests,1);assert.equal(history.report({model:'deepseek-flash'}).summary.requests,921);
 const restored=await UsageHistory.load(file,[],{now});assert.equal(restored.report({source:'qoder'}).models.length,1);assert.equal(restored.report({}).summary.requests,922);
});

test('reference amounts are recalculated using current source-specific public API rates without changing stored token totals',async t=>{
 const file=await fixture(t),history=await UsageHistory.load(file,[row('old',{provider:'qoder',sourceModel:'dfmodel'}),row('new',{provider:'qoder',sourceModel:'deepseek-flash'})],{now,timeZone:'Asia/Shanghai'});
 const model={id:'deepseek-flash',aliases:['dfmodel'],referencePricing:{cost:{input:1,output:2,cacheRead:.1,cacheWrite:null},info:{basis:'official-reference',currency:'USD',unit:'per_1M_tokens',sources:['https://example.invalid/prices'],updatedAt:'2026-10-27'}}};
 history.setModelCatalog('qoder',[model]);const before=history.report({});assert.equal(before.summary.referenceCostUsd,.000136);assert.equal(before.summary.pricedRequests,2);assert.equal(before.models.length,1);
 history.setModelCatalog('qoder',[{...model,referencePricing:{...model.referencePricing,cost:{...model.referencePricing.cost,input:2}}}]);
 const after=history.report({});assert.equal(after.summary.totalTokens,before.summary.totalTokens);assert.equal(after.summary.referenceCostUsd,.000176);assert.equal(after.references[0].updatedAt,'2026-10-27');
});

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const identity=async file=>{const info=await stat(file);return info.ino+':'+info.mtimeMs;};

test('a request mutates only its own bucket and the ID window; every other bucket, the bucket list and the caps are untouched',async t=>{
 const file=await fixture(t),rows=[];
 for(let s=0;s<20;s++)for(let m=0;m<10;m++)rows.push(row(`seed-${s}-${m}`,{provider:'src'+s,sourceModel:'model'+m}));
 const history=await UsageHistory.load(file,rows,{now,timeZone:'Asia/Shanghai',flushDelayMs:60000});
 const list=history.state.buckets,seen=history.state.seenIds,before=list.map(bucket=>({bucket,json:JSON.stringify(bucket)}));
 assert.equal(list.length,200);
 history.append(row('hit',{provider:'src3',sourceModel:'model4'}));
 assert.equal(history.state.buckets,list);assert.equal(list.length,200);assert.equal(history.state.seenIds,seen);
 const changed=before.filter(item=>JSON.stringify(item.bucket)!==item.json);
 assert.equal(changed.length,1);assert.equal(changed[0].bucket.source+changed[0].bucket.model,'src3model4');assert.equal(changed[0].bucket.requests,2);
 history.append(row('new-source',{provider:'fresh',sourceModel:'model0'}));
 assert.equal(list.length,201);assert.equal(history.state.buckets.at(-1).source,'fresh');
 history.append(row('hit'));history.append(row('origin',{origin:'test'}));
 assert.equal(list.length,201);assert.equal(history.report({}).summary.requests,202);
 for(let i=0;i<2100;i++)history.append(row('cap-'+i));
 assert.equal(history.state.seenIds.length,2000);assert.equal(history.state.tieredIds.length,2000);assert.equal(history.seen.size,2000);
 assert.equal(history.state.seenIds.at(-1),'cap-2099');
 const count=history.report({}).summary.requests;history.append(row('cap-2099'));assert.equal(history.report({}).summary.requests,count);
 await history.close();
});

test('disk writes are debounced into one atomic write per burst, and an explicit flush writes immediately',async t=>{
 const file=await fixture(t),history=await UsageHistory.load(file,[],{now,timeZone:'Asia/Shanghai',flushDelayMs:60}),initial=await identity(file);
for(let i=0;i<50;i++)history.append(row('burst-'+i));
 assert.equal(history.report({}).summary.requests,50,'memory is current immediately');
 assert.equal(JSON.parse(await readFile(file,'utf8')).buckets.length,0,'nothing written inside the window');assert.equal(await identity(file),initial);
 await sleep(400);
 const written=await identity(file);assert.notEqual(written,initial);
 assert.equal(JSON.parse(await readFile(file,'utf8')).buckets[0].requests,50);
 await sleep(200);assert.equal(await identity(file),written,'one write covered the whole burst and none follows');
 history.append(row('late'));await history.flush();assert.notEqual(await identity(file),written);
 assert.equal(JSON.parse(await readFile(file,'utf8')).buckets[0].requests,51);
 const idle=await identity(file);await history.flush();assert.equal(await identity(file),idle,'flush without changes does not rewrite');
 assert.equal((await readFile(file,'utf8')).includes('.tmp'),false);
 assert.deepEqual((await readdir(path.dirname(file))).filter(name=>name.endsWith('.tmp')),[]);
 await history.close();
});

test('close, RequestRecords.close and process exit persist pending statistics',async t=>{
 const file=await fixture(t),history=await UsageHistory.load(file,[],{now,timeZone:'Asia/Shanghai',flushDelayMs:60000});
 history.append(row('closing'));assert.equal(JSON.parse(await readFile(file,'utf8')).buckets.length,0);
 await history.close();assert.equal((await UsageHistory.load(file,[],{now})).report({}).summary.requests,1);

 const dir=path.dirname(file),records=await RequestRecords.load(path.join(dir,'usage.json'));
 await records.append(row('via-records',{time:new Date().toISOString()}));
 await records.close();
 const stored=JSON.parse(await readFile(path.join(dir,'usage-history.json'),'utf8'));
 assert.equal(stored.buckets.reduce((sum,bucket)=>sum+bucket.requests,0),2);assert.ok(stored.recentSnapshotHash);

 const script=fileURLToPath(new URL('../proxy/shared/usage-history.js',import.meta.url));
 for(const mode of ['process.exit(0)','/* natural end */']){
  const target=path.join(dir,mode.length>12?'natural.json':'exit.json');
  const source=`import {UsageHistory} from ${JSON.stringify(script)};const h=await UsageHistory.load(${JSON.stringify(target)},[],{timeZone:'Asia/Shanghai',flushDelayMs:60000});h.append({id:'child',time:new Date().toISOString(),provider:'p',sourceModel:'m',outcome:'completed',status:200});${mode}`;
  await promisify(execFile)(process.execPath,['--input-type=module','-e',source]);
  assert.equal((await UsageHistory.load(target,[],{now:()=>new Date(Date.now()+86400000)})).report({from:usageDay(Date.now(),'Asia/Shanghai')}).summary.requests,1,mode);
 }
});
