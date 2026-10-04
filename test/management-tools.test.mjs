import {fixtureSources} from './fixtures.mjs';
import {createLegacyReader} from '../proxy/management.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProxyTools} from '../proxy/shared/tools.js';
import {createPiConfig} from '../cli/pi-config.js';
import {actionLinks} from '../public/components/action-links.js';

test('operation links distinguish proxy, Pi, AI, projects and tasks',()=>{
  assert.match(actionLinks({type:'model.setting',id:'m'}),/href="#proxy"/);
  assert.doesNotMatch(actionLinks({type:'model.setting',id:'m'}),/#task=/);
  assert.match(actionLinks({type:'pi.apply'}),/href="#cli"/);
  assert.match(actionLinks({type:'ai.settings'}),/#settings/);
  assert.match(actionLinks({type:'project.update',id:'p'}),/#project=p/);
  assert.match(actionLinks({type:'task.update',id:'t'}),/#task=t/);
});
test('Qoder default context is part of the reviewed proxy version',async()=>{
  let context=1000,writes=0;
  const call=async(url,input)=>url==='/api/proxy/status'?{state:'stopped',port:4319,autoStart:false}:url.endsWith('/models')?{models:[{id:'m',enabled:true,contextWindows:[{length:1000,isDefault:context===1000},{length:2000,isDefault:context===2000}]}]}:(writes++,{});
  const tools=createProxyTools({call,custom:null,getSources:async()=>fixtureSources(),readConfiguration:createLegacyReader(call),dataDir:'/private/tmp/unused-proxy-context'});
  const before=await tools.state();context=2000;
  assert.notEqual((await tools.state()).version,before.version);
  await assert.rejects(tools.apply({requestId:'context-stale',expectedVersion:before.version,action:{type:'model.setting',sourceId:'qoder',id:'m',field:'context',value:1000}}),/发生变化/);
  assert.equal(writes,0);
});
test('Pi tool drafts preview without writing, persist overrides, synchronize, and reject stale snapshots',async t=>{
  const dataDir=await mkdtemp(path.join(tmpdir(),'daylight-tools-pi-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const piDir=path.join(dataDir,'pi');
  const pi=createPiConfig({dataDir,piDir,getInfo:async()=>({installed:true}),getCatalog:async()=>[{id:'m',name:'M',source:'kimi',enabled:true,isVL:true}],getGateway:async()=>({state:'running',baseUrl:'http://127.0.0.1:4319/v1',apiKey:'private-key'})});
  await pi.start();t.after(()=>pi.close());
  const call=async(url,input)=>url.startsWith('/api/cli/pi/state')?pi.state(new URL(url,'http://localhost').searchParams.get('api')||undefined):url.startsWith('/api/cli/pi/')?pi[url.split('/').at(-1)](input):url==='/api/proxy/status'?{state:'stopped'}:{models:[]};
  const tools=createProxyTools({call,custom:null,getSources:async()=>fixtureSources(),readConfiguration:createLegacyReader(call),dataDir});
  const state=await tools.read({resource:'pi.state'});assert(!JSON.stringify(state).includes('private-key'));
  const draft=await tools.prepare({action:{type:'pi.configuration',options:{modelOverrides:{m:{contextWindow:9999,maxTokens:222,input:['text','image']}}}}});
  await assert.rejects(readFile(path.join(piDir,'models.json')),{code:'ENOENT'});
  await tools.apply({requestId:'pi-personal',expectedVersion:draft.version,action:draft.action});
  await assert.rejects(tools.apply({requestId:'pi-stale-one',expectedVersion:state.version,action:{type:'pi.apply',options:{}}}),/发生变化/);
  const apply=await tools.prepare({action:{type:'pi.apply',options:{}}});
  const input={requestId:'pi-sync-one',expectedVersion:apply.version,action:apply.action};
  await tools.apply(input);assert.equal((await tools.apply(input)).replayed,true);
  const configured=JSON.parse(await readFile(path.join(piDir,'models.json'),'utf8')).providers.daylight.models[0];
  assert.equal(configured.contextWindow,9999);assert.equal(configured.maxTokens,222);assert.deepEqual(configured.input,['text','image']);
  await assert.rejects(tools.read({resource:'secret.key'}),/不存在/);
});

test('custom reasoning capabilities persist, drive Pi mappings and default upstream effort',async t=>{
  const {CustomSources}=await import('../proxy/custom/sources.js');
  const {modelConfig}=await import('../cli/pi-config.js');
  const dataDir=await mkdtemp(path.join(tmpdir(),'daylight-efforts-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const bodies=[];
  const custom=new CustomSources({dataDir,fetchImpl:async(url,init)=>{if(url.endsWith('/models'))return Response.json({data:[{id:'model'}]});bodies.push(JSON.parse(init.body));return Response.json({choices:[{message:{content:'ok'},finish_reason:'stop'}]});}});
  const saved=await custom.save({name:'Manual',baseUrl:'https://example.com/v1',protocol:'chat',auth:'none',models:[{id:'model',reasoningEfforts:['low','high','max'],effort:'high'}]});
  const provider=(await custom.providers())['custom:'+saved.id],model=(await provider.listModels())[0];
  assert.deepEqual(model.reasoningEfforts,['low','high','max']);assert.equal(model.isReasoning,true);
  const pi=modelConfig(model);assert.equal(pi.thinkingLevelMap.max,'max');assert.equal(pi.thinkingLevelMap.medium,null);
  await provider.forward({model:'model',messages:[]},'chat');assert.equal(bodies.at(-1).reasoning_effort,'high');
  await provider.forward({model:'model',messages:[],reasoning_effort:'low'},'chat');assert.equal(bodies.at(-1).reasoning_effort,'low');
  await custom.discover(saved.id);assert.deepEqual((await custom.list())[0].models[0].reasoningEfforts,['low','high','max']);
  await assert.rejects(custom.save({...saved,models:[{id:'model',reasoningEfforts:['low'],effort:'high'}]}),/支持档位/);
});
