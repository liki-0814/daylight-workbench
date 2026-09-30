import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProxyTools} from '../gateway/tools.js';
import {CustomSources} from '../gateway/custom.js';
async function fixture(t, options = {}) {
 const dataDir=await mkdtemp(path.join(tmpdir(),'daylight-proxy-tools-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const secrets=new Map(),keys={get:async id=>secrets.get(id),set:async(id,v)=>secrets.set(id,v)};
 const custom=new CustomSources({dataDir,secrets:keys,fetchImpl:async()=>Response.json({data:[{id:'found',context_window:1000,max_output_tokens:100}]})});
 let service={state:'stopped',port:4319,autoStart:false,apiKey:'must-not-leak'},requests=0;
 const call=async(url,input)=>{
  if(url==='/api/qoder/status')return service;
  if(url.endsWith('/models')||url.includes('/models?'))return{models:[{id:'m',enabled:true,reasoningEfforts:['low'],contextWindow:1000}]};
  if(url==='/api/custom-proxy/save')return{source:await custom.save(input)};
  if(url==='/api/qoder/service'){service={...service,state:input.enabled?'running':'stopped'};requests++;return service;}
  if(url==='/api/qoder/test')return{message:'ok'};
  requests++;return{ok:true};
 };
 return{tools:createProxyTools({call,custom,dataDir,...options}),custom,secrets,requests:()=>requests};
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
