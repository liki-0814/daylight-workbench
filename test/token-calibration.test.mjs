import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {TokenCalibration} from '../proxy/shared/token-calibration.js';
import {StreamingUsage} from '../proxy/shared/llm/streaming-usage.js';
import {renderResponsesStream} from '../proxy/shared/protocols/openai-responses.js';
import {renderChatStream} from '../proxy/shared/protocols/openai-chat.js';
import {relayResult} from '../proxy/shared/relay.js';
import {renderNativeStream} from '../proxy/grok/protocol.js';
import http from 'node:http';
import {once} from 'node:events';
import {createGateway} from '../proxy/gateway.js';
import {convertRequest} from '../proxy/shared/protocol.js';

const context = {provider:'source',model:'model',protocol:'responses',upstreamProtocol:'events',effort:'low'};
const objects = wire => wire.split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)));
async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(),'token-calibration-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const file = path.join(dir,'token-estimates.json');
  return {file,calibration:await TokenCalibration.load(file)};
}
const source = (actual=50) => [{type:'text',delta:'汉'.repeat(100)},{type:'usage',usage:{outputTokens:actual}},{type:'finish',reason:'stop'}];
const render = async (renderer,events,calibration) => objects((await Array.fromAsync(renderer(events,'model',{calibration}))).join(''));

test('converted Chat requests explicitly ask upstreams for final usage', () => {
  for(const protocol of ['responses','messages']){
    const raw=protocol==='responses'?{model:'test',input:'hello',stream:true}:{model:'test',messages:[{role:'user',content:'hello'}],max_tokens:100,stream:true};
    assert.deepEqual(convertRequest(raw,protocol,'chat').stream_options,{include_usage:true});
  }
  const native={model:'test',messages:[],stream:true,stream_options:{include_usage:false}};
  assert.deepEqual(convertRequest(native,'chat','chat'),native);
});

for (const renderer of [renderResponsesStream,renderChatStream]) test(`${renderer.name}: a completed sample improves the next request and survives restart`,async t => {
  const {file,calibration} = await setup(t);
  const first = await render(renderer,source(),calibration.begin(context));
  const counts = rows => rows.filter(e => e.usage?.estimated).map(e => e.usage.output_tokens ?? e.usage.completion_tokens);
  assert.deepEqual(counts(first),[100]);
  const reloaded = await TokenCalibration.load(file);
  const second = await render(renderer,source(),reloaded.begin(context));
  assert.deepEqual(counts(second),[50]);
  const final = renderer === renderResponsesStream ? second.at(-1).response.usage : second.filter(e => e.usage).at(-1).usage;
  assert.equal(final.output_tokens ?? final.completion_tokens,50);
  assert.equal(final.estimated,undefined);
  // Train on raw weight, not the corrected estimate: repeated samples do not compound.
  assert.equal(reloaded.begin(context).factor,0.5);
  const saved = JSON.parse(await readFile(file,'utf8'));
  assert.equal(saved.models[Object.keys(saved.models)[0]].samples,2);
  assert(!JSON.stringify(saved).includes('汉'));
});

test('calibration isolates source, upstream model, protocol and reasoning mode; request factors stay fixed',async t => {
  const {calibration} = await setup(t), inFlight = calibration.begin(context);
  await inFlight.observe({estimated:100,actual:50});
  assert.equal(inFlight.factor,1);
  assert.equal(calibration.begin(context).factor,0.5);
  for (const [field,value] of Object.entries({provider:'other',model:'other',protocol:'chat',upstreamProtocol:'responses',effort:'high'})) assert.equal(calibration.begin({...context,[field]:value}).factor,1);
  await calibration.begin(context).observe({estimated:100,actual:100});
  assert(Math.abs(calibration.begin(context).factor-0.6)<1e-12);
});

test('small, outlier, hidden reasoning and invalid samples do not pollute learned factors',async t => {
  const {calibration} = await setup(t);
  for (const sample of [{estimated:3,actual:40},{estimated:100,actual:0},{estimated:100,actual:500},{estimated:100,actual:NaN},{estimated:100,actual:100,reasoningTokens:50,reasoningVisible:false}]) await calibration.begin(context).observe(sample);
  assert.equal(calibration.begin(context).factor,1);
  await calibration.begin(context).observe({estimated:100,actual:50,reasoningTokens:10,reasoningVisible:true});
  assert.equal(calibration.begin(context).factor,0.5);
});

test('errors, truncated, missing, stale or estimated usage and cancelled streams never train',async t => {
  const {calibration} = await setup(t);
  const cases = [
    [...source().slice(0,2),{type:'finish',reason:'length'}],
    [...source(),{type:'error',message:'failed'}],
    [{type:'text',delta:'汉'.repeat(100)},{type:'finish',reason:'stop'}],
    [{type:'usage',usage:{outputTokens:50}},{type:'text',delta:'汉'.repeat(100)},{type:'finish',reason:'stop'}],
    [{type:'text',delta:'汉'.repeat(100)},{type:'usage',usage:{outputTokens:50,estimated:true}},{type:'finish',reason:'stop'}],
    [{type:'text',delta:'汉'.repeat(100)},{type:'usage',usage:{outputTokens:50}},{type:'native',event:{type:'response.completed',response:{}}},{type:'finish',reason:'stop'}],
  ];
  for (const events of cases) await render(renderResponsesStream,events,calibration.begin(context));
  for await (const wire of renderResponsesStream(source(),'model',{calibration:calibration.begin(context)})) if (objects(wire).some(e => e.type === 'response.output_text.delta')) break;
  assert.equal(calibration.begin(context).factor,1);
});

test('real midstream counts stay exact; corrections only scale newly estimated output', () => {
  const counter = new StreamingUsage({calibration:{factor:0.5}});
  counter.add('汉'.repeat(100));
  assert.equal(counter.snapshot().outputTokens,50);
  counter.observe({outputTokens:80});
  assert.equal(counter.snapshot().outputTokens,80);
  counter.add('汉'.repeat(20));
  assert.equal(counter.snapshot().outputTokens,90);
});

for (const protocol of ['chat','responses']) test(`native ${protocol} relays learn from complete streams`,async t => {
  const {calibration} = await setup(t);
  const wire = protocol === 'responses' ? [
    {type:'response.output_text.delta',delta:'汉'.repeat(100)},
    {type:'response.completed',response:{output:[],usage:{output_tokens:50}}},
  ].map(e => 'data: '+JSON.stringify(e)+'\n\n').join('') : [
    {choices:[{delta:{content:'汉'.repeat(100)}}]},
    {choices:[],usage:{completion_tokens:50}},
  ].map(e => 'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n';
  for (let i=0;i<2;i++) {
    let output='';
    await relayResult({response:new Response(wire),streaming:true,model:'model',protocol},{stream:true},protocol,{writeHead(){},write(c){output+=c;return true;},end(){}},undefined,()=>{},{calibration:calibration.begin(context)});
    const estimated=objects(output).find(e => e.usage?.estimated).usage;
    assert.equal(estimated.output_tokens ?? estimated.completion_tokens,i===0?100:50);
  }
});

test('Grok native renderer shares the same calibration path',async t => {
  const {calibration}=await setup(t);
  const events=[
    {type:'native_response',event:{type:'response.output_text.delta',delta:'汉'.repeat(100)}},
    {type:'native_response',event:{type:'response.completed',response:{usage:{output_tokens:50}}}},
    {type:'finish',reason:'stop'},
  ];
  await Array.fromAsync(renderNativeStream(events,'model',{calibration:calibration.begin(context)}));
  assert.equal(calibration.begin(context).factor,0.5);
});

test('a corrupt calibration cache or persistence failure cannot break inference',async t => {
  const {file}=await setup(t);
  await writeFile(file,'broken');
  const calibration=await TokenCalibration.load(file);
  await render(renderResponsesStream,source(),calibration.begin(context));
  assert.equal(await readFile(file,'utf8'),'broken');
  const rows=await render(renderResponsesStream,source(),{factor:1,observe:async()=>{throw Error('disk unavailable');}});
  assert.equal(rows.at(-1).type,'response.completed');
});

test('parallel samples persist both models without lost updates',async t => {
  const {file,calibration}=await setup(t);
  const other={...context,model:'other'};
  await Promise.all([calibration.begin(context).observe({estimated:100,actual:50}),calibration.begin(other).observe({estimated:100,actual:200})]);
  const saved=await TokenCalibration.load(file);
  assert.equal(saved.begin(context).factor,0.5);
  assert.equal(saved.begin(other).factor,2);
});

for (const mode of ['adapted','native','converted']) test(`gateway ${mode} routes reuse learned estimates while recording real usage`,async t => {
  const {calibration}=await setup(t), records=[],finishing=new Set();let settings;
  const protocol=mode==='converted'?'chat':'responses';
  const wire=protocol==='responses'?[
    {type:'response.output_text.delta',delta:'汉'.repeat(100)},
    {type:'response.completed',response:{output:[],usage:{output_tokens:50}}},
  ]:[{choices:[{delta:{content:'汉'.repeat(100)}}]},{choices:[],usage:{completion_tokens:50}}];
  const registry={providers:{fixture:{}},execute:async()=>mode==='adapted'?{kind:'events',events:(async function*(){yield*source();})()}:{kind:'response',response:new Response(wire.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+(protocol==='chat'?'data: [DONE]\n\n':'')),streaming:true,model:'alias',upstreamModel:'actual',protocol}};
  const gateway=createGateway({getSettings:()=>settings,registry,calibration,sourceState:{revision:()=> 'test'},records:{append:async row=>records.push(row)},active:new Set(),finishing,
    router:{candidates:async()=>[{provider:'fixture',upstreamId:'actual',effort:'low'}],success(){},failed(){assert.fail('unexpected retry');}}});
  const server=http.createServer(gateway);server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  settings={port:server.address().port,apiKey:'test-key'};
  for(let i=0;i<2;i++){
    const response=await fetch(`http://127.0.0.1:${settings.port}/v1/responses`,{method:'POST',headers:{Authorization:'Bearer test-key','Content-Type':'application/json'},body:JSON.stringify({model:'alias',input:'hello',stream:true})});
    const rows=objects(await response.text());
    assert.equal(response.status,200);
    assert.equal(rows.find(e=>e.usage?.estimated).usage.output_tokens,i===0?100:50);
    await Promise.all([...finishing]);
  }
  assert(records.every(row=>row.usage.outputTokens===50&&!row.usage.estimated));
});
