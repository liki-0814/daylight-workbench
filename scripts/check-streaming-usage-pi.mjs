// Verify the installed Pi adapter and agent event lifecycle with synthetic SSE.
// No network, real accounts, or user configuration writes.
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import extension from '../integrations/pi/daylight-streaming-usage.js';
import {renderResponsesStream} from '../proxy/shared/protocols/openai-responses.js';

const piRoot = process.argv[2];
if (!piRoot) throw Error('Pass the installed pi-coding-agent package directory');
const modules = path.resolve(piRoot, '../..');
const [{stream}, {runAgentLoop}] = await Promise.all([
  import(pathToFileURL(path.join(modules,'@earendil-works/pi-ai/dist/api/openai-responses.js'))),
  import(pathToFileURL(path.join(modules,'@earendil-works/pi-agent-core/dist/agent-loop.js'))),
]);
const handlers = {};
extension({on:(name,handler) => handlers[name] = handler});
const gates = [Promise.withResolvers(),Promise.withResolvers()];
const model = {id:'fixture',name:'fixture',api:'openai-responses',provider:'daylight',baseUrl:'https://fixture.invalid/v1',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:100};
async function* source() {
  yield {type:'reasoning',delta:'思考'};
  await gates[0].promise;
  yield {type:'text',delta:'Hello world'};
  await gates[1].promise;
  yield {type:'usage',usage:{inputTokens:10,outputTokens:1,totalTokens:11}};
  yield {type:'finish',reason:'stop'};
}
const live = [];
const signal = AbortSignal.timeout(10000);
const messages = await runAgentLoop([{role:'user',content:'hello',timestamp:Date.now()}],{systemPrompt:'',messages:[],tools:[]},{model,convertToLlm:messages => messages},async event => {
  await handlers[event.type]?.(event);
  const delta = event.assistantMessageEvent;
  if (delta?.type === 'thinking_delta' && delta.delta === '思考') {
    assert.equal(delta.partial.usage.output,2);
    live.push(delta.partial.usage.output);
    gates[0].resolve();
  }
  if (delta?.type === 'text_delta') {
    assert.equal(delta.partial.usage.output,5);
    live.push(delta.partial.usage.output);
    gates[1].resolve();
  }
},signal,(model,context,options) => stream(model,context,{...options,apiKey:'fixture',
  onPayload:() => handlers.before_provider_request(),
  onProviderStreamEvent:data => handlers.provider_stream_event({data,provider:model.provider,api:model.api}),
  fetch:async () => {
    const iterator = renderResponsesStream(source(),'fixture')[Symbol.asyncIterator]();
    return new Response(new ReadableStream({async pull(controller) {
      const step = await iterator.next();
      if (step.done) controller.close();
      else controller.enqueue(new TextEncoder().encode(step.value));
    },async cancel() { for (const gate of gates) gate.resolve();await iterator.return?.(); }},{highWaterMark:0}),{headers:{'content-type':'text/event-stream'}});
  },
}));
assert.deepEqual(live,[2,5]);
assert.equal(messages.at(-1).usage.output,1);
assert.equal(messages.at(-1).usage.estimated,undefined);
console.log('Installed Pi: live output 2 → 5, authoritative final output 1; no network or user configuration used.');
