import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamingUsage} from '../proxy/shared/llm/streaming-usage.js';
import {events} from '../proxy/shared/protocol.js';
import {relayResult} from '../proxy/shared/relay.js';
import {renderChatStream} from '../proxy/shared/protocols/openai-chat.js';
import {renderResponsesStream} from '../proxy/shared/protocols/openai-responses.js';
import {decodeStream,renderNativeStream} from '../proxy/grok/protocol.js';
import extension from '../integrations/pi/daylight-streaming-usage.js';

const objects = wire => wire.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
const sse = rows => new Response(rows.map(row => `data: ${JSON.stringify(row)}\n\n`).join(''));
test('stream estimates are cumulative across chunks, preserve unknown input and rebase on actual usage', () => {
  const split = new StreamingUsage(), whole = new StreamingUsage();
  const text = 'Hello 世界 😀';
  for (const char of text.split('')) split.add(char);
  whole.add(text);
  assert.deepEqual(split.snapshot(), whole.snapshot());
  assert.equal(split.snapshot().estimated, true);
  assert.equal(split.snapshot().inputTokens, undefined);
  assert.equal(split.snapshot().totalTokens, undefined);
  split.observe({inputTokens:10,outputTokens:2,totalTokens:12,cacheReadTokens:0});
  assert.deepEqual(split.snapshot(), {inputTokens:10,outputTokens:2,totalTokens:12,cacheReadTokens:0,cacheHitRate:0});
  split.add('more');
  assert.deepEqual(split.snapshot(), {inputTokens:10,outputTokens:3,totalTokens:13,cacheReadTokens:0,cacheHitRate:0,estimated:true});
  split.observe({outputTokens:0,totalTokens:10});
  assert.equal(split.snapshot().outputTokens, 0);
  assert.equal(split.snapshot().estimated, undefined);
});

for (const renderer of [renderChatStream,renderResponsesStream]) test(`${renderer.name} emits estimates before completion and preserves authoritative final usage`, async () => {
  let completed = false;
  const actual = {inputTokens:100,outputTokens:2,totalTokens:102,cacheReadTokens:60};
  async function* source() {
    yield {type:'reasoning',delta:'思考'};
    yield {type:'text',delta:'Hello world'};
    yield {type:'tool_call',index:0,id:'c',name:'echo',argumentsDelta:'{"text":"hi"}'};
    completed = true;
    yield {type:'usage',usage:actual};
    yield {type:'finish',reason:'tool_calls'};
  }
  const rows = [], counts = [];
  for await (const wire of renderer(source(),'fixture')) for (const row of objects(wire)) {
    rows.push(row);
    if (row.usage?.estimated) {
      assert.equal(completed, false);
      counts.push(row.usage.completion_tokens ?? row.usage.output_tokens);
    }
  }
  assert.equal(counts.length, 3);
  assert(counts.every((count,i) => count > 0 && (i === 0 || count > counts[i-1])));
  const final = renderer === renderChatStream ? rows.filter(row => row.usage).at(-1).usage : rows.at(-1).response.usage;
  assert.equal(final.completion_tokens ?? final.output_tokens, 2);
  assert.equal(final.estimated, undefined);
  assert.equal(final.total_tokens, 102);
});

test('real upstream snapshots reach conversion before the stream ends', async () => {
  const rows = [
    {type:'response.in_progress',response:{usage:{input_tokens:10,output_tokens:1}}},
    {type:'response.output_text.delta',delta:'next'},
    {type:'response.completed',response:{output:[],usage:{input_tokens:10,output_tokens:3}}},
  ];
  const canonical = await Array.fromAsync(events(sse(rows),'responses','fixture'));
  assert(canonical.findIndex(e => e.type === 'usage') < canonical.findIndex(e => e.type === 'text'));
  assert.deepEqual(canonical.filter(e => e.type === 'usage').map(e => e.usage.outputTokens), [1,3]);
});

for (const protocol of ['responses','chat']) test(`native ${protocol} adds display usage without changing opaque output, final counts or observed usage`, async () => {
  const finalUsage = protocol === 'responses' ? {input_tokens:10,output_tokens:1} : {prompt_tokens:10,completion_tokens:1};
  const rows = protocol === 'responses' ? [
    {type:'response.created',response:{id:'r',output:[]}},
    {type:'response.output_text.delta',delta:'Hello world',future:'opaque'},
    {type:'response.completed',response:{id:'r',output:[{type:'reasoning',encrypted_content:'opaque'}],usage:finalUsage}},
  ] : [
    {choices:[{index:0,delta:{content:'Hello world'}}],future:'opaque'},
    {choices:[{index:0,delta:{},finish_reason:'stop'}],usage:finalUsage},
  ];
  const response = sse(rows);
  let upstream = response;
  if (protocol === 'chat') {
    const body = await response.text();
    // Chat has a separate terminal sentinel.
    upstream = new Response(body + 'data: [DONE]\n\n');
  }
  const observed = []; let wire = '';
  await relayResult({response:upstream,streaming:true,model:'fixture',protocol},{stream:true},protocol,{writeHead(){},write(chunk){wire += chunk;return true;},end(){}},undefined,info => observed.push(info));
  const out = objects(wire), delta = out.find(row => row.future);
  assert.equal(delta.future,'opaque');
  assert.equal(delta.usage.estimated,true);
  assert.equal(delta.usage.completion_tokens ?? delta.usage.output_tokens,3);
  assert.deepEqual(protocol === 'responses' ? out.at(-1).response.usage : out.at(-1).usage,finalUsage);
  if (protocol === 'responses') assert.equal(out.at(-1).response.output[0].encrypted_content,'opaque');
  assert.equal(observed.filter(row => row.usage).length,1);
  assert.equal(observed.find(row => row.usage).usage.outputTokens,1);
  assert(observed.every(row => !row.usage?.estimated));
});

test('Grok native Responses and converted events preserve live snapshots and final usage',async () => {
  const rows = [
    {type:'response.in_progress',response:{usage:{input_tokens:10,output_tokens:1}}},
    {type:'response.output_text.delta',delta:'Hello world'},
    {type:'response.completed',response:{output:[],usage:{input_tokens:10,output_tokens:2}}},
  ];
  const canonical = await Array.fromAsync(decodeStream(sse(rows),'fixture'));
  assert.deepEqual(canonical.filter(e => e.type === 'usage').map(e => e.usage.outputTokens),[1,2]);
  const out = objects((await Array.fromAsync(renderNativeStream(canonical))).join(''));
  assert.equal(out[1].usage.output_tokens,4);
  assert.equal(out[1].usage.estimated,true);
  assert.deepEqual(out.at(-1).response.usage,rows.at(-1).response.usage);
});

test('Pi bridge updates the shared live usage before delta handlers and leaves final calibration to Pi', () => {
  const handlers = {};
  extension({on:(name,handler) => handlers[name] = handler});
  const raw = usage => handlers.provider_stream_event({provider:'daylight',api:'openai-responses',data:{type:'response.output_text.delta',usage}});
  handlers.before_provider_request();
  raw({output_tokens:3,estimated:true}); // May arrive before message_start is delivered.
  const partial = {role:'assistant',provider:'daylight',api:'openai-responses',usage:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  handlers.message_start({message:{...partial}});
  assert.equal(partial.usage.output,3);
  raw({input_tokens:100,output_tokens:5,total_tokens:105,input_tokens_details:{cached_tokens:60},estimated:true});
  assert.equal(partial.usage.output,5);
  assert.equal(partial.usage.input,40);
  assert.equal(partial.usage.cacheRead,60);
  partial.usage = {input:40,output:2,cacheRead:60,totalTokens:102}; // Built-in finalization replaces usage.
  handlers.message_end({message:partial});
  assert.deepEqual(partial.usage,{input:40,output:2,cacheRead:60,totalTokens:102});
  handlers.before_provider_request();
  const other = {...partial,provider:'other',usage:{output:0}};
  handlers.message_start({message:other});
  raw({output_tokens:9,estimated:true});
  assert.equal(other.usage.output,0);
});

test('display estimates never become final usage when the upstream omits counts or fails', async () => {
  for (const terminal of [{type:'finish',reason:'length'},{type:'error',message:'failed'}]) {
    const out = objects((await Array.fromAsync(renderResponsesStream([{type:'text',delta:'Hello world'},terminal],'fixture'))).join(''));
    assert.equal(out.find(e => e.type === 'response.output_text.delta').usage.estimated,true);
    assert.equal(out.at(-1).type,terminal.type === 'error' ? 'response.failed' : 'response.incomplete');
    assert.equal(out.at(-1).response.usage,undefined);
  }
});

test('closing a rendered stream cancels its source instead of fabricating a final usage', async () => {
  let closed = false;
  async function* source() {
    try { yield {type:'text',delta:'Hello world'}; yield {type:'text',delta:'next'}; }
    finally { closed = true; }
  }
  const iterator = renderResponsesStream(source(),'fixture');
  for await (const wire of iterator) {
    if (objects(wire).some(e => e.type === 'response.output_text.delta')) break;
  }
  assert.equal(closed,true);
});
