import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createViewSettings} from '../proxy/shared/view-settings.js';
import {createWorkbench} from '../server.mjs';
import {sourceEntries,sourceMeta} from '../public/proxy/source-cards.js';

test('source cards keep every custom upstream separate from built-in sources',()=>{
 const entries=sourceEntries([{id:'qoder',name:'Qoder',configured:true,state:'ready',account:{login:'a@b.c'}},{id:'custom',name:'自定义'},{id:'custom:one',name:'内网通用',configured:true},{id:'custom:two',name:'备用文本',configured:false,state:'unconfigured'}]);
 assert.deepEqual(entries.map(entry=>entry.id),['qoder','custom:one','custom:two']);
 assert.equal(entries[0].meta,'已登录');assert.equal(sourceMeta({id:'custom:one',configured:true}),'已连接');
 assert.equal(entries[2].meta,'未配置');assert.equal(entries[1].title,'内网通用');
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
