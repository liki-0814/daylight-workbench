import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProxyTools } from '../proxy/shared/tools.js';
import { createPiConfig } from '../cli/pi-config.js';

test('a newly registered source uses public management and auth capabilities without name branches', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'daylight-new-source-'));
  t.after(() => rm(dataDir, {recursive:true,force:true}));
  const id = 'future/source', url = '/api/proxy/sources/future%2Fsource';
  let effort = 'low', loginCount = 0;
  const calls = [];
  const call = async (route, input) => {
    calls.push(route);
    if (route === '/api/proxy/status') return {state:'stopped',port:4319,autoStart:false};
    if (route.startsWith(url+'/models') && !route.endsWith('/setting')) return {models:[{id:'future-model',effort,reasoningEfforts:['low','high'],settingFields:['effort']}]};
    if (route === url+'/models/setting') {effort=input.value;return {ok:true};}
    if (route === url+'/auth/login') {loginCount++;return {status:'pending'};}
    if (route === url+'/auth/poll') return {status:'pending',userCode:'FAKE'};
    if (route === url+'/status') return {connected:false};
    throw new Error('Unexpected management call: '+route);
  };
  const tools = createProxyTools({dataDir,custom:null,call,getSources:async()=>[{id,name:'Future',kind:'builtin',authentication:{operations:['login','poll']}}]});
  const snapshot = await tools.state();
  assert.deepEqual(snapshot.sources.map(s=>s.id),[id]);
  await assert.rejects(tools.prepare({action:{type:'model.setting',sourceId:id,id:'future-model',field:'fast',value:true}}),/不支持/);
  await tools.apply({expectedVersion:snapshot.version,requestId:'future-model-setting',action:{type:'model.setting',sourceId:id,id:'future-model',field:'effort',value:'high'}});
  assert.equal(effort,'high');
  const login = {expectedVersion:(await tools.state()).version,requestId:'future-login',action:{type:'auth.login',sourceId:id}};
  assert.equal((await tools.apply(login)).login.status,'pending');
  assert.equal((await tools.apply(login)).replayed,true);
  assert.equal(loginCount,1);
  assert.equal((await tools.loginState({sourceId:id})).login.userCode,'FAKE');
  await tools.discover({sourceId:id});
  assert.ok(calls.includes(url+'/models?refresh=1'));
  await assert.rejects(tools.prepare({action:{type:'auth.logout',sourceId:id}}),/不支持/);
});

test('Pi protocol restrictions follow source metadata even for an unfamiliar source', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(),'daylight-pi-capability-'));
  t.after(() => rm(dataDir,{recursive:true,force:true}));
  const pi = createPiConfig({dataDir,piDir:path.join(dataDir,'pi'),getInfo:async()=>({installed:true}),getGateway:async()=>({state:'running',baseUrl:'http://127.0.0.1:4319/v1',apiKey:'fake-key'}),getCatalog:async()=>[{id:'future',name:'Future',source:'new-source',pi:{'anthropic-messages':'来源未适配 Pi 缓存字段'}}]});
  await pi.start();t.after(()=>pi.close());
  assert.equal((await pi.state('anthropic-messages')).models[0].unavailableReason,'来源未适配 Pi 缓存字段');
  await assert.rejects(pi.prepare({api:'anthropic-messages'}),/未适配/);
  assert.equal((await pi.prepare({api:'openai-responses'})).api,'openai-responses');
});
