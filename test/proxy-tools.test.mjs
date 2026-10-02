import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProxyTools} from '../proxy/shared/tools.js';
import {CustomSources} from '../proxy/custom/provider.js';
async function fixture(t, options = {}) {
 const dataDir=await mkdtemp(path.join(tmpdir(),'daylight-proxy-tools-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const secrets=new Map(),keys={get:async id=>secrets.get(id),set:async(id,v)=>secrets.set(id,v),delete:async id=>secrets.delete(id)};
 const custom=new CustomSources({dataDir,secrets:keys,fetchImpl:async()=>Response.json({data:[{id:'found',context_window:1000,max_output_tokens:100}]})});
 let service={state:'stopped',port:4319,autoStart:false,apiKey:'must-not-leak'},requests=0;
 const call=async(url,input)=>{
  if(url==='/api/qoder/status')return service;
  if(url.endsWith('/models')||url.includes('/models?'))return{models:[{id:'m',enabled:true,reasoningEfforts:['low'],contextWindow:1000}]};
  if(url==='/api/custom-proxy/delete'){await custom.remove(input.id);requests++;return{ok:true};}
  if(url==='/api/custom-proxy/save')return{source:await custom.save(input)};
  if(url==='/api/qoder/service'){service={...service,state:input.enabled?'running':'stopped'};requests++;return service;}
  if(url==='/api/qoder/test')return{message:'ok'};
  requests++;return{ok:true};
 };
 return{dataDir,tools:createProxyTools({call,custom,dataDir,...options}),custom,secrets,requests:()=>requests};
}
test('proxy drafts validate without writes or credentials; apply stores key separately and replays safely',async t=>{
 const f=await fixture(t);const snapshot=await f.tools.state();assert(!JSON.stringify(snapshot).includes('must-not-leak'));
 const action={type:'source.save',source:{name:'Test',baseUrl:'https://example.com/v1',protocol:'chat',models:[{id:'public',upstreamId:'private'}]}};
 const draft=await f.tools.prepare({action});assert.equal(draft.requiresKey,true);assert.equal((await f.custom.list()).length,0);
 const input={action:draft.action,expectedVersion:snapshot.version,requestId:'request-one',apiKey:'private-test-key'};
 const result=await f.tools.apply(input);assert.equal(result.ok,true);assert(result.action.source.id);
 const saved=(await f.custom.list())[0];assert.equal(saved.hasKey,true);assert.equal(f.secrets.get(saved.id),'private-test-key');
 assert(!JSON.stringify(await f.tools.state()).includes('private-test-key'));assert(!JSON.stringify(result).includes('private-test-key'));
 assert.equal((await f.tools.apply(input)).replayed,true);assert.equal((await f.custom.list()).length,1);
 await assert.rejects(f.tools.apply({...input,action:{type:'service.enabled',enabled:true}}),/requestId/);
 const models=await f.tools.discover({sourceId:saved.id});assert.equal(models.models[0].contextWindow,1000);
 assert.match((await f.tools.test({sourceId:saved.id})).message,/未发送推理/);
});
test('diagnostic updates do not invalidate a reviewed configuration', async t => {
 let checkedAt = 'first';
 const f = await fixture(t, { getSources: async () => [{ id: 'qoder', checkedAt }] });
 const before = await f.tools.state();
 checkedAt = 'second';
 const after = await f.tools.state();
 assert.equal(after.sources[0].diagnostics.checkedAt, 'second');
 assert.equal(after.version, before.version);
});
test('stale configuration, unknown fields and invalid model capabilities are rejected',async t=>{
 const f=await fixture(t),snap=await f.tools.state();
 await assert.rejects(f.tools.prepare({action:{type:'source.save',source:{apiKey:'forbidden'}}}),/Key/);
 await assert.rejects(f.tools.prepare({action:{type:'model.setting',sourceId:'codex',id:'m',field:'effort',value:'high'}}),/思考强度/);
 await f.tools.apply({action:{type:'service.enabled',enabled:true},expectedVersion:snap.version,requestId:'service-one'});
 await assert.rejects(f.tools.apply({action:{type:'service.enabled',enabled:false},expectedVersion:snap.version,requestId:'service-two'}),/发生变化/);
 assert.equal(f.requests(),1);
});

test('multi Key review preserves separate model permissions and keeps credentials out of receipts',async t=>{
 const f=await fixture(t),snapshot=await f.tools.state();
 const action={type:'source.save',source:{name:'Multi',baseUrl:'https://example.com/v1',protocol:'chat',keys:[{id:'first',models:[{id:'a'}]},{id:'second',models:[{id:'b'}]}]}};
 const draft=await f.tools.prepare({action});
 assert.deepEqual(draft.requiresKeys.map(k=>k.id),['first','second']);
 await assert.rejects(f.tools.apply({action:draft.action,expectedVersion:snapshot.version,requestId:'multi-missing',apiKeys:{first:'secret-a'}}),/API Key 2/);
 const result=await f.tools.apply({action:draft.action,expectedVersion:snapshot.version,requestId:'multi-created',apiKeys:{first:'secret-a',second:'secret-b'}});
 const saved=(await f.custom.list())[0];
 assert.deepEqual(saved.keys.map(k=>k.models.map(m=>m.id)),[['a'],['b']]);
 assert.equal(await f.custom.readKey(saved.id,'first'),'secret-a');
 assert.equal(await f.custom.readKey(saved.id,'second'),'secret-b');
 for(const publicResult of [draft,result,await f.tools.state()])assert(!JSON.stringify(publicResult).includes('secret-'));
 const receipts=await (await import('node:fs/promises')).readFile(path.join(f.dataDir,'proxy-tool-receipts.json'),'utf8');
 assert(!receipts.includes('secret-'));
});
test('deletion is prepared without writes then removes source and every stored Key',async t=>{
 const f=await fixture(t);
 const saved=await f.custom.save({name:'Delete',baseUrl:'https://example.com/v1',protocol:'chat',keys:[{id:'one',apiKey:'secret-a',models:[{id:'a'}]},{id:'two',apiKey:'secret-b',models:[{id:'b'}]}]});
 const action={type:'source.delete',sourceId:saved.id},snapshot=await f.tools.state();
 const prepared=await f.tools.prepare({action});assert(prepared.impact.length);
 assert.equal((await f.custom.list()).length,1);
 await f.tools.apply({action,expectedVersion:snapshot.version,requestId:'delete-source'});
 assert.equal((await f.custom.list()).length,0);assert.equal(f.secrets.size,0);
});
test('routing validates full source order, applies only after review and rejects stale preferences',async t=>{
 let routes=[{id:'m',order:['a','b'],excluded:[],sources:[{id:'a',available:true},{id:'b',available:true}]}];
 const f=await fixture(t,{getRoutes:async()=>routes,call:async(url,input)=>{
  if(url==='/api/qoder/status')return{state:'running'};
  if(url==='/api/proxy/routes'){routes=[{...routes[0],order:input.order,excluded:input.excluded}];return{ok:true};}
  return{models:[]};
 }});
 const before=await f.tools.state(),action={type:'route.save',id:'m',order:['b','a'],excluded:[]};
 await f.tools.prepare({action});assert.deepEqual(routes[0].order,['a','b']);
 await assert.rejects(f.tools.prepare({action:{...action,order:['b']}}),/来源/);
 await assert.rejects(f.tools.prepare({action:{...action,excluded:['b','a']}}),/主用/);
 const input={action,expectedVersion:before.version,requestId:'route-adjust'};
 await f.tools.apply(input);assert.deepEqual(routes[0].order,['b','a']);
 assert.equal((await f.tools.apply(input)).replayed,true);
 await assert.rejects(f.tools.apply({...input,requestId:'route-stale'}),/发生变化/);
});
test('Kimi login actions and polling expose only safe authorization status',async t=>{
 let starts=0,cancelled=0;
 const login={status:'pending',verificationUrl:'https://auth.kimi.com/device',userCode:'TEST-CODE'};
 const f=await fixture(t,{call:async(url)=>{
  if(url==='/api/qoder/status')return{state:'running'};
  if(url==='/api/kimi-proxy/status')return{connected:false};
  if(url==='/api/kimi-proxy/auth/poll')return login;
  if(url==='/api/kimi-proxy/auth/login'){starts++;return login;}
  if(url==='/api/kimi-proxy/auth/cancel'){cancelled++;return{status:'cancelled'};}
  return{models:[{id:'k3',enabled:true}]};
 }});
 const before=await f.tools.state();assert(before.sources.some(s=>s.id==='kimi'));
 const action={type:'auth.login',sourceId:'kimi'},draft=await f.tools.prepare({action});assert(draft.impact.length);assert.equal(starts,0);
 const input={action,expectedVersion:before.version,requestId:'kimi-login'};
 const result=await f.tools.apply(input);assert.equal(result.login.status,'pending');assert.equal(starts,1);
 await f.tools.apply(input);assert.equal(starts,1);
 assert.equal((await f.tools.loginState({sourceId:'kimi'})).login.userCode,'TEST-CODE');
 await f.tools.apply({action:{type:'auth.cancel',sourceId:'kimi'},expectedVersion:(await f.tools.state()).version,requestId:'kimi-cancel'});assert.equal(cancelled,1);
 await assert.rejects(f.tools.prepare({action:{type:'model.setting',sourceId:'kimi',id:'k3',field:'effort',value:'high'}}),/思考强度/);
});

test('request diagnostics use existing API and validate limits without any write',async t=>{
 let endpoint;
 const f=await fixture(t,{call:async url=>{endpoint=url;return{records:[{effectiveTemperature:'omitted',provider:'kimi'}]};}});
 assert.equal((await f.tools.requests({limit:5})).records[0].effectiveTemperature,'omitted');
 assert.equal(endpoint,'/api/proxy/requests?limit=5');
 await assert.rejects(f.tools.requests({limit:0}),/记录数量/);
});
