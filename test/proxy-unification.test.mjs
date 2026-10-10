import {capacityOptions,fastSetting} from '../public/proxy/model-options.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import {CatalogCache} from '../proxy/shared/catalog-cache.js';
import {modelSettings,applyCapacitySettings,updateModelSetting} from '../proxy/shared/model-settings.js';
import {invalid} from '../proxy/shared/protocol.js';
import {validOutputBudget,validSampling,outputBudget,reasoningEffort,conflictingChatBudgets,omitKimiTemperature,isOfficialKimiUrl} from '../proxy/shared/request-parameters.js';
import {QoderProvider,loadConfig} from '../proxy/qoder/provider.js';
import {AccountStore} from '../proxy/qoder/auth.js';
import {AgyProvider} from '../proxy/agy/provider.js';
import {GrokProvider} from '../proxy/grok/provider.js';
import {CodexProvider} from '../proxy/codex/provider.js';
import {KimiProvider} from '../proxy/kimi/provider.js';
import {CustomProvider} from '../proxy/custom/provider.js';
import {createProxyService} from '../proxy/service.js';
import {createProxyState} from '../public/proxy/state.js';
import {renderQuota} from '../public/proxy/quota-panel.js';
const temporary=async t=>{const dir=await mkdtemp(path.join(os.tmpdir(),'daylight-unified-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;};
const deferred=()=>Promise.withResolvers();

test('shared parameter rules preserve explicit zero, unknown limits and official Kimi scope',()=>{
 assert.equal(outputBudget({max_tokens:0},1024),0);assert.equal(reasoningEffort({reasoning:{effort:'none'}},'high'),'none');
 assert.equal(validOutputBudget(0),false);assert.equal(validOutputBudget(33,32),false);assert.equal(validOutputBudget(32,undefined),true);assert.equal(validSampling(0,2),true);assert.equal(validSampling(Infinity,2),false);
 assert.equal(conflictingChatBudgets({max_tokens:8,max_completion_tokens:9}),true);
 const input={temperature:0.7};omitKimiTemperature(input,'kimi-for-coding');assert.equal(input.temperature,undefined);
 const unknown={temperature:0.7};omitKimiTemperature(unknown,'future-model');assert.equal(unknown.temperature,0.7);assert.equal(isOfficialKimiUrl('https://thirdparty.example/v1'),false);
});
test('catalog cache dedupes refreshes, preserves last valid catalog and rejects stale commits',async()=>{
 const cache=new CatalogCache(),a=deferred(),b=deferred();let loads=0;
 const first=cache.get({identity:'a',load:()=>{loads++;return a.promise;}}),same=cache.get({identity:'a',refresh:true,load:()=>{loads++;return a.promise;}});
 const newer=cache.get({identity:'b',load:()=>b.promise});b.resolve({models:['new']});await newer;a.resolve({models:['old']});await Promise.all([first,same]);
 assert.equal(loads,1);assert.deepEqual(cache.value.models,['new']);assert.equal(cache.value.identity,'b');
 await assert.rejects(cache.get({identity:'b',refresh:true,load:()=>{throw Error('offline');}}),/offline/);assert.deepEqual(cache.value.models,['new']);
 cache.invalidate();assert.equal(cache.value,undefined);
});
test('shared settings serialize writes without copying model permissions or changing JSON maps',async t=>{
 const dir=await temporary(t),file=path.join(dir,'settings.json'),settings=modelSettings(file),model={id:'x',reasoningEfforts:['high'],maxOutputTokens:100};
 await Promise.all([settings.save(model,{field:'enabled',value:false},{invalid}),settings.save(model,{field:'effort',value:'high'},{invalid})]);
 assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{disabled:['x'],efforts:{x:'high'}});
 await settings.save(model,{field:'effort',value:'auto'},{invalid});assert.deepEqual((await settings.read()).efforts,{});
 await assert.rejects(settings.save(model,{field:'serviceTier',value:'priority'},{invalid}),/不支持/);
});
test('six production providers expose snapshots and execute without exposing credentials or discovering in snapshot',async t=>{
 const dir=await temporary(t),config=loadConfig(dir),accounts=new AccountStore(config.accountFile);await accounts.save({id:'safe-identity',credential:{access:'never-expose',uid:'uid'}});
 const all=[new QoderProvider(config,{},accounts),new AgyProvider({dataDir:dir,auth:{identity:'a'}}),new GrokProvider({dataDir:dir,auth:{identity:'g'}}),new CodexProvider({dataDir:dir,auth:{identity:'c',close(){}}}),new KimiProvider({dataDir:dir,auth:{close(){}}}),new CustomProvider({}, {id:'sample',name:'sample',protocol:'chat',auth:'none',models:[]})];
 for(const provider of all){const snapshot=provider.snapshot();assert.equal(typeof snapshot.id,'string');assert.ok(Array.isArray(snapshot.authentication.operations));assert.ok(Array.isArray(snapshot.nativeProtocols));assert.equal(typeof provider.execute,'function');assert.equal(typeof provider.close,'function');assert.doesNotMatch(JSON.stringify(snapshot),/never-expose/);}
});
test('unified management and legacy aliases share actions, shapes and non-inference catalog checks',async t=>{
 const dir=await temporary(t);let models=[{id:'demo',enabled:true,contextWindows:[],reasoningEfforts:[],settingFields:['enabled']}],settings=0,executions=0;
 const provider={cache:{at:Date.now()},listModels:async()=>models,setModel:async input=>{settings++;models=models.map(m=>({...m,enabled:input.value}));return models;},stream:async function*(){executions++;yield{type:'finish',reason:'stop'};}};
 const service=await createProxyService({dataDir:dir,provider,piOptions:{piDir:path.join(dir,'pi')}});t.after(()=>service.close());
 async function api(url,body){const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.url=url;req.method=body===undefined?'GET':'POST';let code,value;await service.handle(req,{destroyed:false,writeHead(n){code=n;},end(text){value=JSON.parse(text);}});return{code,value};}
 const legacy=await api('/api/qoder/models'),unified=await api('/api/proxy/sources/qoder/models');assert.deepEqual(unified,legacy);
 assert.equal((await api('/api/proxy/sources/qoder/models/setting',{id:'demo',field:'enabled',value:false})).code,200);assert.equal(settings,1);
 assert.equal((await api('/api/qoder/models/setting',{id:'demo',field:'enabled',value:true})).code,200);assert.equal(settings,2);
 assert.equal((await api('/api/proxy/sources/qoder/check',{kind:'catalog'})).code,200);assert.equal(executions,0);
 assert.equal((await api('/api/proxy/sources/qoder/auth/refresh',{})).code,404);assert.equal((await api('/api/proxy/sources/qoder/check',{kind:'unknown'})).code,400);
 assert.deepEqual(await api('/api/qoder/key'),await api('/api/proxy/key'));assert.equal((await api('/api/proxy/sources/qoder/models/setting')).code,404);
});
test('frontend store dedupes resources and drops replies from previous account generations',async()=>{
 const pending=deferred();let identity='a',calls=0;const api={request:async op=>op==='status'?{state:'stopped'}:{sources:[{id:'kimi',identityKey:identity,revision:identity,authentication:{operations:[]}}]},source:async()=>{calls++;return pending.promise;}};
 const store=createProxyState(api);await store.refresh();const a=store.resource('kimi','models'),b=store.resource('kimi','models');identity='b';await store.refresh();pending.resolve({models:[{id:'stale'}]});assert.equal(await a,undefined);assert.equal(await b,undefined);assert.equal(calls,1);store.dispose();
});
test('frontend service status survives unavailable source metadata so native runtime recovery remains usable',async()=>{
 const store=createProxyState({request:async op=>{if(op==='status')return{state:'stopped',native:true,runtimeError:'missing Node'};throw Error('sidecar unavailable');}});
 await store.refresh();assert.equal(store.status.native,true);assert.equal(store.status.runtimeError,'missing Node');assert.equal(store.error,'sidecar unavailable');store.dispose();
});
test('shared quota rendering keeps missing values distinct from an explicit zero',()=>{
 const quota=renderQuota({buckets:[{id:'unknown',name:'unknown',unit:'unknown'},{id:'zero',name:'zero',unit:'percent',usedPercent:0}]});assert.match(quota,/暂无占比/);assert.match(quota,/上游未提供/);assert.match(quota,/0%/);
});
test('nested Qoder business errors distinguish transport 200, business 400 and client 502 without retaining messages',async()=>{
 const {QoderDeframer}=await import('../proxy/qoder/stream.js'),{RequestTrace}=await import('../proxy/shared/request-records.js');
 const parser=new QoderDeframer();const error={code:'provider_error',message:JSON.stringify({status:400,error:{code:'invalid_request_error',message:'PRIVATE PROMPT'}})};
 const event=parser.push('data: '+JSON.stringify({body:JSON.stringify(error)})+'\n\n')[0];
 const trace=new RequestTrace('/responses');trace.observe({upstreamStatus:200});trace.event(event);const record=trace.finish(502,502);
 assert.equal(record.upstreamStatus,200);assert.equal(record.upstreamErrorStatus,400);assert.equal(record.upstreamErrorCode,'invalid_request_error');assert.equal(record.status,502);assert.doesNotMatch(JSON.stringify(record),/PRIVATE PROMPT/);
});

test('Grok quota shares cache deduplication and cannot retain a previous account result',async t=>{
 const dir=await temporary(t),started=deferred(),secondStarted=deferred(),responses=new Map();let identity='account-a',calls=0;
 const provider=new GrokProvider({dataDir:dir,auth:{credential:async()=>({identity,token:identity,version:'test'})},fetchImpl:async(url,options)=>{
  calls++;const pending=deferred();responses.set(options.headers.Authorization,pending);(calls===1?started:secondStarted).resolve();return pending.promise;
 }});
 const old=provider.quota(),rejected=assert.rejects(old,/登录|账号|认证|授权/);await started.promise;
 identity='account-b';const fresh=provider.quota(),same=provider.quota();await secondStarted.promise;
 responses.get('Bearer account-a').resolve(Response.json({config:{creditUsagePercent:99}}));
 responses.get('Bearer account-b').resolve(Response.json({config:{creditUsagePercent:12}}));
 await rejected;assert.equal((await fresh).usedPercent,12);assert.equal((await same).usedPercent,12);
 assert.equal((await provider.quota()).usedPercent,12);assert.equal(calls,2);provider.close();
});

test('capacity controls default to maximum, preserve source ceilings and reject unsupported increases',()=>{
 const raw={id:'capacity',enabled:true,contextWindows:[{length:256000,isDefault:true},{length:1000000}],maxOutputTokens:32768};
 const initial=applyCapacitySettings([raw])[0];assert.equal(initial.contextWindow,1000000);assert.equal(initial.contextWindows.find(w=>w.isDefault).length,1000000);
 assert.deepEqual(capacityOptions(initial,'contextWindow').map(o=>o.value),[256000,353000,500000,1000000]);
 const settings={queueRetry:{enabled:true}};
 const options={fields:['contextWindow','maxOutputTokens'],invalid};
 updateModelSetting(settings,initial,{field:'contextWindow',value:353000},options);
 updateModelSetting(settings,initial,{field:'maxOutputTokens',value:8192},options);
 const selected=applyCapacitySettings([raw],settings)[0];assert.equal(selected.contextWindow,353000);assert.equal(selected.contextLimit,1000000);assert.equal(selected.maxOutputTokens,8192);assert.equal(selected.outputLimit,32768);
 assert.equal(selected.contextWindows.find(w=>w.isDefault).length,1000000);
 assert.deepEqual(capacityOptions(selected,'maxOutputTokens').map(o=>o.value),[4096,8192,16384,32768]);
 assert.throws(()=>updateModelSetting(settings,selected,{field:'contextWindow',value:2000000},options),/上限/);
 updateModelSetting(settings,selected,{field:'contextWindow',value:1000000},options);assert.equal(settings.capacities.capacity.contextWindow,undefined);assert.equal(settings.queueRetry.enabled,true);
 assert.deepEqual(capacityOptions({contextWindow:500000},'contextWindow').map(o=>o.value),[256000,353000,500000]);
 assert.equal(capacityOptions({},'contextWindow')[0].label,'上游未提供');
});
test('Fast is the same optional control for native fast and priority service tiers',()=>{
 assert.equal(fastSetting({settingFields:['fast'],supportsFast:false}),undefined);
 assert.deepEqual(fastSetting({settingFields:['fast'],supportsFast:true,fast:true}),{field:'fast',checked:true});
 assert.deepEqual(fastSetting({settingFields:['serviceTier'],serviceTiers:[{id:'priority'}],serviceTier:'priority'}),{field:'serviceTier',on:'priority',checked:true});
 assert.equal(fastSetting({settingFields:['serviceTier'],serviceTiers:[]}),undefined);
});

test('Qoder capacity settings survive native model commands and feed Pi metadata',async t=>{
 const {applySettings,loadSettings}=await import('../proxy/qoder/models.js');
 const {modelConfig}=await import('../cli/pi-config.js');
 const dir=await temporary(t),config=loadConfig(dir),provider=new QoderProvider(config,{},new AccountStore(config.accountFile));
 const raw=[{id:'native-capacity',enabled:true,supportsFast:true,reasoningEfforts:['high'],contextWindows:[{length:256000,isDefault:true},{length:1000000}],maxOutputTokens:32768}];
 provider.catalogModels=async()=>applySettings(raw,await loadSettings(config.accountFile));
 assert.equal((await provider.listModels())[0].contextWindow,1000000);
 await provider.setModel({id:'native-capacity',field:'contextWindow',value:353000});
 await provider.setModel({id:'native-capacity',field:'maxOutputTokens',value:8192});
 const [selected]=await provider.setModel({id:'native-capacity',field:'fast',value:true});
 assert.equal(selected.contextWindow,353000);assert.equal(selected.contextLimit,1000000);assert.equal(selected.maxOutputTokens,8192);assert.equal(selected.fast,true);
 const pi=modelConfig(selected);assert.equal(pi.contextWindow,353000);assert.equal(pi.maxTokens,8192);
 const saved=await loadSettings(config.accountFile);assert.equal(saved.capacities['native-capacity'].contextWindow,353000);
 await assert.rejects(provider.setModel({id:'native-capacity',field:'contextWindow',value:2000000}),/上限/);
});
