import test from 'node:test';import assert from 'node:assert/strict';
import {recordEvent,finishEvents} from '../ai/events.mjs';import {qoderEvents} from '../ai/adapters/qoder-events.mjs';
test('Qoder streams text once and preserves thinking, tool input and tool result in order',()=>{
 const c={messages:[]},record=qoderEvents(e=>recordEvent(c,e));
 const event=e=>record({type:'stream_event',event:e});
 event({type:'message_start',message:{id:'m'}});
 event({type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}});event({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'公开的上游内容'}});event({type:'content_block_stop',index:0});
 record({type:'assistant',message:{id:'m',content:[{type:'thinking',thinking:'公开的上游内容'}]}});
 record({type:'assistant',message:{id:'t',content:[{type:'tool_use',id:'tool1',name:'get_workspace',input:{}}]}});
 record({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool1',content:'ok'}]}});
 event({type:'message_start',message:{id:'answer'}});event({type:'content_block_start',index:0,content_block:{type:'text',text:''}});event({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'答案'}});record({type:'assistant',message:{id:'answer',content:[{type:'text',text:'答案'}]}});
 assert.equal(c.messages[0].role,'process');assert.equal(c.messages[0].items.length,2);assert.equal(c.messages[0].items[0].text,'公开的上游内容');assert.equal(c.messages[0].items[1].status,'completed');assert.equal(c.messages[0].items[1].output,'ok');assert.equal(c.messages[1].text,'答案');
});
test('unfinished tools are not marked successful when the run ends',()=>{const c={messages:[]};recordEvent(c,{type:'process',id:'a',name:'tool'});finishEvents(c);assert.equal(c.messages[0].items[0].status,'interrupted');});
