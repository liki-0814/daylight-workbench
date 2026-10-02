import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeChatRequest } from '../proxy/shared/protocols/openai-chat.js';
import { decodeResponsesRequest } from '../proxy/shared/protocols/openai-responses.js';
import { convertRequest } from '../proxy/shared/protocol.js';
import { compileNativeBody } from '../proxy/qoder/native-body.js';

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
