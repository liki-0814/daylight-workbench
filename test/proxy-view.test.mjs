import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createViewSettings} from '../proxy/shared/view-settings.js';
import {createWorkbench} from '../server.mjs';
import {proxyTabs,visibleTabs,resolveTab,keyboardTab} from '../public/proxy/source-navigation.js';

test('display exclusions share tab registration and preserve utilities and future sources',()=>{
 const tabs=[...proxyTabs,{id:'future',name:'Future',kind:'provider'}];
 const visible=visibleTabs(tabs,['agy','kimi','routes']);assert.equal(visible.some(tab=>tab.id==='agy'),false);assert.equal(visible.some(tab=>tab.id==='future'),true);assert.equal(visible.some(tab=>tab.id==='routes'),true);
 assert.equal(resolveTab(visible,'kimi'),'qoder');assert.equal(resolveTab(visible,'grok'),'grok');
 assert.equal(keyboardTab(visible,'qoder','ArrowRight'),'qwenwork');assert.equal(keyboardTab(visible,'qwenwork','ArrowRight'),'grok');assert.equal(keyboardTab(visible,'custom','ArrowRight'),'routes');assert.equal(keyboardTab(visible,'routes','ArrowRight'),'quota');assert.equal(keyboardTab(visible,'quota','ArrowRight'),'future');assert.equal(keyboardTab(visible,'qoder','ArrowLeft'),'future');assert.equal(keyboardTab(visible,'grok','End'),'future');assert.equal(keyboardTab(visible,'grok','Home'),'qoder');
 const utilities=visibleTabs(proxyTabs,proxyTabs.map(tab=>tab.id));assert.deepEqual(utilities.map(tab=>tab.id),['routes','quota']);assert.equal(resolveTab(utilities,'qoder'),'routes');
});

test('display preferences persist atomically, default without writes, reject invalid or stale updates',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'daylight-view-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'view.json'),settings=createViewSettings(file);
 assert.deepEqual(await settings.read(),{version:0,hiddenSources:[]});await assert.rejects(readFile(file),{code:'ENOENT'});
 for(const hiddenSources of [['agy','agy'],['../agy'],[false],{},Array.from({length:65},(_,i)=>'s'+i)])await assert.rejects(settings.save({version:0,hiddenSources}),{status:400});
 const results=await Promise.allSettled([settings.save({version:0,hiddenSources:['agy','kimi']}),settings.save({version:0,hiddenSources:['grok']})]);assert.equal(results[0].status,'fulfilled');assert.equal(results[1].reason.status,409);
 assert.deepEqual(await createViewSettings(file).read(),{version:1,hiddenSources:['agy','kimi']});
 await writeFile(file,'{"version":1,"hiddenSources":"broken"}');await assert.rejects(settings.save({version:1,hiddenSources:[]}),{status:502});assert.equal(await readFile(file,'utf8'),'{"version":1,"hiddenSources":"broken"}');
});

test('HTTP display settings do not require stopping the gateway or change catalogs, routing, credentials',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'daylight-view-http-'));let reads=0;
 const provider={cache:{},listModels:async()=>{reads++;return[{id:'m',enabled:true,contextWindows:[],reasoningEfforts:[]}];}};
 const server=await createWorkbench({dataDir:dir,proxyOptions:{provider,includeGateway:false,includeGrok:false,includeAgy:false},extensionsOptions:{agentsRoot:path.join(dir,'agents'),home:dir,environment:{PATH:'/usr/bin:/bin'}}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await server.closeProxy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port,token=(await(await fetch(base+'/api/state')).json()).token;
 async function api(route,body,authenticated=true){const r=await fetch(base+'/api/proxy/'+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(authenticated?{'X-Workbench-Token':token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,value:await r.json()};}
 assert.equal((await api('view',undefined,false)).status,403);assert.deepEqual((await api('view')).value,{version:0,hiddenSources:[]});assert.equal(reads,0);
 const serviceFile=path.join(dir,'qoder/service.json');let runtime=JSON.parse(await readFile(serviceFile));runtime.port=0; // Pick a free port, then use the validated settings route.
 const probe=(await import('node:net')).createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));runtime.port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 await api('settings',{port:runtime.port,autoStart:false});await api('service',{enabled:true});
 const before=(await api('status')).value,config=await readFile(serviceFile,'utf8'),catalog=(await api('sources/qoder/models')).value,routes=(await api('routes')).value,calls=reads;
 assert.equal((await api('view',{version:0,hiddenSources:['qoder','agy','kimi','custom']})).status,200);assert.equal(reads,calls);
 const after=(await api('status')).value;assert.equal(after.state,'running');assert.equal(after.startedAt,before.startedAt);assert.deepEqual(after.sources,before.sources);assert.equal(await readFile(serviceFile,'utf8'),config);assert.deepEqual((await api('sources/qoder/models')).value,catalog);assert.deepEqual((await api('routes')).value,routes);
 const gateway=await fetch(`http://127.0.0.1:${runtime.port}/v1/models`,{headers:{Authorization:'Bearer '+runtime.apiKey}});assert.equal(gateway.status,200);assert.ok((await gateway.json()).data.some(model=>model.id==='m'));
 assert.equal((await api('view',{version:0,hiddenSources:[]})).status,409);
});
