import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {CustomSources} from '../proxy/custom/sources.js';
import {createProxyService} from '../proxy/service.js';

const manual={id:'my-alias',upstreamId:'vendor-model',enabled:true,referenceId:'reference-model',contextWindow:128000,maxOutputTokens:4096,reasoningEfforts:['low','high'],effort:'high',cost:{input:1,output:2,cacheRead:null,cacheWrite:null}};
async function fixture(t){
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'daylight-resave-'));t.after(()=>rm(dataDir,{recursive:true,force:true,maxRetries:3}));
 const source={id:'original',name:'Monkey_api',baseUrl:'https://example.test/v1',protocol:'chat',auth:'bearer',enabled:true,hasKey:true,hasHeaders:false,defaultMaxTokens:4096,models:[manual],keys:[{id:'default',enabled:true,hasKey:true,models:[manual]},{id:'second',enabled:false,hasKey:true,models:[{...manual,id:'disabled-alias',enabled:false}]}],unknownSetting:{preserve:true}};
 const other={...source,id:'other',name:'青阁科技中转api'};
 const vault=new Map(),calls=[];let failAt=0,writes=0;
 const secrets={
  get:async id=>{calls.push(['get',id]);assert.match(id,/:credential:/,'must not read old entries');return vault.get(id);},
  set:async(id,value)=>{calls.push(['set',id]);assert.match(id,/:credential:/,'must not update old entries');if(++writes===failAt)throw Error('fixture write denied');vault.set(id,value);},
  delete:async id=>{calls.push(['delete',id]);assert.match(id,/:credential:/,'must not delete old entries');vault.delete(id);},
 };
 const custom=new CustomSources({dataDir,secrets,fetchImpl:async(_url,options)=>{calls.push(['fetch',options.headers.Authorization]);return Response.json({data:[{id:'vendor-model'}]});}});
 await mkdir(path.dirname(custom.file),{recursive:true});await writeFile(custom.file,JSON.stringify([source,other]));
 return {dataDir,source,other,custom,vault,calls,secrets,failWrite:n=>{failAt=n;}};
}
const withoutCredentials=source=>({...source,revision:undefined,keys:source.keys.map(({credentialId,...key})=>key)});

test('resave keeps both sources and all model/manual settings, then reads and queries new entries after restart',async t=>{
 const f=await fixture(t),updated=await f.custom.resaveCredentials({id:f.source.id,keys:[{id:'default',apiKey:'new-one'},{id:'second',apiKey:'new-two'}],models:[],baseUrl:'ignored'});
 assert.deepEqual(withoutCredentials(updated),withoutCredentials(f.source));
 const stored=JSON.parse(await readFile(f.custom.file,'utf8'));assert.deepEqual(stored[1],f.other);
 assert.deepEqual(stored.map(s=>s.id),['original','other']);assert.equal(f.calls.length,2);assert(f.calls.every(([op])=>op==='set'));
 assert(updated.keys.every(k=>k.credentialId));assert.notEqual(updated.keys[0].credentialId,updated.keys[1].credentialId);
 assert(!JSON.stringify(stored).includes('new-one'));assert(!JSON.stringify(updated).includes('new-two'));
 const restarted=new CustomSources({dataDir:f.dataDir,secrets:f.secrets,fetchImpl:f.custom.fetchImpl});
 assert.equal(await restarted.readKey(updated.id),'new-one');assert.equal(await restarted.readKey(updated.id,'second'),'new-two');
 assert.equal((await restarted.discoverAll(updated.id)).models[0].id,'vendor-model');
 const again=await restarted.resaveCredentials({id:updated.id,keys:[{id:'default',apiKey:'third'}]});
 assert.notEqual(again.keys[0].credentialId,updated.keys[0].credentialId);assert.equal(again.keys[1].credentialId,updated.keys[1].credentialId);
 assert.equal(await restarted.readKey(updated.id),'third');assert.equal(f.calls.filter(([op])=>op==='delete').length,0);
});
test('failed second write keeps original source file and cleans only newly allocated entries',async t=>{
 const f=await fixture(t),before=await readFile(f.custom.file,'utf8');f.failWrite(2);
 await assert.rejects(f.custom.resaveCredentials({id:'original',keys:[{id:'default',apiKey:'new-one'},{id:'second',apiKey:'new-two'}]}),/fixture write denied/);
 assert.equal(await readFile(f.custom.file,'utf8'),before);assert.equal(f.vault.size,0);assert(f.calls.every(([,id])=>id.includes(':credential:')));
});
test('empty/unknown/duplicate inputs fail before touching credentials or settings',async t=>{
 const f=await fixture(t),before=await readFile(f.custom.file,'utf8');
 for(const input of [{id:'missing',keys:[]},{id:'original',keys:[]},{id:'original',keys:[{id:'missing',apiKey:'key'}]},{id:'original',keys:[{id:'default',apiKey:''}]},{id:'original',keys:[{id:'default',apiKey:'key'},{id:'default',apiKey:'key'}]}])await assert.rejects(f.custom.resaveCredentials(input));
 assert.equal(f.calls.length,0);assert.equal(await readFile(f.custom.file,'utf8'),before);
});
test('ordinary saves retain credential references from disk and re-entry allocates fresh locations',async t=>{
 const f=await fixture(t),first=await f.custom.resaveCredentials({id:'original',keys:[{id:'default',apiKey:'one'}]});
 const blank=await f.custom.save({...first,keys:first.keys.map(k=>({...k,credentialId:'forged',apiKey:''}))});
 assert.equal(blank.keys[0].credentialId,first.keys[0].credentialId);assert.equal(blank.keys[1].credentialId,undefined);assert.equal(f.calls.length,1);
 const replacement=await f.custom.save({...blank,keys:blank.keys.map(k=>({...k,apiKey:k.id==='default'?'replacement':''}))});
 assert.notEqual(replacement.keys[0].credentialId,blank.keys[0].credentialId);assert.equal(await f.custom.readKey('original'),'replacement');
});
test('legacy single-key sources can resave without reading or updating the old credential',async t=>{
 const f=await fixture(t),legacy={...f.source};delete legacy.keys;await writeFile(f.custom.file,JSON.stringify([legacy,f.other]));
 const saved=await f.custom.resaveCredentials({id:'original',keys:[{id:'default',apiKey:'replacement'}]});
 assert.deepEqual(saved.models,legacy.models);assert.equal(await f.custom.readKey('original'),'replacement');
});
test('UI management endpoint saves credentials separately and rejects GET without touching the vault',async t=>{
 const f=await fixture(t),bridge=await createProxyService({dataDir:f.dataDir,customSources:f.custom,provider:{listModels:async()=>[]}});
 const server=http.createServer((q,r)=>bridge.handle(q,r));server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{await bridge.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const url=`http://127.0.0.1:${server.address().port}/api/proxy/custom/sources/credentials`;
 assert.equal((await fetch(url)).status,404);assert.equal(f.calls.length,0);
 const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'original',keys:[{id:'default',apiKey:'replacement'}]})});
 assert.equal(response.status,200);const saved=(await response.json()).source;assert.deepEqual(withoutCredentials(saved),withoutCredentials(f.source));
 assert(!JSON.stringify(saved).includes('replacement'));assert.equal(f.calls.length,1);
});
