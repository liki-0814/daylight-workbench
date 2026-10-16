import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {CopilotAuth,copilotEndpoint} from '../proxy/copilot/auth.js';
import {parseModels} from '../proxy/copilot/models.js';
import {copilotQuota} from '../proxy/copilot/quota.js';
import {fixture,catalog} from '../fixtures/copilot/upstream.mjs';
import {createWorkbench} from '../server.mjs';
import {definitions} from '../ai/tools/definitions.mjs';
import {createProxyState} from '../public/proxy/state.js';
async function setup(t,loggedIn=false){const dataDir=await mkdtemp(path.join(os.tmpdir(),'daylight-copilot-'));const f=fixture({dataDir,loggedIn});t.after(async()=>{f.p.close();await rm(dataDir,{recursive:true,force:true});});return{...f,dataDir};}
const safe=value=>{for(const secret of ['synthetic-github-secret','synthetic-copilot-secret','synthetic-device-secret'])assert(!JSON.stringify(value).includes(secret));};

test('independent GitHub device login throttles polls, stores only in Keychain, and returns safe metadata',async t=>{
 const f=await setup(t),login=await f.auth.login();assert.equal(login.url,'https://github.com/login/device');assert.equal(login.userCode,'TEST-CODE');safe(login);
 await f.auth.poll();assert.equal(f.calls.length,1);
 f.setPoll({error:'slow_down'});f.advance(5000);assert.equal((await f.auth.poll()).interval,10);
 f.advance(5000);await f.auth.poll();assert.equal(f.calls.length,2);
 f.setPoll({error:'authorization_pending'});f.advance(5000);assert.equal((await f.auth.poll()).status,'pending');
 f.setPoll({access_token:'synthetic-github-secret'});f.advance(10000);assert.equal((await f.auth.poll()).authorized,true);
 assert.equal(f.keys.size,1);assert.equal(f.auth.account.login,'fixture-user');
 assert.equal((await f.p.status()).connected,true);safe(f.p.snapshot());
 assert.equal(f.calls.filter(c=>c.url.includes('/v2/token')).length,1);
 await f.p.listModels();assert.equal(f.calls.filter(c=>c.url.includes('/v2/token')).length,1);
 await f.auth.logout();assert.equal(f.keys.size,0);assert.equal(f.p.snapshot().connected,false);await assert.rejects(f.auth.credential(),{status:401});
});
test('denied, expired and cancelled authorization never persists credentials',async t=>{
 const f=await setup(t);await f.auth.login();f.setPoll({error:'access_denied'});f.advance(5000);assert.equal((await f.auth.poll()).status,'denied');
 await f.auth.login();f.advance(900000);assert.equal((await f.auth.poll()).status,'expired');
 await f.auth.login();assert.equal((await f.auth.cancel()).status,'cancelled');assert.equal(await f.auth.poll(),null);assert.equal(f.keys.size,0);
});
test('authorization rejects unsafe URLs and credential exchange rejects unsafe API endpoints',async()=>{
 const auth=new CopilotAuth({fetchImpl:async()=>Response.json({verification_uri:'https://evil.example',device_code:'private',user_code:'x',expires_in:900})});await assert.rejects(auth.login(),/无效/);
 for(const url of ['http://api.githubcopilot.com','https://evil.example','https://api.githubcopilot.com@evil.example','https://api.githubcopilot.com/path','https://api.githubcopilot.com?key=x','https://api.githubcopilot.com:9443'])assert.throws(()=>copilotEndpoint(url));
 assert.equal(copilotEndpoint('https://api.business.githubcopilot.com'),'https://api.business.githubcopilot.com');
});
test('cancelling an in-flight device response and Keychain commit cannot authorize later',async t=>{
 const f=await setup(t);await f.auth.login();f.advance(5000);
 let release,entered;const waiting=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
 const set=f.secrets.set;f.secrets.set=async(...args)=>{entered();await waiting;return set(...args);};
 const polling=f.auth.poll();await started;await f.auth.cancel();release();assert.equal((await polling).status,'cancelled');assert.equal(f.keys.size,0);assert.equal(f.auth.account,undefined);
});
test('Copilot token renewals are single-flight and cannot survive logout',async t=>{
 const f=await setup(t,true);await Promise.all([f.auth.credential(),f.auth.credential()]);assert.equal(f.calls.filter(c=>c.url.includes('/v2/token')).length,1);
 f.advance(3600000);await Promise.all([f.auth.credential(),f.auth.credential()]);assert.equal(f.calls.filter(c=>c.url.includes('/v2/token')).length,2);
 let release,entered;const waiting=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});const request=f.auth.request.bind(f.auth);
 f.auth.request=async(...args)=>{entered();await waiting;return request(...args);};
 const renewal=f.auth.credential(true);await started;await f.auth.logout();release();await assert.rejects(renewal,/状态已变化/);assert.equal(f.auth.token,null);
});
test('model discovery uses declared endpoints, limits and capabilities without model-name guesses',()=>{
 const models=parseModels({data:[...catalog.data,{id:'embedding',capabilities:{type:'embeddings'}},{...catalog.data[0],id:'disabled',policy:{state:'disabled'}},{...catalog.data[0],id:'messages-only',supported_endpoints:['/embeddings']},{id:'unknown-chat',capabilities:{type:'chat'}}]});
 assert.deepEqual(models.map(m=>m.id),['copilot-chat-fixture','copilot-responses-fixture','unknown-chat']);assert.deepEqual(models[0].reasoningEfforts,['low','high']);assert.equal(models[0].contextWindow,128000);assert.equal(models[2].isReasoning,undefined);assert.equal(models[2].isVL,undefined);assert.equal(models[2].maxOutputTokens,undefined);
});
test('Copilot preserves native request fields and converts Responses and Messages through shared adapters',async t=>{
 const f=await setup(t,true);const raw={model:'copilot-chat-fixture',messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,AAAA'}}]}],temperature:.4,stream:false,custom_field:'native'};
 await f.p.forward(raw,'chat');const call=f.calls.at(-1);assert.deepEqual(JSON.parse(call.init.body),raw);assert.equal(call.init.headers['X-Initiator'],'user');assert.equal(call.init.headers['copilot-vision-request'],'true');assert.equal(call.init.redirect,'error');
 await f.p.forward({model:raw.model,input:'Hi',max_output_tokens:32},'responses');assert.equal(JSON.parse(f.calls.at(-1).init.body).messages[0].content[0].text,'Hi');
 await f.p.forward({model:raw.model,messages:[{role:'user',content:'Hi'}],max_tokens:32},'messages');assert(f.calls.at(-1).url.endsWith('/chat/completions'));
 await f.p.forward({model:'copilot-responses-fixture',messages:[{role:'user',content:'Hi'}],max_tokens:32},'chat');assert(f.calls.at(-1).url.endsWith('/responses'));assert.equal(JSON.parse(f.calls.at(-1).init.body).max_output_tokens,32);
});
test('model settings persist, disabled models reject requests, and client effort wins over defaults',async t=>{
 const f=await setup(t,true);await f.p.setModel({id:'copilot-chat-fixture',field:'effort',value:'low'});
 await f.p.forward({model:'copilot-chat-fixture',messages:[],reasoning_effort:'high'},'chat');assert.equal(JSON.parse(f.calls.at(-1).init.body).reasoning_effort,'high');
 await f.p.forward({model:'copilot-chat-fixture',messages:[]},'chat');assert.equal(JSON.parse(f.calls.at(-1).init.body).reasoning_effort,'low');
 await assert.rejects(f.p.forward({model:'copilot-chat-fixture',messages:[],reasoning_effort:'max'},'chat'),/思考强度/);
 await f.p.setModel({id:'copilot-chat-fixture',field:'enabled',value:false});await assert.rejects(f.p.forward({model:'copilot-chat-fixture',messages:[]},'chat'),/停用/);
 safe(JSON.parse(await readFile(path.join(f.dataDir,'copilot-proxy/settings.json'),'utf8')));
});
test('401 retries exactly once and refuses to replay after account switch',async t=>{
 const f=await setup(t,true);await f.p.listModels();let sends=0;f.p.fetchImpl=async()=>{sends++;return Response.json({}, {status:sends===1?401:200});};
 await f.p.forward({model:'copilot-chat-fixture',messages:[]},'chat');assert.equal(sends,2);
 sends=0;const credential=f.auth.credential.bind(f.auth);f.auth.credential=async force=>({...await credential(force),...(force?{identity:'other-account'}:{})});
 await assert.rejects(f.p.forward({model:'copilot-chat-fixture',messages:[]},'chat'),/账号已切换/);assert.equal(sends,1);
});
test('quota distinguishes unknown, unlimited, remaining requests and percentages',()=>{
 const q=copilotQuota({quota_snapshots:{premium_interactions:{entitlement:300,remaining:240,percent_remaining:80},chat:{unlimited:true},unknown:{}}});
 assert.equal(q.buckets[0].used,60);assert.equal(q.buckets[0].usedPercent,20);assert.equal(q.buckets[0].unit,'requests');assert.equal(q.buckets[1].limit,undefined);assert.equal(q.buckets[2].remaining,undefined);
});
test('native Anthropic models retain thinking/signatures and a new user turn is user-initiated',async t=>{
 const f=await setup(t,true);f.setModels({data:[{...catalog.data[0],supported_endpoints:['/v1/messages']}]});
 const raw={model:'copilot-chat-fixture',messages:[{role:'assistant',content:[{type:'thinking',thinking:'private reasoning',signature:'opaque'},{type:'text',text:'Hello'}]},{role:'user',content:'Next'}],max_tokens:100,thinking:{type:'adaptive'},stream:false};
 const result=await f.p.forward(raw,'messages');assert.equal(result.protocol,'messages');assert(f.calls.at(-1).url.endsWith('/v1/messages'));assert.deepEqual(JSON.parse(f.calls.at(-1).init.body),raw);assert.equal(f.calls.at(-1).init.headers['X-Initiator'],'user');assert.equal(f.calls.at(-1).init.headers['anthropic-version'],'2023-06-01');
});
test('saved GitHub login survives restart and token proxy-ep selects the validated account endpoint',async t=>{
 const f=await setup(t,true),auth=new CopilotAuth({secrets:f.secrets,fetchImpl:async()=>Response.json({token:'tid=test;proxy-ep=proxy.individual.githubcopilot.com;exp=test',expires_at:Math.floor(Date.now()/1000)+3600})});
 assert.equal((await auth.credential()).baseUrl,'https://api.individual.githubcopilot.com');assert.equal(auth.account.login,'fixture-user');auth.close();
 f.block(true);assert.equal((await f.p.status()).connected,false);assert.match(f.p.lastError,/订阅或组织授权/);assert.equal(f.keys.size,1);
});
test('terminal browser authorization stays visible for cancellation and stops polling',async()=>{
 let polls=0;const state=createProxyState({request:async path=>path==='sources'?{sources:[]}:({}),source:async(id,op)=>op==='auth/login'?{status:'pending',url:'https://github.com/login/device',expiresAt:Date.now()+60000}:op==='auth/poll'?(polls++,{status:'denied'}):({status:'cancelled'})});
 await state.auth('copilot','login');await state.pollLogins();await state.pollLogins();assert.equal(polls,1);assert.equal(state.login('copilot').terminal,true);assert.match(state.login('copilot').error,/denied/);await state.auth('copilot','cancel');assert.equal(state.login('copilot'),undefined);state.dispose();
});
test('HTTP gateway, safe AI review, Pi sync, streaming tools and logout share the Copilot provider',async t=>{
 const f=await setup(t);const server=await createWorkbench({dataDir:f.dataDir,proxyOptions:{provider:{listModels:async()=>[]},copilotProvider:f.p,includeGateway:false,includeAgy:false,includeGrok:false,pricingOptions:{enabled:false},piOptions:{piDir:path.join(f.dataDir,'pi'),getInfo:async()=>({installed:true})}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await server.closeProxy();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const base='http://127.0.0.1:'+server.address().port,token=(await(await fetch(base+'/api/state')).json()).token;
 const api=async(route,body)=>{const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','x-workbench-token':token},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));safe(value);return value;};
 const state=await api('/api/proxy-tools/state');const action={type:'auth.login',sourceId:'copilot'};
 await api('/api/proxy-tools/prepare',{action});assert.equal(f.auth.pending,undefined);
 const applied=await api('/api/proxy-tools/apply',{action,expectedVersion:state.version,requestId:'copilot-login'});assert.equal(applied.login.userCode,'TEST-CODE');
 f.advance(5000);const login=await api('/api/proxy-tools/loginState',{sourceId:'copilot'});assert.equal(login.login.authorized,true);
 await api('/api/proxy/sources/copilot/auth/refresh',{});const rows=(await api('/api/proxy/sources')).sources;assert.equal(rows.find(s=>s.id==='copilot').name,'GitHub Copilot');assert.equal(rows.find(s=>s.id==='copilot').account.login,'fixture-user');
 assert.equal((await api('/api/proxy-tools/read',{resource:'copilot.quota'})).buckets[0].remaining,240);
 const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 await api('/api/proxy/settings',{port,autoStart:false});await api('/api/proxy/service',{enabled:true});
 const pi=await api('/api/cli/pi/state?api=openai-responses');assert.equal(pi.models.length,2);assert.equal(pi.models[0].source,'copilot');
 const messagesPi=await api('/api/cli/pi/state?api=anthropic-messages');assert.match(messagesPi.models[0].unavailableReason,/原生 Messages/);
 await api('/api/cli/pi/apply',{api:pi.api,expectedVersion:pi.version,requestId:'copilot-pi'});
 const config=JSON.parse(await readFile(path.join(f.dataDir,'pi/models.json'),'utf8'));assert.equal(config.providers.daylight.models[0].api,'openai-responses');assert.equal(config.providers.daylight.models[0].contextWindow,128000);
 const key=(await api('/api/proxy/key')).apiKey;
 const infer=async(endpoint,body)=>{const response=await fetch(`http://127.0.0.1:${port}/v1/`+endpoint,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200,await response.clone().text());return response;};
 for(const endpoint of ['chat/completions','responses','messages']){
  const request={model:'copilot-chat-fixture',stream:true,...(endpoint==='responses'?{input:'Hi',max_output_tokens:32}:{messages:[{role:'user',content:'Hi'}],max_tokens:32}),tools:endpoint==='responses'?[{type:'function',name:'echo',parameters:{type:'object'}}]:endpoint==='messages'?[{name:'echo',input_schema:{type:'object'}}]:[{type:'function',function:{name:'echo',parameters:{type:'object'}}}]};
  assert.match(await(await infer(endpoint,request)).text(),/echo/);
 }
 await infer('chat/completions',{model:'copilot-chat-fixture',messages:[{role:'assistant',content:null,tool_calls:[{id:'call_echo',type:'function',function:{name:'echo',arguments:'{}'}}]},{role:'tool',tool_call_id:'call_echo',content:'hello'}]});assert.equal(f.calls.at(-1).init.headers['X-Initiator'],'agent');
 assert.equal((await api('/api/proxy/requests')).records.some(r=>r.provider==='copilot'),true);
 assert(definitions.find(d=>d.name==='daylight_get_proxy_login').inputSchema.properties.sourceId.enum.includes('copilot'));
 await api('/api/proxy/sources/copilot/auth/logout',{});assert.equal(f.keys.size,0);assert.equal((await api('/api/proxy/status')).sources.copilot.connected,false);
 safe(await readFile(path.join(f.dataDir,'proxy-tool-receipts.json'),'utf8'));
});
