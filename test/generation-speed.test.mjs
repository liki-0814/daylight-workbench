import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RequestTrace,RequestRecords} from '../proxy/shared/request-records.js';
import {TokenCalibration} from '../proxy/shared/token-calibration.js';
import {createGateway} from '../proxy/gateway.js';
import {createProxyState} from '../public/proxy/state.js';

function traceFixture() {
  let now=0;
  const trace=new RequestTrace('/responses',{now:()=>now});
  trace.startGeneration({provider:'source',sourceRevision:'revision',model:'alias',upstreamModel:'actual',effort:'low'});
  trace.observe({stage:'upstream'});
  return {trace,at:time=>{now=time;},finish:()=>trace.finish(200,200)};
}
function chunks(f) {
  f.at(1000);f.trace.event({type:'reasoning',delta:'思'.repeat(20)});
  f.at(2000);f.trace.event({type:'text',delta:'文'.repeat(60)});
  f.trace.event({type:'usage',usage:{outputTokens:40}});
  f.trace.event({type:'finish',reason:'stop'});
}

test('passive speed combines reasoning and text, excludes initial/trailing waits and treats chunks as multiple tokens',()=>{
  const f=traceFixture();chunks(f);f.at(9000);
  const row=f.finish();
  assert.equal(row.generationSpeed.tokensPerSecond,30);
  assert.equal(row.generationSpeed.outputTokens,40);
  assert.equal(row.generationSpeed.durationMs,1000);
  assert.equal(row.generationSpeed.estimated,false);
  assert.equal(row.generationSpeed.timing,'stream');
  assert.equal(row.durationMs,9000);
  assert.doesNotMatch(JSON.stringify(row),/思|文/);
});

test('authoritative Chinese usage is never scaled; only missing or stale counts use learned estimates',()=>{
  const actual=traceFixture();actual.trace.generation.counter.factor=0.5;chunks(actual);
  assert.equal(actual.finish().generationSpeed.outputTokens,40);
  const missing=traceFixture();missing.trace.generation.counter.factor=0.5;
  missing.at(1000);missing.trace.event({type:'text',delta:'中'.repeat(20)});
  missing.trace.event({type:'usage',usage:{outputTokens:5,estimated:true}});
  missing.at(2000);missing.trace.event({type:'text',delta:'文'.repeat(60)});
  missing.trace.event({type:'finish',reason:'stop'});
  const row=missing.finish();assert.equal(row.usage,undefined);assert.equal(row.generationSpeed.outputTokens,40);assert.equal(row.generationSpeed.estimated,true);assert.equal(row.generationSpeed.tokensPerSecond,30);
  const stale=traceFixture();stale.at(1000);stale.trace.event({type:'text',delta:'中'.repeat(20)});stale.trace.event({type:'usage',usage:{outputTokens:20}});
  stale.at(2000);stale.trace.event({type:'text',delta:'文'.repeat(60)});stale.trace.event({type:'finish',reason:'stop'});
  assert.equal(stale.finish().generationSpeed.estimated,true);
});

test('hidden thinking and JSON use a separate upstream window without losing thinking tokens',()=>{
  const hidden=traceFixture();chunks(hidden);hidden.trace.observe({usage:{outputTokens:100,outputDetails:{reasoning_tokens:60}}});hidden.at(5000);
  const speed=hidden.finish().generationSpeed;assert.equal(speed.outputTokens,100);assert.equal(speed.durationMs,2000);assert.equal(speed.tokensPerSecond,50);assert.equal(speed.timing,'upstream');
  const json=traceFixture();json.at(2000);json.trace.observe({usage:{outputTokens:80},finish:'stop'});
  assert.equal(json.finish().generationSpeed.tokensPerSecond,40);
});

test('failed, cancelled, test, short, single buffered and heartbeat-only responses do not contribute',()=>{
  for(const outcome of ['failed','cancelled','timeout']){const f=traceFixture();chunks(f);f.trace.fail({code:'interrupted'},outcome);assert.equal(f.finish().generationSpeed,undefined);}
  const diagnostic=traceFixture();chunks(diagnostic);diagnostic.trace.observe({origin:'test'});assert.equal(diagnostic.finish().generationSpeed,undefined);
  const short=traceFixture();chunks(short);short.trace.observe({usage:{outputTokens:2}});assert.equal(short.finish().generationSpeed,undefined);
  const buffered=traceFixture();buffered.at(1000);buffered.trace.event({type:'text',delta:'中'.repeat(100)});buffered.trace.event({type:'usage',usage:{outputTokens:100}});buffered.trace.event({type:'finish',reason:'stop'});assert.equal(buffered.finish().generationSpeed,undefined);
  const heartbeat=traceFixture();heartbeat.at(1000);heartbeat.trace.event({type:'native',event:{type:'ping'}});heartbeat.trace.event({type:'finish',reason:'stop'});assert.equal(heartbeat.finish().generationSpeed,undefined);
});

test('fallback resets partial usage, timing and calibration; summaries isolate source, model, revision, effort, tier and estimates',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'generation-speed-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const f=traceFixture();chunks(f);f.trace.generation.counter.factor=2;
  f.trace.startGeneration({provider:'fallback',upstreamModel:'fallback-model'});
  assert.equal(f.trace.entry.usage,undefined);assert.equal(f.trace.entry.firstContentMs,undefined);assert.equal(f.trace.generation.counter.factor,1);
  const file=path.join(dir,'usage.json'),records=new RequestRecords(file,[]),base=traceFixture();chunks(base);const row=base.finish();
  for(let n=1;n<=25;n++)await records.append({...row,completedAt:new Date(n*1000).toISOString(),generationSpeed:{...row.generationSpeed,tokensPerSecond:n}});
  for(const extra of [{provider:'other'},{sourceRevision:'old'},{upstreamModel:'other-model'},{effort:'high'},{actualTier:'priority'},{origin:'test'},{outcome:'failed'},{generationSpeed:{...row.generationSpeed,estimated:true}},{generationSpeed:{...row.generationSpeed,timing:'upstream'}}])await records.append({...row,...extra});
  const reloaded=await RequestRecords.load(file),groups=reloaded.speeds('source','revision'),normal=groups.find(g=>g.model==='actual'&&g.effort==='low'&&g.tier==='auto'&&!g.estimated&&g.timing==='stream');
  assert.equal(normal.samples,20);assert.equal(normal.tokensPerSecond,15.5);assert.equal(normal.lastTokensPerSecond,25);assert.equal(groups.length,6);
  assert.deepEqual(reloaded.speeds('missing','revision'),[]);
});

for(const mode of ['adapted','native','converted','messages'])test(`real gateway ${mode}: learns Chinese calibration, attributes fallback and persists passive results`,async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'generation-gateway-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const records=new RequestRecords(path.join(dir,'usage.json'),[]),calibration=await TokenCalibration.load(path.join(dir,'calibration.json')),finishing=new Set();let settings,calls=0;
  const protocol=mode==='converted'?'chat':mode==='messages'?'messages':'responses';
  async function* output(actual){yield{type:'reasoning',delta:'想'.repeat(20)};await delay(300);yield{type:'text',delta:'中'.repeat(80)};if(actual)yield{type:'usage',usage:{outputTokens:50}};yield{type:'finish',reason:'stop'};}
  function wire(actual){
    const encoder=new TextEncoder();
    const frames=protocol==='chat'?[{choices:[{delta:{reasoning_content:'想'.repeat(20)}}]},{choices:[{delta:{content:'中'.repeat(80)}}]},...(actual?[{usage:{completion_tokens:50}}]:[]),'[DONE]']:
      protocol==='messages'?[{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'想'.repeat(20)}},{type:'content_block_delta',delta:{type:'text_delta',text:'中'.repeat(80)}},...(actual?[{type:'message_delta',usage:{output_tokens:50}}]:[]),{type:'message_stop'}]:
      [{type:'response.reasoning_text.delta',delta:'想'.repeat(20)},{type:'response.output_text.delta',delta:'中'.repeat(80)},{type:'response.completed',response:{output:[],...(actual?{usage:{output_tokens:50}}:{})}}];
    return new Response(new ReadableStream({async start(controller){try{for(let i=0;i<frames.length;i++){if(i===1)await delay(300);controller.enqueue(encoder.encode('data: '+(typeof frames[i]==='string'?frames[i]:JSON.stringify(frames[i]))+'\n\n'));}controller.close();}catch(error){controller.error(error);}}}),{headers:{'content-type':'text/event-stream'}});
  }
  const registry={providers:{failed:{},source:{}},execute:async id=>{calls++;if(id==='failed')throw Object.assign(Error('offline'),{status:503});return mode==='adapted'?{kind:'events',events:output(calls<=4)}:{kind:'response',response:wire(calls<=4),streaming:true,protocol,model:'alias',upstreamModel:'actual'};}};
  const gateway=createGateway({getSettings:()=>settings,registry,calibration,records,finishing,active:new Set(),sourceState:{revision:()=> 'revision'},router:{candidates:async()=>[{provider:'failed',id:'alias'},{provider:'source',id:'alias',upstreamId:'actual',effort:'low'}],failed(){},success(){}}});
  const server=http.createServer(gateway);server.listen(0,'127.0.0.1');await once(server,'listening');settings={port:server.address().port,apiKey:'key'};
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  for(let i=0;i<3;i++){
    const input=mode==='messages'?{model:'alias',messages:[{role:'user',content:'test'}],max_tokens:1024,stream:true}:{model:'alias',input:'test',stream:true};
    const response=await fetch(`http://127.0.0.1:${settings.port}/v1/${mode==='messages'?'messages':'responses'}`,{method:'POST',headers:{Authorization:'Bearer key','Content-Type':'application/json'},body:JSON.stringify(input)});
    assert.equal(response.status,200);await response.text();await Promise.all([...finishing]);
  }
  assert.equal(calls,6);assert.equal(records.rows.length,3);
  assert(records.rows.every(row=>row.provider==='source'&&row.upstreamModel==='actual'&&row.generationSpeed?.tokensPerSecond>0));
  assert.equal(records.rows[0].generationSpeed.estimated,false);
  assert.equal(records.rows[2].generationSpeed.estimated,true);
  assert.equal(records.rows[2].generationSpeed.outputTokens,50);
  assert.equal(records.rows[2].usage?.outputTokens,undefined);
  assert.doesNotMatch(JSON.stringify(records.rows),/想|中|offline/);
});

test('poll failures preserve the last source statistics and recover without generating requests',async()=>{
  let fail=false,requests=0;
  const store=createProxyState({request:async op=>{requests++;if(op==='status')return{state:'running'};if(fail)throw Error('offline');return{sources:[{id:'source',revision:'revision',performance:[{model:'actual',tokensPerSecond:42,samples:2}]}]};}});
  await store.refresh();const previous=store.source('source');fail=true;await store.refresh();assert.strictEqual(store.source('source'),previous);assert.equal(store.error,'offline');fail=false;await store.refresh();assert.equal(store.error,'');assert.equal(requests,6);store.dispose();
});
