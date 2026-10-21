import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { AIStore } from '../ai/store.mjs';
import { createAIService, validateSettings } from '../ai/service.mjs';
import { createConversations } from '../ai/conversations.mjs';
import { createQuickAnswers } from '../ai/quick.mjs';
import { resolveRoute } from '../core/contracts.js';
const settings={backend:'codex',codex:{model:'codex-model'},qoder:{model:'qoder-model'},pi:{model:'local/pi-model'}};

test('legacy AI settings gain Pi without changing saved backend and model defaults',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'daylight-backend-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const original=new AIStore(dir); const legacy={backend:'qoder',qoder:settings.qoder,codex:settings.codex}; original.write('settings.json',legacy);
  const store=new AIStore(dir);
  assert.equal(store.settings.backend,'qoder'); assert.deepEqual(store.settings.qoder,legacy.qoder); assert.equal(store.settings.pi.model,'');
  assert.deepEqual(JSON.parse(await readFile(path.join(dir,'ai/settings.json'),'utf8')),legacy);
  assert.equal(validateSettings({...settings,backend:'pi'}).pi.model,'local/pi-model');
  assert.equal(validateSettings(legacy).backend,'qoder');
});

test('backend detection reports installed paths independently and serves shared browser modules',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'daylight-detect-')), store=new AIStore(dir);
  store.write('settings.json',{...settings,codex:{...settings.codex,path:process.execPath},qoder:{...settings.qoder,path:path.join(dir,'missing')},pi:{...settings.pi,path:process.execPath}});
  const ai=await createAIService({dataDir:dir,adapters:{codex:{},qoder:{},pi:{}}}), server=http.createServer(ai.handle);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await ai.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});await rm(dir,{recursive:true,force:true});});
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/ai/backends`), {backends}=await response.json();
  assert.equal(backends.length,3);assert.equal(backends.find(b=>b.id==='pi').available,true);
  assert.equal(backends.find(b=>b.id==='qoder').available,false);
  assert.equal(backends.find(b=>b.id==='codex').path,process.execPath);
  assert.equal(resolveRoute('/components/ai-backend.js','GET').file,'components/ai-backend.js');
  assert.equal(resolveRoute('/core/ai-backends.js','GET').file,'../core/ai-backends.js');
});

test('new conversations explicitly select Pi or Qoder without changing global defaults or other backend settings',async()=>{
  const store={settings:structuredClone(settings),read:()=>({}),write(){},workspace:()=>'/tmp',conversations:new Map()};
  const provider=id=>({discover:async()=>({models:[{id,efforts:[]}]})});
  const conversations=createConversations({store,providers:{pi:provider('local/pi-model'),qoder:provider('qoder-model')},api:async()=>({state:{projects:[],tasks:[]}}),isRunning:()=>false});
  const pi=await conversations.newConversation({backend:'pi'}), qoder=await conversations.newConversation({backend:'qoder'});
  assert.equal(pi.backend,'pi');assert.equal(pi.config.model,'local/pi-model');assert.equal(qoder.backend,'qoder');
  assert.deepEqual(store.settings,settings);
  await assert.rejects(conversations.newConversation({backend:'unknown'}),/不支持/);
});

test('quick answers follow saved settings and reject per-request backend or model selection',async()=>{
  let received;
  const store={settings:structuredClone(settings)}, quick=createQuickAnswers({store,providers:{pi:{run:async args=>{received=args;args.emit({type:'delta',text:'ok'});}}}});
  try {
    assert.throws(()=>quick.start({backend:'pi',text:'hello'}),/设置中统一选择/);
    assert.throws(()=>quick.start({model:'local/other',text:'hello'}),/设置中统一选择/);
    store.settings.backend='pi';
    const result=quick.start({text:'hello'});
    for(let n=0;n<100 && quick.get(result.id).status==='running';n++)await new Promise(r=>setTimeout(r,5));
    assert.equal(received.conversation.backend,'pi');assert.equal(received.conversation.config.model,'local/pi-model');assert.equal(received.ephemeral,true);
    assert.deepEqual(store.settings,{...settings,backend:'pi'});
  }finally{await quick.close();}
});
