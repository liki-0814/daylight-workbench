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
