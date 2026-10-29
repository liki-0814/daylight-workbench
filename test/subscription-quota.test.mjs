import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {kimiQuota} from '../proxy/kimi/quota.js';
import {grokQuota} from '../proxy/grok/quota.js';
import {KimiProvider} from '../proxy/kimi/provider.js';
import {CodexProvider} from '../proxy/codex/provider.js';
import { closeWorkbench } from '../fixtures/workbench.mjs';
import {renderQuota} from '../public/proxy/quota-panel.js';
import {normalizeQuota} from '../proxy/shared/quota.js';
test('Grok omitted zero usage after a weekly reset remains visible with its reset time',()=>{
 // Actual credits response shape: proto3 omits creditUsagePercent when it is zero.
 const currentPeriod={type:'USAGE_PERIOD_TYPE_WEEKLY',start:'2026-10-28T17:09:00.033593+00:00',end:'2026-11-04T17:09:00.033593+00:00'};
 const snapshot=grokQuota({config:{currentPeriod,onDemandCap:{val:0},onDemandUsed:{val:0},isUnifiedBillingUser:true,prepaidBalance:{val:0}}});
 assert.equal(snapshot.usedPercent,0);assert.equal(snapshot.buckets.length,1);
 assert.equal(snapshot.buckets[0].period,'本周');assert.equal(snapshot.buckets[0].resetsAt,'2026-11-04T17:09:00.033Z');
 assert.match(renderQuota(snapshot),/100%/);assert.match(renderQuota(snapshot),/data-quota-progress/);
 assert.equal(grokQuota({config:{currentPeriod:{...currentPeriod,type:'USAGE_PERIOD_TYPE_MONTHLY'}}}).buckets[0].period,'本月');
 for(const creditUsagePercent of [0,47,100])assert.equal(grokQuota({config:{currentPeriod,creditUsagePercent}}).usedPercent,creditUsagePercent);
 for(const config of [undefined,null,{}, {currentPeriod:{}},{currentPeriod:{...currentPeriod,end:'bad'}},{currentPeriod:{...currentPeriod,type:'UNKNOWN'}},...[null,'0',NaN,-1].map(creditUsagePercent=>({currentPeriod,creditUsagePercent}))]){
  assert.deepEqual(grokQuota({config}).buckets,[]);
 }
});
test('quota contract retains only valid applicable fields and is idempotent',()=>{
 const snapshot=normalizeQuota({buckets:[null,{id:'bad',unit:'widgets',limit:-1,used:'invalid',usedPercent:NaN},{id:'percentage',limit:'100',remaining:'75',unit:'widgets',invalidField:'discard',resetsAt:1e100},{id:'unlimited',unlimited:true,unit:'credits',limit:0,remaining:0,usedPercent:0,resetsAt:'2026-11-01'},{id:'credits',unit:'credits',limit:'100',used:'0',remaining:100,resetsAt:'2026-11-01'}]});
 assert.deepEqual(snapshot.buckets,[{id:'percentage',unit:'percent',usedPercent:25},{id:'unlimited',unlimited:true},{id:'credits',unit:'credits',limit:100,used:0,remaining:100,usedPercent:0,resetsAt:'2026-11-01T00:00:00.000Z'}]);
 assert.deepEqual(normalizeQuota(snapshot),snapshot);
 assert.deepEqual(normalizeQuota({buckets:[{id:'zero-reset',unit:'percent',usedPercent:0,resetsAt:0}]}).buckets,[{id:'zero-reset',unit:'percent',usedPercent:0}]);
});
test('quota adapters reject invalid buckets before rendering',()=>{
 assert.equal(renderQuota({buckets:[],message:'上游未提供'}),'');
 const empty=normalizeQuota({buckets:[{id:'missing'},{id:'placeholder',unit:'credits',limit:0,used:0,remaining:0,usedPercent:0}]});assert.deepEqual(empty.buckets,[]);assert.equal(renderQuota(empty),'');
 const kimi=renderQuota(kimiQuota({usage:{limit:100,remaining:100},limits:[{window:{duration:5,timeUnit:'TIME_UNIT_HOUR'},detail:{limit:100,used:25}}]}));
 assert.match(kimi,/100%/);assert.match(kimi,/75%/);assert.match(kimi,/5 小时/);assert.doesNotMatch(kimi,/未提供|暂无占比|\/ 100|Tokens|Credits|已用/);
 const unlimited=renderQuota({buckets:[{name:'对话',unlimited:true}]});assert.match(unlimited,/对话：不限量/);assert.doesNotMatch(unlimited,/data-quota-progress|重置/);
});
test('quota overview shares precise percentages and displays only known amounts',()=>{
 const snapshot=normalizeQuota({buckets:[{name:'AI Credits',unit:'credits',limit:20000,remaining:19677.6,usedPercent:1.7}]});
 assert.ok(Math.abs(snapshot.buckets[0].usedPercent-1.612)<1e-9);
 const html=renderQuota(snapshot);assert.match(html,/98.39%/);assert.match(html,/19,677.6 \/ 20,000 Credits/);assert.doesNotMatch(html,/98.3%|未提供/);
 const amount=renderQuota({buckets:[{name:'余额',unit:'credits',remaining:30}]});assert.match(amount,/剩余 30 Credits/);assert.doesNotMatch(amount,/data-quota-progress|重置|总额|已用/);
});
test('Kimi quota consists only of valid percentage windows without fabricated counts',()=>{
 const k=kimiQuota({usage:{limit:"100",remaining:"30",resetAt:'2026-10-02T00:00:00Z'},limits:[{window:{duration:5,timeUnit:'TIME_UNIT_HOUR'},detail:{limit:20,used:0}},{detail:{limit:20}}]});
 assert.equal(k.buckets.length,2);assert.equal(k.buckets[0].usedPercent,70);assert.equal(k.buckets[1].usedPercent,0);
 for(const bucket of k.buckets){assert.equal(bucket.unit,'percent');for(const key of ['used','remaining','limit'])assert.equal(Object.hasOwn(bucket,key),false);assert(Object.values(bucket).every(value=>value!==undefined));}
});
test('Kimi quota uses the official usages endpoint without returning credentials',async()=>{
 let request;
 const provider=new KimiProvider({dataDir:os.tmpdir(),auth:{credential:async()=>({access_token:'secret'})},fetchImpl:async(url,options)=>{request={url,options};return Response.json({usage:{limit:100,used:25},secret:'do not expose'});}});
 const result=await provider.quota();assert.equal(request.url,'https://api.kimi.com/coding/v1/usages');assert.equal(request.options.redirect,'error');assert.equal(result.buckets[0].usedPercent,25);assert.doesNotMatch(JSON.stringify(result),/secret/);
});
test('Codex independent quota preserves unknown values without starting a CLI',async()=>{
 const provider=new CodexProvider({dataDir:os.tmpdir(),auth:{quota:async()=>({buckets:[]}),close(){}}});
 const result=await provider.quota();assert.deepEqual(result,{buckets:[]});
});

test('quota resources are available to the AI bridge',async()=>{
 const {createProxyTools}=await import('../proxy/shared/tools.js');
 const {createLegacyReader}=await import('../proxy/management.js');
 const calls=[],call=async url=>{calls.push(url);return {buckets:[]};};
 const tools=createProxyTools({dataDir:os.tmpdir(),custom:null,call,readConfiguration:createLegacyReader(call)});
 await tools.read({resource:'kimi.quota'});await tools.read({resource:'codex.quota'});
 assert.deepEqual(calls,['/api/kimi-proxy/quota','/api/codex-proxy/quota']);
});
test('HTTP and AI configuration routes expose provider quota without authentication bypass',async t=>{
 const {createWorkbench}=await import('../server.mjs');
 const {rm}=await import('node:fs/promises');
 const dir=await mkdtemp(path.join(os.tmpdir(),'daylight-quota-http-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=name=>({cache:{models:[]},listModels:async()=>[],status:async()=>({connected:true}),quota:async()=>({buckets:[{name,usedPercent:20}]})});
 const server=await createWorkbench({dataDir:dir,proxyOptions:{provider:{cache:{},listModels:async()=>[]},kimiProvider:source('Kimi'),codexProvider:source('Codex'),includeGateway:false,piOptions:{piDir:path.join(dir,'pi')}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>closeWorkbench(server));
 const base=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(base+'/api/state')).json();
 for(const name of ['kimi','codex']){
  const url=base+`/api/${name}-proxy/quota`;
  assert.equal((await fetch(url)).status,403);
  const quota=await(await fetch(url,{headers:{'x-workbench-token':token}})).json();assert.equal(quota.buckets[0].usedPercent,20);
  const response=await fetch(base+'/api/proxy-tools/read',{method:'POST',headers:{'x-workbench-token':token,'content-type':'application/json'},body:JSON.stringify({resource:name+'.quota'})});
  assert.equal(response.status,200);assert.equal((await response.json()).buckets[0].name,name==='kimi'?'Kimi':'Codex');
 }
});
