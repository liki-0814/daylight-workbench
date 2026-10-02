// Optional local Pi interoperability smoke; credentials and configuration stay in a temporary directory.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProxyService } from '../proxy/service.js';
import { CustomSources } from '../proxy/custom/provider.js';

const piRoot = process.argv[2];
if (!piRoot) throw new Error('Pass the installed pi-coding-agent package directory');
const { ModelRuntime } = await import(pathToFileURL(path.join(piRoot, 'dist/core/model-runtime.js')));
const { ModelConfig } = await import(pathToFileURL(path.join(piRoot, 'dist/core/model-config.js')));
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'daylight-pi-runtime-'));
const received = [];
const upstream = http.createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk;
  const body = JSON.parse(text); received.push(body);
  assert.equal(body.model, 'private'); assert.equal(body.reasoning_effort, 'high');
  const continued = body.messages.some(m => m.role === 'tool');
  const chunks = continued
    ? [{ reasoning_content: 'Completed reasoning.' }, { content: 'OK' }]
    : [{ reasoning_content: 'Call echo.' }, { tool_calls: [{ index: 0, id: 'call_echo', type: 'function', function: { name: 'echo', arguments: '{"text":"hello"}' } }] }];
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const delta of chunks) res.write('data: ' + JSON.stringify({ id: 'chat_smoke', model: 'private', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
  res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: continued ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 3 } }) + '\n\ndata: [DONE]\n\n');
});
let bridge, management;
try {
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const custom = new CustomSources({ dataDir, secrets: { get: async () => null } });
  await custom.save({ name: 'Local Pi smoke', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, protocol: 'chat', auth: 'none', models: [{ id: 'pi-smoke', upstreamId: 'private', isReasoning: true, contextWindow: 200000, maxOutputTokens: 32000 }] });
  bridge = await createProxyService({ dataDir, customSources: custom, provider: { listModels: async () => [] }, piOptions: { piDir: path.join(dataDir, 'pi'), getInfo: async () => ({ installed: true, version: 'local-smoke' }) } });
  management = http.createServer((req, res) => bridge.handle(req, res));
  management.listen(0, '127.0.0.1'); await once(management, 'listening');
  const base = 'http://127.0.0.1:' + management.address().port;
  const call = async (route, body) => {
    const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  await call('/api/qoder/settings', { port, autoStart: false }); await call('/api/qoder/service', { enabled: true });
  for (const [i, api] of ['openai-completions', 'openai-responses'].entries()) {
    const state = await call('/api/cli/pi/state?api=' + api);
    await call('/api/cli/pi/apply', { api, expectedVersion: state.version, requestId: 'smoke-' + i, modelOverrides:{'pi-smoke':{contextWindow:777777,maxTokens:32123,reasoning:true,thinkingLevelMap:{off:null,high:'high',max:'high'}}} });
    const config = await ModelConfig.load(path.join(dataDir, 'pi/models.json'));
    assert.equal(config.getError(), undefined); assert.equal(config.getProvider('daylight').models[0].api, api);
  }
  const runtime = await ModelRuntime.create({ modelsPath: path.join(dataDir, 'pi/models.json'), authPath: path.join(dataDir, 'pi/auth.json'), allowModelNetwork: false });
  const model = runtime.getModel('daylight', 'pi-smoke'); assert(model);
  assert.equal(model.contextWindow,777777);assert.equal(model.maxTokens,32123);assert.equal(model.thinkingLevelMap.max,'high');
  const thinkingModel = model;
  const tools = [{ name: 'echo', description: 'Echo text', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }];
  const user = { role: 'user', content: 'Echo hello', timestamp: Date.now() };
  const payloads = [];
  const options = { apiKey: (await call('/api/qoder/key')).apiKey, reasoning: 'max', sessionId: 'daylight-local-smoke', cacheRetention: 'short', maxTokens: 100, onPayload: payload => { payloads.push(structuredClone(payload)); } };
  const first = await runtime.streamSimple(thinkingModel, { messages: [user], tools }, options).result();
  assert.equal(first.stopReason, 'toolUse', JSON.stringify(first));
  const toolCall = first.content.find(part => part.type === 'toolCall'); assert.equal(toolCall.name, 'echo');
  assert(first.content.some(part => part.type === 'thinking'));
  const toolResult = { role: 'toolResult', toolCallId: toolCall.id, toolName: 'echo', content: [{ type: 'text', text: 'hello' }], isError: false, timestamp: Date.now() };
  const second = await runtime.streamSimple(thinkingModel, { messages: [user, first, toolResult], tools }, options).result();
  assert.equal(second.stopReason, 'stop', JSON.stringify({ second, payload: payloads.at(-1) })); assert.equal(second.content.find(part => part.type === 'text').text, 'OK');
  assert.equal(received.length, 2);
  console.log('Installed Pi PASS: generated config schemas, Responses streaming, thinking, tool call, tool-result continuation, session/cache hints');
} finally {
  await bridge?.close();
  if (management) { management.closeAllConnections(); await new Promise(resolve => management.close(resolve)); }
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}
