import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import http from 'node:http';import {once} from 'node:events';
import {CustomSources} from '../proxy/custom/sources.js';import {convertRequest,events} from '../proxy/shared/protocol.js';import {createProxyService} from '../proxy/service.js';
const temp=async t=>{const dir=await mkdtemp(path.join(os.tmpdir(),'gateway-test-'));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:3}));return dir;};
const secrets=()=>{const values=new Map();return{get:async id=>values.get(id),set:async(id,k)=>values.set(id,k),delete:async id=>values.delete(id)};};
test('custom sources keep secrets out of settings, preserve blank keys and reject self loops',async t=>{
 const dataDir=await temp(t),vault=secrets(),c=new CustomSources({dataDir,secrets:vault});
 const a=await c.save({name:'sample',baseUrl:'https://example.com/v1',protocol:'responses',apiKey:'hidden-secret',models:[{id:'public',upstreamId:'private'}]});assert.equal(a.hasKey,true);
 assert.ok(!(await readFile(c.file,'utf8')).includes('hidden-secret'));
 await c.save({...a,apiKey:''});assert.equal(await vault.get(a.id),'hidden-secret');
 for(const baseUrl of ['http://localhost:4319/v1','http://127.1:4319/v1','https://u:p@example.com'])await assert.rejects(()=>c.save({...a,baseUrl}));
 await assert.rejects(()=>c.save({...a,models:[{id:'x'},{id:'x'}]}));
 await c.remove(a.id);assert.equal(await vault.get(a.id),undefined);
});
test('native conversion preserves opaque fields; cross conversion rejects lossy fields and preserves tools',()=>{
 const raw={model:'x',input:[{type:'reasoning',encrypted_content:'opaque'}],future_option:true};assert.deepEqual(convertRequest(raw,'responses','responses'),raw);assert.throws(()=>convertRequest(raw,'responses','chat'));
 const input={model:'x',messages:[{role:'user',content:'hi'},{role:'assistant',content:'',tool_calls:[{id:'c',type:'function',function:{name:'echo',arguments:'{}'}}]},{role:'tool',tool_call_id:'c',content:'ok'}],max_tokens:32};
 const r=convertRequest(input,'chat','responses');assert.ok(r.input.some(x=>x.call_id==='c'&&x.type==='function_call'));assert.ok(r.input.some(x=>x.call_id==='c'&&x.type==='function_call_output'));
 const a=convertRequest(input,'chat','messages');assert.equal(a.messages.at(-1).content[0].tool_use_id,'c');
 assert.throws(()=>convertRequest({...input,response_format:{type:'json_object'}},'chat','messages'));
});
test('Pi Responses cache and auto-summary hints work across protocols without accepting opaque reasoning state',()=>{
 const raw={model:'x',input:'hi',stream:true,store:false,prompt_cache_key:'session',include:['reasoning.encrypted_content'],reasoning:{effort:'high',summary:'auto'},tools:[{type:'function',name:'echo',parameters:{type:'object'},strict:false}],max_output_tokens:100};
 const chat=convertRequest(raw,'responses','chat');assert.equal(chat.reasoning_effort,'high');assert.equal(chat.max_tokens,100);assert.equal(chat.tools[0].function.name,'echo');
 assert.deepEqual(raw.reasoning,{effort:'high',summary:'auto'});
 assert.equal(convertRequest(raw,'responses','messages').output_config.effort,'high');
 const history={...raw,input:[{type:'reasoning',id:'rs_daylight-test',summary:[{type:'summary_text',text:'display only'}]},{role:'assistant',content:[{type:'output_text',text:'hello'}]},{role:'user',content:[{type:'input_text',text:'continue'}]}]};assert.equal(convertRequest(history,'responses','chat').messages.length,2);
 assert.throws(()=>convertRequest({...history,input:[{type:'reasoning',id:'rs_daylight-test',summary:[],encrypted_content:'opaque'}]},'responses','chat'));
 for(const patch of [{include:['other']},{reasoning:{effort:'high',summary:'detailed'}},{input:[{type:'reasoning',encrypted_content:'private'}]},{tools:[{type:'function',name:'echo',strict:true}]},{previous_response_id:'upstream'}])assert.throws(()=>convertRequest({...raw,...patch},'responses','chat'));
});
test('custom gateway supports native JSON and SSE, cross protocol, mapped model and live removal',async t=>{
 const dataDir=await temp(t);const upstream=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;const b=JSON.parse(body);assert.equal(b.model,'private');assert.equal(req.headers.authorization,'Bearer test-key');
  const usage={prompt_tokens:10,completion_tokens:2,prompt_tokens_details:{cached_tokens:4}};
  if(b.stream){res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({model:'private',choices:[{delta:{content:'OK'},finish_reason:'stop'}],usage})+'\n\ndata: [DONE]\n\n');}
  else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({model:'private',choices:[{message:{role:'assistant',content:'OK'}}],usage,custom_field:'preserved'}));}});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const custom=new CustomSources({dataDir,secrets:secrets()});const s=await custom.save({name:'test',baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,apiKey:'test-key',protocol:'chat',models:[{id:'public',upstreamId:'private'}]});
 const bridge=await createProxyService({dataDir,customSources:custom,provider:{listModels:async()=>[]}});const management=http.createServer((q,r)=>bridge.handle(q,r));management.listen(0,'127.0.0.1');await once(management,'listening');
 t.after(async()=>{await bridge.close();management.closeAllConnections();management.close();upstream.closeAllConnections();upstream.close();});
 const base=`http://127.0.0.1:${management.address().port}`;const api=async(route,b)=>{const r=await fetch(base+route,{method:b?'POST':'GET',headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});return r.json();};
 const sock=http.createServer();sock.listen(0,'127.0.0.1');await once(sock,'listening');const port=sock.address().port;await new Promise(r=>sock.close(r));await api('/api/qoder/settings',{port,autoStart:false});const key=(await api('/api/qoder/key')).apiKey;await api('/api/qoder/service',{enabled:true});
 for(const proto of ['chat/completions','responses','messages'])for(const stream of [false,true]){const body={model:'public',stream,...(proto==='responses'?{input:'hello'}:{messages:[{role:'user',content:'hello'}],max_tokens:32})};const r=await fetch(`http://127.0.0.1:${port}/v1/${proto}`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);const text=await r.text();assert.match(text,/OK/);if(proto==='chat/completions'&&!stream){assert.match(text,/custom_field/);assert.match(text,/public/);}}
 const records=(await api('/api/qoder/usage')).records;assert.equal(records.length,6);assert.ok(records.every(r=>r.upstreamModel==='private'));
 await api('/api/custom-proxy/delete',{id:s.id});const r=await fetch(`http://127.0.0.1:${port}/v1/models`,{headers:{Authorization:`Bearer ${key}`}});assert.deepEqual((await r.json()).data,[]);
});
test('native responses preserve returned service tier and reject incomplete streams',async()=>{
 const data='event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:{model:'private',service_tier:'default',output:[],usage:{input_tokens:1,output_tokens:1}}})+'\n\n';let actual;const rows=await Array.fromAsync(events(new Response(data),'responses','public',i=>actual=i.actualTier??actual));assert.equal(actual,'default');assert.equal(rows[0].event.response.model,'public');await assert.rejects(()=>Array.fromAsync(events(new Response('data: {}\n\n'),'responses','x')),/提前结束/);
});

test('custom headers stay in vault, protocol endpoints are explicit and native parameters survive',async t=>{
 const dataDir=await temp(t),vault=secrets();let request;
 const c=new CustomSources({dataDir,secrets:vault,fetchImpl:async(url,options)=>{request={url,...options};return Response.json({content:[{type:'text',text:'ok'}]});}});
 const s=await c.save({name:'native',baseUrl:'https://example.com/anthropic/v1',protocol:'messages',auth:'x-api-key',apiKey:'key-secret',extraHeaders:'{"X-Project":"header-secret"}',endpoint:'messages',models:[{id:'public',upstreamId:'private'}]});
 const providers=await c.providers();await providers['custom:'+s.id].forward({model:'public',messages:[],max_tokens:100,thinking:{type:'adaptive'},custom_field:'native'},'messages',{signal:AbortSignal.timeout(1000)});
 assert.equal(request.url,'https://example.com/anthropic/v1/messages');assert.equal(request.headers['X-Project'],'header-secret');assert.equal(request.headers['x-api-key'],'key-secret');assert.equal(JSON.parse(request.body).custom_field,'native');assert.ok(!(await readFile(c.file,'utf8')).includes('header-secret'));
 await assert.rejects(()=>c.save({...s,endpoint:'../escape'}));await assert.rejects(()=>c.save({...s,extraHeaders:'{"Authorization":"bad"}'}));
});

test('Responses terminal reconstructs completed output items for stateless tool continuation',async()=>{
 const item={type:'function_call',id:'fc_1',call_id:'c1',name:'echo',arguments:'{"text":"hello"}'};
 const rows=[{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{output:[],status:'completed'}}];
 const out=await Array.fromAsync(events(new Response(rows.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')),'responses','public'));
 assert.deepEqual(out.find(e=>e.event?.type==='response.completed').event.response.output,[item]);
});

test('failed custom validation does not erase an existing credential',async t=>{
 const vault=secrets(),c=new CustomSources({dataDir:await temp(t),secrets:vault});
 const s=await c.save({name:'sample',baseUrl:'https://example.com/v1',protocol:'chat',apiKey:'saved',models:[{id:'a'}]});
 await assert.rejects(()=>c.save({...s,clearKey:true}));assert.equal(await vault.get(s.id),'saved');
 await assert.rejects(()=>c.save({...s,clearKey:true,apiKey:'replacement',extraHeaders:'bad'}));assert.equal(await vault.get(s.id),'saved');
});

test('Codex uses only account/model RPC, caches discovery and retries expired OAuth once',async t=>{
 const {CodexProvider}=await import('../proxy/codex/provider.js');const {writeFile}=await import('node:fs/promises');
 const home=await temp(t),methods=[];const token='x.'+Buffer.from(JSON.stringify({exp:Date.now()/1000+3600})).toString('base64url')+'.x';
 await writeFile(path.join(home,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:token,account_id:'test-account'}}));
 let requests=0,body;
 const p=new CodexProvider({home,dataDir:home,rpcFactory:()=>({initialize:async()=>{},close(){},call:async(method)=>{methods.push(method);return method==='model/list'?{data:[{model:'test',supportedReasoningEfforts:[{reasoningEffort:'low'}],serviceTiers:[{id:'priority',name:'Fast'}]}]}:{};}}),fetchImpl:async(url,options)=>{assert.equal(url,'https://chatgpt.com/backend-api/codex/responses');body=JSON.parse(options.body);requests++;return new Response('',{status:requests===1?401:200});}});
 await Promise.all([p.listModels(),p.listModels()]);assert.deepEqual(methods,['account/read','model/list']);
 await p.forward({model:'test',input:'hello',service_tier:'fast',reasoning:{effort:'low'}},'responses',{signal:AbortSignal.timeout(1000)});
 assert.equal(requests,2);assert.equal(body.service_tier,'priority');assert.equal(body.store,false);assert.equal(body.stream,true);assert.deepEqual(methods,['account/read','model/list','account/read','model/list']);
 await assert.rejects(()=>p.forward({model:'test',input:'hello',max_output_tokens:32},'responses',{}),/max_output_tokens/);
});

test('Codex declared SSE remains SSE when upstream labels it application/json',async()=>{
 const {relay}=await import('../proxy/shared/relay.js');let result;
 const provider={forward:async()=>({response:new Response('event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[]}})+'\n\n',{headers:{'Content-Type':'application/json'}}),protocol:'responses',streaming:true,model:'test'})};
 await relay(provider,{model:'test'},'responses',{writeHead(){},end(t){result=JSON.parse(t);}},AbortSignal.timeout(1000),()=>{});
 assert.equal(result.status,'completed');
});

test('keyless custom draft stays unroutable until a key is supplied and enabled',async t=>{
 const c=new CustomSources({dataDir:await temp(t),secrets:secrets()});
 const draft=await c.save({name:'Kimi Coding',baseUrl:'https://api.kimi.com/coding/v1',protocol:'chat',auth:'bearer',enabled:false,models:[{id:'kimi-for-coding'}]});
 assert.equal(draft.hasKey,false);assert.deepEqual(await c.providers(),{});
 await assert.rejects(()=>c.save({...draft,enabled:true}),/API Key/);
 await c.save({...draft,enabled:true,apiKey:'test'});assert.equal(Object.keys(await c.providers()).length,1);
});

test('model discovery previews unsaved credentials without changing the stored source or vault',async t=>{
 const vault=secrets();let authorization;
 const c=new CustomSources({dataDir:await temp(t),secrets:vault,fetchImpl:async(url,options)=>{authorization=options.headers.Authorization;return Response.json({data:[{id:'found'}]});}});
 const s=await c.save({name:'preview',baseUrl:'https://example.com/v1',protocol:'chat',apiKey:'original',models:[{id:'existing'}]});
 const found=await c.discover({...s,apiKey:'draft-key',baseUrl:'https://other.example/v1',models:[],enabled:false});
 assert.equal(found[0].id,'found');assert.equal(authorization,'Bearer draft-key');assert.equal(await vault.get(s.id),'original');assert.equal((await c.list())[0].baseUrl,s.baseUrl);
 await c.discover({...s,apiKey:''});assert.equal(authorization,'Bearer original');
 await c.discover({name:'new',baseUrl:'https://example.com/v1',protocol:'chat',auth:'bearer',apiKey:'new',models:[],enabled:false});assert.equal((await c.list()).length,1);
});

test('explicit key reveal reads the vault and discovery reports authentication errors',async t=>{
 const c=new CustomSources({dataDir:await temp(t),secrets:secrets(),fetchImpl:async()=>new Response('{}',{status:401})});
 const s=await c.save({name:'key',baseUrl:'https://example.com/v1',protocol:'chat',apiKey:'saved-test-key',models:[]});
 assert.equal(await c.readKey(s.id),'saved-test-key');assert.equal((await c.list())[0].apiKey,undefined);
 await assert.rejects(()=>c.readKey('unknown'),/尚未保存/);
 await assert.rejects(()=>c.discover(s.id),/认证失败（401）/);
});

test('model discovery extracts declared limits and leaves absent output limits unknown',async t=>{
 const c=new CustomSources({dataDir:await temp(t),secrets:secrets(),fetchImpl:async()=>Response.json({data:[{id:'kimi',context_length:1048576,limit:{context:1048576}},{id:'other',context_window:'262144',max_output_tokens:65536},{id:'nested',limit:{context:200000,output:32000}},{id:'unknown',context_length:-1,max_output_tokens:'unlimited',max_tokens:32}]})});
 const s=await c.save({name:'limits',baseUrl:'https://example.com/v1',protocol:'chat',auth:'none',models:[]});const models=await c.discover(s.id);
 assert.equal(models[0].contextWindow,1048576);assert.equal(models[0].maxOutputTokens,undefined);
 assert.equal(models[1].contextWindow,262144);assert.equal(models[1].maxOutputTokens,65536);
 assert.equal(models[2].maxOutputTokens,32000);assert.equal(models[3].contextWindow,undefined);assert.equal(models[3].maxOutputTokens,undefined);
 await c.save({...s,models});assert.equal((await c.list())[0].models[0].contextWindow,1048576);
});
