import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeChatRequest } from '../proxy/shared/protocols/openai-chat.js';
import { decodeResponsesRequest } from '../proxy/shared/protocols/openai-responses.js';
import { convertRequest } from '../proxy/shared/protocol.js';
import { compileNativeBody } from '../proxy/qoder/protocol.js';

const messages = [
  { role: 'system', content: 'System instructions' },
  { role: 'developer', content: [{ type: 'text', text: '开发者规则' }, { type: 'text', text: 'Second rule' }] },
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: 'Hi' },
];
const instructions = 'System instructions\n\n开发者规则\nSecond rule';

// Qoder/DeepSeek accepts canonical system instructions, not OpenAI's developer role.
// This must hold for the protocol boundary, independently of the selected model.
test('Chat and Responses normalize instruction roles to the same canonical request', () => {
  const chat = decodeChatRequest({ model: 'any-model', messages });
  const responses = decodeResponsesRequest({ model: 'any-model', input: messages });
  for (const request of [chat, responses]) {
    assert.equal(request.system, instructions);
    assert.deepEqual(request.messages.map(m => m.role), ['user', 'assistant']);
  }
  assert.deepEqual(responses.messages, chat.messages);
  assert.equal(responses.conversationId, chat.conversationId);
});

test('Responses combines top-level instructions and message instruction blocks without losing tools', () => {
  const request = decodeResponsesRequest({ model: 'any-model', instructions: 'Top-level rules', input: [
    ...messages,
    { type: 'function_call', call_id: 'call_1', name: 'echo', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'OK' },
  ] });
  assert.equal(request.system, `Top-level rules\n\n${instructions}`);
  assert.deepEqual(request.messages.map(m => m.role), ['user', 'assistant', 'assistant', 'tool']);
  assert.equal(request.messages[2].toolCalls[0].id, 'call_1');
  assert.equal(request.messages[3].toolCallId, 'call_1');
});

test('Responses instructions survive conversion to Chat and Messages', () => {
  const raw = { model: 'any-model', input: messages, max_output_tokens: 32 };
  const chat = convertRequest(raw, 'responses', 'chat');
  const anthropic = convertRequest(raw, 'responses', 'messages');
  assert.deepEqual(chat.messages[0], { role: 'system', content: instructions });
  assert.equal(anthropic.system, instructions);
  assert.deepEqual(anthropic.messages.map(m => m.role), ['user', 'assistant']);
  assert.deepEqual(raw.input, messages);
});

test('Qoder receives canonical instructions, never a developer role from Responses', () => {
  const request = decodeResponsesRequest({ model: 'dfmodel', input: messages });
  const native = compileNativeBody(request, {
    model: { id: 'dfmodel', isReasoning: true, isVL: true },
    session: { sessionId: 'session', requestSetId: 'set', businessId: 'business', stage: 1 },
    clientVersion: 'test',
  });
  assert.equal(native.system, instructions);
  assert.deepEqual(native.messages.map(m => m.role), ['user', 'assistant']);
});

test('Responses parallel calls remain one assistant turn across Qoder, Chat and Messages', () => {
  const raw = { model: 'dfmodel', max_output_tokens: 64, input: [
    { role: 'user', content: 'Run both tools' },
    { type: 'function_call', call_id: 'call_a', name: 'echo', arguments: '{"value":"A"}' },
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Display summary' }], id: 'rs_daylight-test' },
    { type: 'function_call', call_id: 'call_b', name: 'echo', arguments: '{"value":"B"}' },
    { type: 'function_call_output', call_id: 'call_b', output: 'B' },
    { type: 'function_call_output', call_id: 'call_a', output: 'A' },
    { role: 'user', content: 'Continue' },
    { type: 'function_call', call_id: 'call_c', name: 'echo', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_c', output: 'C' },
  ] };
  const before = structuredClone(raw);
  const request = decodeResponsesRequest(raw);
  assert.deepEqual(request.messages.map(m => m.role), ['user', 'assistant', 'tool', 'tool', 'user', 'assistant', 'tool']);
  assert.deepEqual(request.messages[1].toolCalls.map(t => t.id), ['call_a', 'call_b']);
  assert.deepEqual(request.messages[5].toolCalls.map(t => t.id), ['call_c']);
  const native = compileNativeBody(request, { model: { id: 'dfmodel' }, session: {}, clientVersion: 'test' });
  const chat = convertRequest(raw, 'responses', 'chat');
  for (const messages of [native.messages, chat.messages]) {
    assert.deepEqual(messages[1].tool_calls.map(t => t.id), ['call_a', 'call_b']);
    assert.deepEqual(messages.slice(2, 4).map(m => m.tool_call_id), ['call_b', 'call_a']);
  }
  const anthropic = convertRequest(raw, 'responses', 'messages');
  assert.deepEqual(anthropic.messages[1].content.filter(b => b.type === 'tool_use').map(b => b.id), ['call_a', 'call_b']);
  assert.deepEqual(raw, before);
});

test('Tool results with images survive conversion to Chat, Messages and Responses', () => {
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const raw = { model: 'any-model', max_output_tokens: 64, input: [
    { role: 'user', content: '看一下这张图' },
    { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"x.png"}' },
    { type: 'function_call_output', call_id: 'call_1', output: [
      { type: 'input_text', text: 'Read image file [image/png]' },
      { type: 'input_image', detail: 'auto', image_url: image },
    ] },
    { role: 'user', content: '继续' },
  ] };
  // Chat tool results are text-only; an image block breaks OpenAI-compatible relays.
  const chat = convertRequest(raw, 'responses', 'chat');
  const tool = chat.messages.find(m => m.role === 'tool');
  assert.equal(typeof tool.content, 'string');
  assert.equal(tool.content, 'Read image file [image/png]');
  assert.equal(tool.tool_call_id, 'call_1');
  // Chat moves tool-result images into their own user turn so vision still reaches the model.
  const assistantTurn = chat.messages.findIndex(m => m.role === 'assistant' && m.tool_calls);
  assert.equal(chat.messages[assistantTurn + 1].role, 'tool');
  assert.equal(chat.messages[assistantTurn + 2].role, 'user');
  assert.equal(chat.messages[assistantTurn + 2].content[1].type, 'image_url');
  assert.equal(chat.messages[assistantTurn + 2].content[1].image_url.url, image);
  // Messages tool results keep the image as a native content block.
  const anthropic = convertRequest(raw, 'responses', 'messages');
  const result = anthropic.messages.find(m => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result');
  assert.deepEqual(result.content[0].content.map(b => b.type), ['text', 'image']);
  assert.equal(result.content[0].content[1].source.data, image.split(',')[1]);
  assert.deepEqual(raw.input[2].output[1].image_url, image);
});

test('Chat keeps assistant history as plain strings so models do not mirror block arrays', () => {
  const raw = { model: 'any-model', max_output_tokens: 32, input: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
    { role: 'user', content: 'go' },
  ] };
  const chat = convertRequest(raw, 'responses', 'chat');
  assert.equal(chat.messages[1].content, 'done');
  const history = convertRequest({ model: 'any-model', max_output_tokens: 32, input: [
    { role: 'user', content: '看一下这张图' },
    { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'Read image file [image/png]' },
    { role: 'user', content: '继续' },
  ] }, 'responses', 'chat');
  assert.deepEqual(history.messages.map(m => m.role), ['user', 'assistant', 'tool', 'user']);
  assert.equal(history.messages[1].content, '');
  assert.equal(typeof history.messages[1].content, 'string');
});

test('Function tools use each protocol wire shape in both directions', () => {
  const parameters = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
  const fromResponses = { model: 'any-model', max_output_tokens: 32, input: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', name: 'read', description: 'Read', parameters }] };
  assert.deepEqual(convertRequest(fromResponses, 'responses', 'chat').tools, [{ type: 'function', function: { name: 'read', description: 'Read', parameters } }]);
  assert.deepEqual(convertRequest(fromResponses, 'responses', 'messages').tools, [{ name: 'read', description: 'Read', input_schema: parameters }]);
  const fromChat = { model: 'any-model', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'read', description: 'Read', parameters } }] };
  assert.deepEqual(convertRequest(fromChat, 'chat', 'responses').tools, [{ type: 'function', name: 'read', description: 'Read', parameters }]);
  const fromMessages = { model: 'any-model', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'read', description: 'Read', input_schema: parameters }] };
  assert.deepEqual(convertRequest(fromMessages, 'messages', 'chat').tools, [{ type: 'function', function: { name: 'read', description: 'Read', parameters } }]);
});
