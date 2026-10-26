import test from 'node:test';
import assert from 'node:assert/strict';
import {events} from '../proxy/shared/protocol.js';
import {renderResponsesStream} from '../proxy/shared/protocols/openai-responses.js';
import {renderMessagesStream} from '../proxy/shared/protocols/anthropic-messages.js';

const objects=wire=>wire.split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6)));
test('Responses tool arguments arrive before upstream completion, including interleaved calls',async()=>{
 let pulled=0;
 async function* source(){
  pulled++;yield{type:'reasoning',delta:'Plan'};
  pulled++;yield{type:'tool_call',index:3,id:'a',name:'read',argumentsDelta:'{"path":'};
  pulled++;yield{type:'tool_call',index:7,id:'b',name:'read',argumentsDelta:'{"path":"b"}'};
  pulled++;yield{type:'tool_call',index:3,argumentsDelta:'"a"}'};
  pulled++;yield{type:'text',delta:'Working'};
  pulled++;yield{type:'finish',reason:'tool_calls'};
 }
 const rows=[];
 for await(const chunk of renderResponsesStream(source(),'test'))for(const row of objects(chunk)){
  rows.push(row);
  if(row.type==='response.function_call_arguments.delta'&&row.delta==='{"path":')assert.equal(pulled,2);
 }
 const added=rows.filter(e=>e.type==='response.output_item.added');
 assert.deepEqual(added.map(e=>e.item.type),['reasoning','function_call','function_call','message']);
 const final=rows.at(-1).response;
 assert.deepEqual(final.output.map(i=>i.id),added.map(e=>e.item.id));
 assert.deepEqual(final.output.filter(i=>i.type==='function_call').map(i=>i.arguments),['{"path":"a"}','{"path":"b"}']);
 for(const e of rows.filter(e=>e.type==='response.output_item.done'))assert.equal(e.item.id,final.output[e.output_index].id);
});
test('Messages streams the active tool immediately and buffers an interleaved tool until its block opens',async()=>{
 let pulled=0;
 async function* source(){
  pulled++;yield{type:'tool_call',index:0,id:'a',name:'read',argumentsDelta:'{"path":'};
  pulled++;yield{type:'tool_call',index:1,id:'b',name:'read',argumentsDelta:'{"path":"b"}'};
  pulled++;yield{type:'tool_call',index:0,argumentsDelta:'"a"}'};
  pulled++;yield{type:'finish',reason:'tool_calls'};
 }
 const rows=[];
 for await(const chunk of renderMessagesStream(source(),'test'))for(const row of objects(chunk)){
  rows.push(row);
  if(row.index===0&&row.delta?.partial_json?.startsWith('{"path":'))assert.equal(pulled,1);
 }
 const open=new Set(),args=new Map();
 for(const e of rows){
  if(e.type==='content_block_start'){assert.equal(open.size,0);open.add(e.index);args.set(e.index,'');}
  if(e.type==='content_block_delta'){assert(open.has(e.index));args.set(e.index,args.get(e.index)+e.delta.partial_json);}
  if(e.type==='content_block_stop')assert(open.delete(e.index));
 }
 assert.equal(open.size,0);assert.deepEqual([...args.values()],['{"path":"a"}','{"path":"b"}']);
});
test('Responses reports output exhaustion as incomplete in the event and response body',async()=>{
 const rows=objects((await Array.fromAsync(renderResponsesStream([{type:'text',delta:'partial'},{type:'finish',reason:'length'}],'test'))).join(''));
 assert.equal(rows.at(-1).type,'response.incomplete');assert.equal(rows.at(-1).response.status,'incomplete');
 assert.deepEqual(rows.at(-1).response.incomplete_details,{reason:'max_output_tokens'});
});
test('stream decoding preserves reasoning aliases, thinking signatures and fragmented UTF-8',async()=>{
 const rows=[{choices:[{delta:{reasoning:'思考'},finish_reason:null}]},{choices:[{delta:{content:'答案'},finish_reason:'stop'}]}];
 const bytes=new TextEncoder().encode(rows.map(e=>'data: '+JSON.stringify(e)+'\r\n\r\n').join('')+'data: [DONE]\r\n\r\n');
 const response=new Response(new ReadableStream({start(c){for(const byte of bytes)c.enqueue(Uint8Array.of(byte));c.close();}}));
 const out=await Array.fromAsync(events(response,'chat','test'));
 assert.equal(out.find(e=>e.type==='reasoning')?.delta,'思考');assert.equal(out.find(e=>e.type==='text').delta,'答案');
 const native=[{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}},{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'summary'}},{type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'op'}},{type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'aque'}},{type:'content_block_stop',index:0},{type:'message_stop'}];
 const thoughts=await Array.fromAsync(events(new Response(native.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')),'messages','test'));
 assert.deepEqual(thoughts.find(e=>e.type==='reasoning_signature'),{type:'reasoning_signature',signature:'opaque'});
});
test('Responses keeps thinking segments emitted between text and tool calls',async()=>{
 const source=[{type:'reasoning',delta:'first'},{type:'text',delta:'Checking'},{type:'reasoning',delta:'second'},{type:'tool_call',index:0,id:'call',name:'read',argumentsDelta:'{}'},{type:'reasoning',delta:'third'},{type:'finish',reason:'tool_calls'}];
 const rows=objects((await Array.fromAsync(renderResponsesStream(source,'test'))).join(''));
 assert.deepEqual(rows.filter(e=>e.type==='response.reasoning_summary_text.delta').map(e=>e.delta),['first','second','third']);
 assert.deepEqual(rows.at(-1).response.output.filter(e=>e.type==='reasoning').map(e=>e.summary[0].text),['first','second','third']);
});
