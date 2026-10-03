import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgyAuth } from '../proxy/agy/auth.js';
import { AgyProvider } from '../proxy/agy/provider.js';
import {compileRequest} from '../proxy/agy/protocol.js';
import { ModelRouter } from '../proxy/shared/router.js';
import { createProxyService } from '../proxy/service.js';

const json = value => new Response(JSON.stringify(value));
const model = id => ({ id, enabled: true, contextWindows: [], reasoningEfforts: [] });
test('keychain decoding and expired credentials renew once without an agent prompt', async () => {
  let refreshed = false, renewals = 0;
  const auth = new AgyAuth({ execute: async (file, args) => {
    if (args[0] === 'models') { renewals++; refreshed = true; return { stdout: '' }; }
    const data = { token: { access_token: 'secret', expiry: new Date(refreshed ? Date.now() + 3600000 : 1).toISOString() } };
    return { stdout: 'go-keyring-base64:' + Buffer.from(JSON.stringify(data)).toString('base64') };
  } });
  assert.deepEqual(await Promise.all([auth.token(), auth.token()]), ['secret', 'secret']); assert.equal(renewals, 1);
});
test('router preserves names, tolerates one unavailable provider, and merges identical names', async () => {
  const a = { listModels: async () => [model('alpha')], async *stream() { yield { type: 'text', delta: 'qoder' }; } };
  const b = { listModels: async () => [model('beta')], async *stream() { yield { type: 'text', delta: 'agy' }; } };
  const r = new ModelRouter({ qoder: a, agy: b });
  assert.deepEqual((await r.listModels()).map(m => m.id), ['alpha', 'beta']);
  assert.equal((await Array.fromAsync(r.stream({model:'beta'}, {})))[0].delta, 'agy');
  b.listModels = async () => [model('alpha')];
  assert.equal((await Array.fromAsync(r.stream({model:'alpha'}, {})))[0].delta, 'qoder');
  b.listModels = async () => { throw new Error('secret must not leak'); };
  assert.deepEqual((await r.listModels()).filter(m=>m.enabled).map(m => m.id), ['alpha']); assert.ok(!JSON.stringify(r.errors).includes('secret'));
});
test('AGY compiles system, image and tool roundtrip without adding agent tools', () => {
  const request = { system:'custom', messages:[{role:'user',content:'weather'}, {role:'assistant',content:'',toolCalls:[{id:'call1',name:'weather',arguments:'{"city":"杭州"}'}]}, {role:'tool',toolCallId:'call1',content:'sunny'}], options:{} };
  const signatures = new Map([['call1',{name:'weather',args:'{"city":"杭州"}',signature:'signature'}]]);
  const body = compileRequest(request, signatures);
  assert.equal(body.systemInstruction.parts[0].text,'custom'); assert.equal(body.tools,undefined);
  assert.equal(body.contents[1].parts[0].thoughtSignature,'signature'); assert.equal(body.contents[2].parts[0].functionResponse.name,'weather');
  assert.throws(()=>compileRequest({...request,messages:[request.messages[2]]}),/tool_call/);
  assert.throws(()=>compileRequest({...request,options:{reasoningEffort:'high'}}),/暂不支持/);
});
test('one gateway/key serves Qoder and AGY; all protocols stream and aggregate; source settings remain separate', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'daylight-agy-')); const requests=[];
  const agy = new AgyProvider({dataDir:dir,auth:{token:async()=> 'secret',models:async()=>[{id:'agy-model',displayName:'AGY model'}]},fetchImpl:async(url,opts)=>{
    if(url.endsWith('loadCodeAssist')) return json({cloudaicompanionProject:'project'});
    if(url.endsWith('fetchAvailableModels')) return json({models:{'agy-model':{displayName:'AGY model',quotaInfo:{remainingFraction:0.8}}}});
    requests.push(JSON.parse(opts.body));
    const wire = [ {response:{candidates:[{content:{parts:[{text:'杭州'}]}}]}}, {response:{candidates:[{content:{parts:[{functionCall:{name:'weather',args:{city:'杭州'},id:'tool1'},thoughtSignature:'signed'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:2,thoughtsTokenCount:3,totalTokenCount:15}}} ].map(d=>`data: ${JSON.stringify(d)}\n\n`).join('');
    const bytes=Buffer.from(wire); let pos=0; return new Response(new ReadableStream({pull(c){if(pos>=bytes.length)return c.close();c.enqueue(bytes.subarray(pos,pos+=5));}}));
  }});
  const qoder = {listModels:async()=>[model('qoder-model')],async *stream(){yield {type:'text',delta:'qoder-ok'};yield {type:'finish',reason:'stop'};}};
  const bridge=await createProxyService({dataDir:dir,provider:qoder,agyProvider:agy});
  const management=http.createServer((req,res)=>bridge.handle(req,res));management.listen(0,'127.0.0.1');await once(management,'listening');
  const base=`http://127.0.0.1:${management.address().port}`;
  const api=async(route,body)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {code:r.status,data:await r.json()};};
  const temp=http.createServer();temp.listen(0,'127.0.0.1');await once(temp,'listening');const port=temp.address().port;await new Promise(r=>temp.close(r));
  t.after(async()=>{await bridge.close();management.closeAllConnections();await new Promise(r=>management.close(r));await rm(dir,{recursive:true,force:true});});
  await api('/api/qoder/settings',{port,autoStart:false});const key=(await api('/api/qoder/key')).data.apiKey;
  assert.equal((await api('/api/qoder/service',{enabled:true})).code,200);
  const client=(route,body)=>fetch(`http://127.0.0.1:${port}/v1/${route}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  assert.deepEqual((await(await client('models')).json()).data.map(m=>m.id),['qoder-model','agy-model']);
  assert.equal((await api('/api/agy/status')).data.connected,true);
  for(const [route,extra] of [['chat/completions',{messages:[{role:'user',content:'hello'}]}],['responses',{input:'hello'}],['messages',{messages:[{role:'user',content:'hello'}],max_tokens:100}]]){
    for(const stream of [false,true]) {const r=await client(route,{model:'agy-model',...extra,stream});assert.equal(r.status,200);const result=await r.text();assert.match(result,/杭州/);assert.match(result,/weather/);}
  }
  assert.equal(requests.length,6);assert.equal(requests[0].request.tools,undefined);
  for (const stream of [false,true]) {
    const rejected=await client('messages',{model:'agy-model',messages:[{role:'user',content:'hello'}],cache_control:{type:'ephemeral'},stream});
    assert.equal(rejected.status,400);assert.match(await rejected.text(),/cache_control/);
  }
  assert.equal(requests.length,6, 'unsupported options never reach upstream');

  const r=await client('chat/completions',{model:'qoder-model',messages:[{role:'user',content:'hello'}]});assert.match(await r.text(),/qoder-ok/);
  assert.equal((await api('/api/agy/models/setting',{id:'agy-model',field:'enabled',value:false})).code,200);
  assert.deepEqual((await(await client('models')).json()).data.map(m=>m.id),['qoder-model']);
  assert.ok(!JSON.stringify((await api('/api/qoder/usage')).data).includes('secret'));
});
test('truncated AGY streams fail rather than reporting success', async () => {
 const p=new AgyProvider({dataDir:'/tmp/unused',auth:{token:async()=> 'secret'},fetchImpl:async()=>new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n\n')});
 p.listModels=async()=>[{...model('m'),upstreamId:'m'}];p.catalogCache.value={project:'p'};
 const events=await Array.fromAsync(p.stream({model:'m',messages:[{role:'user',content:'hi'}],options:{}}));
 assert.equal(events.at(-1).code,'incomplete_stream');
});

test('quota uses upstream pool windows; missing values are never rendered as full quota', async () => {
 const p=new AgyProvider({dataDir:'/tmp/unused',auth:{token:async()=> 'secret'},fetchImpl:async url=>{assert.match(url,/retrieveUserQuotaSummary$/);return json({groups:[{displayName:'actual pool',buckets:[]}]});}});
 p.catalog=async()=>({project:'p'});assert.equal((await p.quota()).groups[0].displayName,'actual pool');
 const {renderQuota}=await import('../public/proxy/quota-panel.js');
 p.call=async()=>json({groups:[{displayName:'Gemini Models',buckets:[{window:'5h',remainingFraction:0.993,resetTime:'2026-09-30T00:00:00Z'},{window:'weekly'}]}]});
 const quota=await p.quota(),html=renderQuota(quota);assert.ok(Math.abs(quota.buckets[0].usedPercent-0.7)<1e-9);assert.match(html,/0.7%/);assert.match(html,/5 小时/);assert.match(html,/7 天/);assert.match(html,/暂无占比/);assert.doesNotMatch(html,/100%/);
});

test('public AGY catalog follows live CLI IDs rather than the older upstream recommended group', async () => {
 let discoveries=0;
 const p=new AgyProvider({dataDir:'/tmp/agy-catalog-test',auth:{token:async()=> 'secret',models:async()=>{discoveries++;return [{id:'gemini-3.8-flash-low',displayName:'Gemini 3.8 Flash (Low)'},{id:'gemini-3.1-pro-high',displayName:'Gemini 3.1 Pro (High)'}];}},fetchImpl:async url=>json(url.endsWith('loadCodeAssist')?{cloudaicompanionProject:'p'}:{models:{'gemini-3.8-flash-tiered':{supportsThinking:true},'gemini-pro-agent':{displayName:'old pro'}},agentModelSorts:[{groups:[{modelIds:['gemini-pro-agent']}]}]})});
 const catalog=await p.catalog();assert.deepEqual(catalog.models.map(m=>m.id),['gemini-3.8-flash-low','gemini-3.1-pro-high']);
 assert.equal(catalog.models[0].upstreamId,'gemini-3.8-flash-tiered');assert.equal(catalog.models[1].upstreamId,'gemini-pro-agent');
 await p.catalog();assert.equal(discoveries,1);await p.catalog(true);assert.equal(discoveries,2);
});

test('AGY controls survive all request decoders; unsupported controls fail explicitly', async () => {
 const {decodeChatRequest}=await import('../proxy/shared/protocols/openai-chat.js');
 const {decodeResponsesRequest}=await import('../proxy/shared/protocols/openai-responses.js');
 const {decodeMessagesRequest}=await import('../proxy/shared/protocols/anthropic-messages.js');
 const opus={id:'claude-opus-4-6-thinking',isReasoning:true,upstreamId:'claude-opus-4-6-thinking',maxOutputTokens:64000};
 const comp=r=>compileRequest(r,new Map(),opus);
 for(const [decode,body] of [[decodeChatRequest,{messages:[{role:'user',content:'hi'}],reasoning_effort:'low'}],[decodeResponsesRequest,{input:'hi',reasoning:{effort:'medium'}}],[decodeMessagesRequest,{messages:[{role:'user',content:'hi'}],thinking:{type:'adaptive'},output_config:{effort:'high'}}]]) {
  const request=decode({...body,temperature:0.4,top_p:0.8});
  const c=comp(request).generationConfig;
  assert.equal(c.thinkingConfig.thinkingLevel,request.options.reasoningEffort.toUpperCase());
  assert.equal(c.temperature,0.4);assert.equal(c.topP,0.8);
 }
 const base={model:opus.id,messages:[{role:'user',content:'hi'}],max_tokens:2048};
 assert.deepEqual(comp(decodeMessagesRequest({...base,thinking:{type:'enabled',budget_tokens:1024}})).generationConfig.thinkingConfig,{includeThoughts:true,thinkingBudget:1024});
 assert.deepEqual(comp(decodeMessagesRequest({...base,thinking:{type:'disabled'}})).generationConfig.thinkingConfig,{includeThoughts:false,thinkingBudget:0});
 for(const patch of [{thinking:{type:'enabled',budget_tokens:2048}},{thinking:{type:'adaptive',budget_tokens:1024}},{thinking:{type:'disabled'},output_config:{effort:'high'}},{output_config:{effort:'max'}},{cache_control:{type:'ephemeral'}},{thinking:{type:'unknown'}}]) assert.throws(()=>comp(decodeMessagesRequest({...base,...patch})),{code:'invalid_request'});
 const tools=[{name:'weather',input_schema:{type:'object',properties:{}}}];
 assert.deepEqual(comp(decodeMessagesRequest({...base,tools,tool_choice:{type:'tool',name:'weather'}})).toolConfig.functionCallingConfig,{mode:'ANY',allowedFunctionNames:['weather']});
 assert.throws(()=>comp(decodeMessagesRequest({...base,tools,tool_choice:{type:'tool',name:'missing'}})),/不存在/);
});

test('AGY thinking signatures roundtrip in Messages JSON and SSE without joining signed blocks', async () => {
 const {decodeMessagesRequest,renderMessagesResponse,renderMessagesStream}=await import('../proxy/shared/protocols/anthropic-messages.js');
 const events=[{type:'reasoning',delta:'first'},{type:'reasoning_signature',signature:'sig1'},{type:'reasoning',delta:'second'},{type:'reasoning_signature',signature:'sig2'},{type:'text',delta:'answer'},{type:'finish',reason:'stop'}];
 const response=await renderMessagesResponse(events,'claude-opus-4-6-thinking');
 assert.deepEqual(response.content.slice(0,2),[{type:'thinking',thinking:'first',signature:'sig1'},{type:'thinking',thinking:'second',signature:'sig2'}]);
 const compiled=compileRequest(decodeMessagesRequest({messages:[{role:'assistant',content:response.content},{role:'user',content:'next'}]}));
 assert.deepEqual(compiled.contents[0].parts.slice(0,2),[{text:'first',thought:true,thoughtSignature:'sig1'},{text:'second',thought:true,thoughtSignature:'sig2'}]);
 const wire=(await Array.fromAsync(renderMessagesStream(events,'opus'))).join('');
 assert.equal((wire.match(/signature_delta/g)||[]).length,2);
 assert.equal((wire.match(/"type":"thinking","thinking":""/g)||[]).length,2);
});

test('AGY usage snapshots preserve missing counters and expose only observed cache counts', async () => {
 const {agyUsage}=await import('../proxy/agy/protocol.js');
 const {mergeUsage,chatUsage,responsesUsage,messagesUsage}=await import('../proxy/shared/llm/usage.js');
 const first=agyUsage({promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:5,cachedContentTokenCount:80});
 const usage=mergeUsage(first,agyUsage({totalTokenCount:125}));
 assert.equal(usage.outputTokens,25);assert.equal(usage.cacheHitRate,.8);
 assert.equal(chatUsage(usage).prompt_tokens_details.cached_tokens,80);
 assert.equal(responsesUsage(usage).output_tokens_details.reasoning_tokens,5);
 assert.equal(messagesUsage(usage).input_tokens,20);
 assert.equal(messagesUsage(usage).cache_read_input_tokens,80);
 assert.ok(!Object.hasOwn(messagesUsage(usage),'cache_creation_input_tokens'));
 assert.deepEqual(agyUsage({}),{});assert.equal(agyUsage({cachedContentTokenCount:0}).cacheReadTokens,0);
});

test('AGY defaults persist independently; explicit effort overrides saved default', async t => {
 const dir=await mkdtemp(path.join(os.tmpdir(),'agy-effort-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const p=new AgyProvider({dataDir:dir});
 p.catalog=async()=>({models:[{id:'claude-opus-4-6-thinking',upstreamId:'claude-opus-4-6-thinking',isReasoning:true,reasoningEfforts:['low','medium','high']}]});
 await p.setModel({id:'claude-opus-4-6-thinking',field:'effort',value:'low'});
 const m=(await p.listModels())[0];assert.equal(m.effort,'low');
 const request={messages:[{role:'user',content:'hi'}],options:{}};
 assert.equal(compileRequest(request,new Map(),m).generationConfig.thinkingConfig.thinkingLevel,'LOW');
 assert.equal(compileRequest({...request,options:{reasoningEffort:'high'}},new Map(),m).generationConfig.thinkingConfig.thinkingLevel,'HIGH');
 await assert.rejects(p.setModel({id:m.id,field:'effort',value:'max'}));
 await p.setModel({id:m.id,field:'effort',value:'auto'});assert.equal((await p.listModels())[0].effort,undefined);
});

test('AGY streaming usage merges partial upstream counters before adding thinking tokens', async () => {
 const frames=[{usageMetadata:{promptTokenCount:100,candidatesTokenCount:2,thoughtsTokenCount:10,cachedContentTokenCount:90}},{usageMetadata:{candidatesTokenCount:5,totalTokenCount:115},candidates:[{content:{parts:[{text:'ok'}]},finishReason:'STOP'}]}];
 const p=new AgyProvider({dataDir:'/tmp/unused',auth:{token:async()=> 'secret'},fetchImpl:async()=>new Response(frames.map(response=>`data: ${JSON.stringify({response})}\n\n`).join(''))});
 p.listModels=async()=>[{...model('m'),upstreamId:'m'}];p.catalogCache.value={project:'p'};
 const events=await Array.fromAsync(p.stream({model:'m',messages:[{role:'user',content:'hi'}],options:{}}));
 const usage=events.filter(e=>e.type==='usage').at(-1).usage;
 assert.equal(usage.outputTokens,15);assert.equal(usage.inputTokens,100);assert.equal(usage.cacheReadTokens,90);
});

test('Gemini 3.8 exposes one model and routes protocol effort or saved default to the live tiered backend', async t => {
 const dir=await mkdtemp(path.join(os.tmpdir(),'agy-unified-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const requests=[];
 const p=new AgyProvider({dataDir:dir,auth:{token:async()=> 'secret',models:async()=>['low','medium','high'].map(level=>({id:`gemini-3.8-flash-${level}`,displayName:`Gemini 3.8 Flash (${level})`}))},fetchImpl:async(url,opts)=>{
  if(url.endsWith('loadCodeAssist')) return json({cloudaicompanionProject:'p'});
  if(url.endsWith('fetchAvailableModels')) return json({models:{'gemini-3.8-flash-tiered':{supportsThinking:true,supportsImages:true,maxTokens:1048576,maxOutputTokens:65536}}});
  requests.push(JSON.parse(opts.body));
  return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\n');
 }});
 const models=await p.listModels();assert.deepEqual(models.map(m=>m.id),['gemini-3.8-flash']);assert.deepEqual(models[0].reasoningEfforts,['low','medium','high']);
 const {decodeChatRequest,renderChatResponse}=await import('../proxy/shared/protocols/openai-chat.js');
 const {decodeResponsesRequest}=await import('../proxy/shared/protocols/openai-responses.js');
 const {decodeMessagesRequest}=await import('../proxy/shared/protocols/anthropic-messages.js');
 const router=new ModelRouter({agy:p});
 for (const level of ['low','medium','high']) for(const request of [decodeChatRequest({model:models[0].id,messages:[{role:'user',content:'hi'}],reasoning_effort:level}),decodeResponsesRequest({model:models[0].id,input:'hi',reasoning:{effort:level}}),decodeMessagesRequest({model:models[0].id,messages:[{role:'user',content:'hi'}],output_config:{effort:level}})]) {
  const r=await renderChatResponse(router.stream(request),request.model);
  assert.equal(r.model,'gemini-3.8-flash');assert.equal(requests.at(-1).model,'gemini-3.8-flash-tiered');assert.equal(requests.at(-1).request.generationConfig.thinkingConfig.thinkingLevel,level.toUpperCase());
 }
 const request=decodeChatRequest({model:models[0].id,messages:[{role:'user',content:'hi'}]});
 await Array.fromAsync(router.stream(request));assert.equal(requests.at(-1).request.generationConfig.thinkingConfig.thinkingLevel,'MEDIUM');
 await p.setModel({id:models[0].id,field:'effort',value:'low'});
 await Array.fromAsync(router.stream(request));assert.equal(requests.at(-1).request.generationConfig.thinkingConfig.thinkingLevel,'LOW');
 const count=requests.length;
 const errors=await Array.fromAsync(router.stream({...request,options:{reasoningEffort:'max'}}));assert.equal(errors[0].code,'invalid_request');assert.equal(requests.length,count);
 await p.setModel({id:models[0].id,field:'enabled',value:false});
 assert.equal((await Array.fromAsync(router.stream(request)))[0].code,'model_not_found');
});

test('Gemini families merge dynamically, including future versions and Pro with distinct upstream routes', async t => {
 const dir=await mkdtemp(path.join(os.tmpdir(),'agy-families-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const ids=['gemini-3.7-flash-low','gemini-3.7-flash-medium','gemini-3.7-flash-high','gemini-3.6-flash-low','gemini-3.6-flash-medium','gemini-3.6-flash-high','gemini-3.1-pro-low','gemini-3.1-pro-high','gemini-9.9-flash-low','gemini-9.9-flash-high'];
 const upstream={'gemini-3.7-flash-tiered':{supportsThinking:true},'gemini-3.6-flash-tiered':{supportsThinking:true},'gemini-9.9-flash-tiered':{supportsThinking:true},'gemini-3.1-pro-low':{supportsThinking:true,thinkingBudget:1001},'gemini-pro-agent':{supportsThinking:true,thinkingBudget:10001}};
 const sent=[];
 const p=new AgyProvider({dataDir:dir,auth:{token:async()=> 'secret',models:async()=>ids.map(id=>({id,displayName:id}))},fetchImpl:async(url,opts)=>{
  if(url.endsWith('loadCodeAssist')) return json({cloudaicompanionProject:'p'});
  if(url.endsWith('fetchAvailableModels')) return json({models:upstream});
  sent.push(JSON.parse(opts.body));return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\n');
 }});
 const models=await p.listModels();assert.deepEqual(models.map(m=>m.id),['gemini-3.7-flash','gemini-3.6-flash','gemini-3.1-pro','gemini-9.9-flash']);
 for(const model of models) for(const effort of model.reasoningEfforts) {
  const events=await Array.fromAsync(p.stream({model:model.id,messages:[{role:'user',content:'hi'}],options:{reasoningEffort:effort,maxTokens:32768}}));
  assert.ok(!events.some(e=>e.type==='error'));
  if(model.id==='gemini-3.1-pro') {
   assert.equal(sent.at(-1).model,effort==='low'?'gemini-3.1-pro-low':'gemini-pro-agent');
   assert.equal(sent.at(-1).request.generationConfig.thinkingConfig.thinkingBudget,effort==='low'?1001:10001);
  } else assert.equal(sent.at(-1).request.generationConfig.thinkingConfig.thinkingLevel,effort.toUpperCase());
 }
 await Array.fromAsync(p.stream({model:'gemini-3.1-pro',messages:[{role:'user',content:'hi'}],options:{}}));
 assert.equal(sent.at(-1).model,'gemini-pro-agent');assert.ok(sent.at(-1).request.generationConfig.maxOutputTokens>10001);
 const n=sent.length;
 const errors=await Array.fromAsync(p.stream({model:'gemini-3.1-pro',messages:[{role:'user',content:'hi'}],options:{reasoningEffort:'medium'}}));
 assert.equal(errors[0].code,'invalid_request');assert.equal(sent.length,n);
});
