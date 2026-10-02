import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUsage, mergeUsage } from '../proxy/shared/llm/usage.js';
import { renderChatResponse, renderChatStream } from '../proxy/shared/protocols/openai-chat.js';
import { renderResponsesResponse, renderResponsesStream } from '../proxy/shared/protocols/openai-responses.js';
import { renderMessagesResponse, renderMessagesStream } from '../proxy/shared/protocols/anthropic-messages.js';
const events = [{type:'usage',usage:parseUsage({prompt_tokens:100,prompt_tokens_details:{cached_tokens:60,cache_write_tokens:10,audio_tokens:2}})}, {type:'text',delta:'OK'}, {type:'usage',usage:parseUsage({completion_tokens:20,completion_tokens_details:{reasoning_tokens:5}})}, {type:'finish',reason:'stop'}];
const streamObjects = async renderer => { let text='';for await(const chunk of renderer(events,'test'))text+=chunk;return text.split('\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6))); };
test('all three protocols preserve partial cumulative usage and cache in both modes',async()=>{
 const chat=await renderChatResponse(events,'test');assert.equal(chat.usage.prompt_tokens_details.cached_tokens,60);assert.equal(chat.usage.completion_tokens_details.reasoning_tokens,5);assert.equal(chat.usage.total_tokens,120);
 const chats=await streamObjects(renderChatStream);assert.deepEqual(chats.filter(x=>x.usage).at(-1).usage,chat.usage);
 const response=await renderResponsesResponse(events,'test');assert.equal(response.usage.input_tokens_details.cache_write_tokens,10);
 const responses=await streamObjects(renderResponsesStream);assert.deepEqual(responses.find(x=>x.type==='response.completed').response.usage,response.usage);
 const message=await renderMessagesResponse(events,'test');assert.deepEqual(message.usage,{input_tokens:30,output_tokens:20,cache_read_input_tokens:60,cache_creation_input_tokens:10});
 const messages=await streamObjects(renderMessagesStream);assert.deepEqual(messages.find(x=>x.type==='message_delta').usage,message.usage);
});
test('unknown cache stays absent while explicit zero survives; partial details merge',async()=>{
 const unknown=await renderChatResponse([{type:'usage',usage:parseUsage({prompt_tokens:1})}],'test');assert.equal(unknown.usage.prompt_tokens_details,undefined);assert.equal(unknown.usage.completion_tokens,undefined);
 assert.equal(parseUsage({prompt_tokens_details:{cached_tokens:0}}).cacheReadTokens,0);
 assert.equal(parseUsage({prompt_tokens:-1}).inputTokens,undefined);
 assert.deepEqual(mergeUsage({inputDetails:{cached_tokens:10}},{inputDetails:{audio_tokens:2}}).inputDetails,{cached_tokens:10,audio_tokens:2});
});
