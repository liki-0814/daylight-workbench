import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {namedModels, withModelNames} from '../proxy/shared/model-names.js';
import {ModelRouter} from '../proxy/shared/router.js';
import {writeJson} from '../proxy/shared/store.js';

test('catalog names are readable, deterministic and do not collapse distinct native modes', () => {
  const models = [{id:'mode-a',displayName:'Qwen3.8-Flash'}, {id:'mode-b',displayName:'旗舰'}, {id:'qmodel_38max',displayName:'Qwen3.8-Max'}];
  const names = namedModels('qwenwork',models);
  assert.deepEqual(names.map(m=>m.id),['qwen3.8-flash','qwenwork-flagship','qwen3.8-max']);
  assert.equal(names[0].upstreamId,'mode-a');
  assert.deepEqual(names[0].aliases,['mode-a']);
  assert.equal(models[0].id,'mode-a');
  const duplicates = [{id:'one',displayName:'Qwen3.8-Max'}, {id:'two',displayName:'Qwen3.8-Max'}];
  const a = namedModels('qoder',duplicates), b = namedModels('qoder',[...duplicates].reverse());
  assert.equal(new Set(a.map(m=>m.id)).size,2);
  assert.equal(a[0].id,b[1].id);
});

test('public names translate execution and settings while native discovery retains persisted keys', async () => {
  const calls = [], native = {
    models:[{id:'qmodel',displayName:'Qwen3.7-Plus',enabled:true}],
    async listModels(){return this.models;},
    async execute(input){calls.push(input.raw.model);assert.equal((await this.listModels())[0].id,'qmodel');return {kind:'events',events:[]};},
    async setModel(input){assert.equal(input.id,'qmodel');this.models[0].enabled=input.value;return this.listModels();},
  };
  const publicProvider = withModelNames('qoder',native);
  for (const model of ['qwen3.7-plus','qmodel','qwen3.7-plus[200k]']) await publicProvider.execute({raw:{model}},{});
  assert.deepEqual(calls,['qmodel','qmodel','qmodel[200k]']);
  const models = await publicProvider.setModel({id:'qwen3.7-plus',field:'enabled',value:false});
  assert.equal(models[0].enabled,false);assert.equal(models[0].id,'qwen3.7-plus');
  assert.equal(native.models[0].id,'qmodel');
});

test('renamed routes preserve native exclusions, share readable names, and constrain legacy aliases to their source', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'daylight-names-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'routes.json');
  await writeJson(file,{'qmodel':{order:['qoder'],excluded:['qoder']},'mode-a':{order:['qwenwork'],excluded:[]}});
  const providers = Object.fromEntries([['qoder','qmodel'],['qwenwork','mode-a']].map(([source,id])=>[source,withModelNames(source,{listModels:async()=>[{id,displayName:'Qwen3.8-Flash',enabled:true}]})]));
  const router=new ModelRouter(providers,{routesFile:file,cacheRoutesMs:300000});
  assert.deepEqual((await router.listModels()).map(m=>m.id),['qwen3.8-flash']);
  assert.deepEqual((await router.candidates({model:'qwen3.8-flash'})).map(m=>m.provider),['qwenwork']);
  await assert.rejects(router.candidates({model:'qmodel'}),/模型不存在/);
  assert.equal((await router.resolve({model:'mode-a'})).provider,'qwenwork');
  const saved=JSON.parse(await readFile(file));assert.deepEqual(saved['qwen3.8-flash'].excluded,['qoder']);
  await router.saveRoute({id:'qwen3.8-flash',order:['qoder','qwenwork'],excluded:[]});
  assert.deepEqual((await router.candidates({model:'mode-a'})).map(m=>m.provider),['qwenwork']);
  assert.deepEqual((await router.candidates({model:'qwen3.8-flash[200k]'})).map(m=>m.provider),['qoder']);
  const restarted=new ModelRouter(providers,{routesFile:file});
  assert.deepEqual((await restarted.listModels())[0].aliases,['qmodel','mode-a']);
  assert.deepEqual((await restarted.routes())[0].excluded,[]);
});

test('a source discovered later retains its old exclusion without undoing subsequent route edits',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'daylight-names-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'routes.json');await writeJson(file,{'mode-a':{order:['qwenwork'],excluded:['qwenwork']}});
  const providers={qoder:withModelNames('qoder',{listModels:async()=>[{id:'qfmodel',displayName:'Qwen3.8-Flash',enabled:true}]})};
  const router=new ModelRouter(providers,{routesFile:file});await router.listModels();
  providers.qwenwork=withModelNames('qwenwork',{listModels:async()=>[{id:'mode-a',displayName:'Qwen3.8-Flash',enabled:true}]});
  assert.deepEqual((await router.routes())[0].excluded,['qwenwork']);
  await router.saveRoute({id:'qwen3.8-flash',order:['qoder','qwenwork'],excluded:[]});
  assert.deepEqual((await router.routes())[0].excluded,[]);
});
