import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {kimiQuota} from '../proxy/kimi/quota.js';
import {KimiProvider} from '../proxy/kimi/provider.js';
import {CodexProvider} from '../proxy/codex/provider.js';
import { closeWorkbench } from '../fixtures/workbench.mjs';
test('Kimi subscription quota preserves absent values and distinct windows',()=>{
 const k=kimiQuota({usage:{limit:"100",remaining:"30",resetAt:'2026-10-02T00:00:00Z'},limits:[{window:{duration:5,timeUnit:'TIME_UNIT_HOUR'},detail:{limit:20,used:0}},{detail:{limit:20}}]});
 assert.equal(k.buckets[0].usedPercent,70);assert.equal(k.buckets[1].remaining,20);assert.equal(k.buckets[1].usedPercent,0);assert.equal(k.buckets[2].usedPercent,undefined);assert.equal(k.buckets[2].remaining,undefined);
});
test('Kimi quota uses the official usages endpoint without returning credentials',async()=>{
 let request;
 const provider=new KimiProvider({dataDir:os.tmpdir(),auth:{credential:async()=>({access_token:'secret'})},fetchImpl:async(url,options)=>{request={url,options};return Response.json({usage:{limit:100,used:25},secret:'do not expose'});}});
 const result=await provider.quota();assert.equal(request.url,'https://api.kimi.com/coding/v1/usages');assert.equal(request.options.redirect,'error');assert.equal(result.buckets[0].usedPercent,25);assert.doesNotMatch(JSON.stringify(result),/secret/);
});
test('Codex independent quota preserves unknown values without starting a CLI',async()=>{
 const provider=new CodexProvider({dataDir:os.tmpdir(),auth:{quota:async()=>({buckets:[],message:'额度未提供'}),close(){}}});
 const result=await provider.quota();assert.deepEqual(result.buckets,[]);assert.match(result.message,/未提供/);
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
