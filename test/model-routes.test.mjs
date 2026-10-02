import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {ModelRouter} from '../proxy/shared/router.js';
import {createProxyService} from '../proxy/service.js';
import {selectModelRoutes} from '../public/model-routes.js';
const model={id:'shared',enabled:true,contextWindows:[],reasoningEfforts:[]};
const source=(extra={})=>({listModels:async()=>[{...model,...extra}],async *stream(){yield {type:'text',delta:'OK'};yield {type:'finish',reason:'stop'};}});
test('route lists hide disabled models but retain enabled models with failed connections', async () => {
 const a=source(),b=source({enabled:false}),router=new ModelRouter({a,b});
 await router.listModels();a.listModels=async()=>{throw Error('offline');};
 const routes=await router.routes({refresh:true}),route=routes[0];
 assert.equal(route.enabled,true);assert.equal(route.sources.find(s=>s.id==='a').available,false);
 assert.deepEqual(selectModelRoutes(routes).map(r=>r.id),['shared']);
 assert.deepEqual(selectModelRoutes(routes,{scope:'multiple'}),[]);
 assert.deepEqual(selectModelRoutes(routes,{query:'SHAR'}).map(r=>r.id),['shared']);
 a.listModels=async()=>[{...model,enabled:false}];
 const disabled=await router.routes({refresh:true});
 assert.equal(disabled[0].enabled,false);assert.deepEqual(selectModelRoutes(disabled),[]);
 assert.deepEqual(selectModelRoutes(disabled,{scope:'multiple'}),[]);
});
test('explicit route retry bypasses failure backoff and only refreshes failed enabled sources', async () => {
 const calls={a:[],b:[]},a=source(),b=source(),router=new ModelRouter({a,b});
 a.listModels=async force=>{calls.a.push(force);return [model];};
 b.listModels=async force=>{calls.b.push(force);return [model];};
 await router.listModels();
 a.listModels=async force=>{calls.a.push(force);throw Error('offline');};
 await router.routes({refresh:true});
 const before={a:calls.a.length,b:calls.b.length};
 a.listModels=async force=>{calls.a.push(force);return [model];};
 const routes=await router.routes({retry:'shared'});
 assert.equal(calls.a.length,before.a+1);assert.equal(calls.a.at(-1),true);
 assert.equal(calls.b.length,before.b);assert.equal(routes[0].sources.every(s=>s.available),true);
 await assert.rejects(router.routes({retry:'missing'}),/模型未启用或已移除/);
});
test('route health uses connection diagnostics even when the configured catalog is readable', async () => {
 let failed=true;const checks=[],a=source(),b=source();
 const router=new ModelRouter({a,b},{getSourceHealth:async()=>[{id:'a',state:failed?'unavailable':'ready',error:failed?{message:'连接超时'}:undefined}],retrySource:async(id,model)=>{checks.push([id,model]);failed=false;}});
 let route=(await router.routes())[0];
 assert.equal(route.enabled,true);assert.equal(route.sources[0].available,false);assert.equal(route.sources[0].reason,'连接超时');assert.equal(route.sources[1].available,true);
 route=(await router.routes({retry:'shared'}))[0];assert.deepEqual(checks,[['a','shared']]);assert.ok(route.sources.every(s=>s.available));
 // A subsequent failed retry remains visible, with the original healthy backup.
 failed=true;router.retrySource=async()=>{throw Error('still offline');};
 route=(await router.routes({retry:'shared'}))[0];assert.equal(route.enabled,true);assert.equal(route.sources[0].available,false);assert.equal(route.sources[1].available,true);
});
async function temporary(t,cleanup=true){const dir=await mkdtemp(path.join(os.tmpdir(),'daylight-routes-'));if(cleanup)t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:3}));return dir;}
test('same-name routes publish once, use conservative capabilities and persist primary across source reorder',async t=>{
 const dir=await temporary(t),file=path.join(dir,'routes.json');const a=source({contextWindow:100,isVL:true,reasoningEfforts:['low','high']}),b=source({contextWindow:80,isVL:false,reasoningEfforts:['high']});
 const router=new ModelRouter({a,b},{routesFile:file});const models=await router.listModels();assert.equal(models.length,1);assert.equal(models[0].contextWindow,80);assert.equal(models[0].isVL,false);assert.deepEqual(models[0].reasoningEfforts,['high']);assert.equal(models[0].maxOutputTokens,undefined);
 await router.saveRoute({id:'shared',order:['b','a']});const restarted=new ModelRouter({a,b,c:source()},{routesFile:file});assert.equal((await restarted.resolve({model:'shared'})).provider,'b');assert.deepEqual((await restarted.routes())[0].order,['b','a','c']);
 const before=await readFile(file,'utf8');await assert.rejects(restarted.saveRoute({id:'shared',order:['b','bogus','a']}),/变化/);assert.equal(await readFile(file,'utf8'),before);
 await restarted.saveRoute({id:'shared',order:['b','a','c'],excluded:['b']});assert.equal((await restarted.resolve({model:'shared'})).provider,'a');
});
test('disabled primary is retained with attention state while backup takes over',async()=>{
 const a=source(),b=source(),router=new ModelRouter({a,b});await router.listModels();a.listModels=async()=>[{...model,enabled:false}];const route=(await router.routes())[0];assert.equal(route.primary,'a');assert.equal(route.needsAttention,true);assert.equal((await router.resolve({model:'shared'})).provider,'b');await assert.rejects(router.saveRoute({id:'shared',order:['a','b']}),/主用来源不可用/);
});
test('retry only before first stream event; parameter errors and partial streams do not replay',async()=>{
 let backupCalls=0;const a=source(),b={...source(),async *stream(){backupCalls++;yield {type:'text',delta:'backup'};}};a.stream=async function*(){yield {type:'error',code:'503',message:'unavailable'};};let router=new ModelRouter({a,b});assert.equal((await Array.fromAsync(router.stream({model:'shared'})))[0].delta,'backup');assert.equal(backupCalls,1);
 a.stream=async function*(){yield {type:'error',code:'invalid_request',message:'bad parameters'};};router=new ModelRouter({a,b});assert.equal((await Array.fromAsync(router.stream({model:'shared'})))[0].code,'invalid_request');assert.equal(backupCalls,1);
 a.stream=async function*(){yield {type:'text',delta:'partial'};throw Object.assign(new Error('reset'),{code:'ECONNRESET'});};router=new ModelRouter({a,b});await assert.rejects(Array.fromAsync(router.stream({model:'shared'})),/reset/);assert.equal(backupCalls,1);
});
test('explicit conversations pin a successful backup; new requests return to primary after cooldown, stateful requests never migrate',async()=>{
 const router=new ModelRouter({a:source(),b:source()},{cacheRoutesMs:300000});const [a,b]=await router.candidates({model:'shared'});router.failed(a);router.success(b,'private-session');router.cooldowns.clear();assert.equal((await router.candidates({model:'shared'},{conversationId:'private-session'}))[0].provider,'b');assert.equal((await router.candidates({model:'shared'}))[0].provider,'a');
 assert.deepEqual((await router.candidates({model:'shared'},{conversationId:'private-session',stateful:true})).map(m=>m.provider),['b']);await assert.rejects(router.candidates({model:'shared'},{stateful:true}),/会话状态/);assert.ok(!JSON.stringify([...router.sessions]).includes('private-session'));
});
async function bridgeFixture(t,providers){const dir=await temporary(t,false);const bridge=await createProxyService({dataDir:dir,provider:providers.a,agyProvider:providers.b});const management=http.createServer((q,r)=>bridge.handle(q,r));management.listen(0,'127.0.0.1');await once(management,'listening');t.after(async()=>{await bridge.close();management.closeAllConnections();await new Promise(r=>management.close(r));await rm(dir,{recursive:true,force:true,maxRetries:3});});const base=`http://127.0.0.1:${management.address().port}`;const api=async(route,body)=>{const response=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};};const socket=http.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));await api('/api/qoder/settings',{port,autoStart:false});const key=(await api('/api/qoder/key')).data.apiKey;await api('/api/qoder/service',{enabled:true});const client=(body,header={})=>fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json',...header},body:JSON.stringify({model:'shared',messages:[{role:'user',content:'hello'}],...body})});return{api,client,port,key};}
test('HTTP routes merge catalog, fall back from forward to stream, preserve stateful binding, and record sanitized attempts',async t=>{
 let status=429,failBackup=false,backupCalls=0;const a={...source(),forward:async(raw,protocol)=>({response:Response.json(status===200?{choices:[{message:{content:'primary'}}]}:{error:'private-error'},{status}),model:raw.model,protocol})};const b={...source(),async *stream(){backupCalls++;if(failBackup){yield {type:'error',code:'503',message:'unavailable'};return;}yield {type:'text',delta:'backup'};yield {type:'finish',reason:'stop'};}};
 const {api,client,port,key}=await bridgeFixture(t,{a,b});const headers={Authorization:`Bearer ${key}`};const catalog=await(await fetch(`http://127.0.0.1:${port}/v1/models`,{headers})).json();assert.deepEqual(catalog.data.map(m=>m.id),['shared']);
 let response=await client({}, {'x-daylight-conversation-id':'private-session'});assert.equal(response.status,200);assert.match(await response.text(),/backup/);status=200;
 response=await client({}, {'x-daylight-conversation-id':'private-session'});assert.match(await response.text(),/backup/);
 failBackup=true;response=await client({previous_response_id:'upstream-id'},{'x-daylight-conversation-id':'private-session'});assert.equal(response.status,503);assert.equal(backupCalls,3);
 const records=(await api('/api/proxy/requests')).data.records;const first=records.at(-1);assert.equal(first.provider,'agy');assert.equal(first.routeAttempts[0].status,429);assert.ok(!JSON.stringify(records).includes('private-session'));assert.ok(!JSON.stringify(records).includes('private-error'));
 response=await client({}, {'x-daylight-conversation-id':'x'.repeat(201)});assert.equal(response.status,400);
 const saved=await api('/api/proxy/routes',{id:'shared',order:['qoder','agy'],excluded:[]});assert.equal(saved.status,200);status=400;response=await client({});assert.equal(response.status,400);await response.text();assert.equal(backupCalls,3);
});
test('HTTP forward accepted body failure is never replayed on backup',async t=>{
 let backupCalls=0;const a={...source(),forward:async(raw,protocol)=>({response:new Response(new ReadableStream({start(controller){controller.error(Object.assign(new TypeError('body interrupted'),{code:'ECONNRESET'}));}})),model:raw.model,protocol})};const b={...source(),async *stream(){backupCalls++;yield {type:'text',delta:'backup'};}};
 const {client}=await bridgeFixture(t,{a,b});const response=await client({});assert.equal(response.status,502);assert.equal(backupCalls,0);
});

test('deleting a source removes its route preferences and promotes the remaining source',async t=>{
 const dir=await temporary(t),file=path.join(dir,'routes.json');const providers={a:source(),b:source()},router=new ModelRouter(providers,{routesFile:file});await router.listModels();router.success((await router.resolve({model:'shared'})),'conversation');delete providers.a;await router.forgetSource('a');const route=(await router.routes())[0];assert.equal(route.primary,'b');assert.equal(route.needsAttention,false);assert.deepEqual(route.order,['b']);assert.equal(router.sessions.size,0);const saved=JSON.parse(await readFile(file));assert.deepEqual(saved.shared.order,['b']);
});
