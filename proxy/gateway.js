import {timingSafeEqual} from 'node:crypto';
import {once} from 'node:events';
import {relayResult} from './shared/relay.js';
import {retryableRouteError} from './shared/router.js';
import {RequestTrace} from './shared/request-records.js';
import {protocolFor} from './shared/contracts.js';
import {normalizeEffort} from './shared/llm/index.js';
import {renderChatStream,renderChatResponse} from './shared/protocols/openai-chat.js';
import {renderResponsesStream,renderResponsesResponse} from './shared/protocols/openai-responses.js';
import {renderMessagesStream,renderMessagesResponse} from './shared/protocols/anthropic-messages.js';
import {renderModelList} from './shared/protocols/models-list.js';
export const equalSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function send(res, code, value) {
  if (res.destroyed) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
export async function readBody(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 4_000_000) throw Object.assign(new Error('请求超过 4 MB'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
  catch { throw Object.assign(new Error('请求必须是有效 JSON'), { status: 400 }); }
}
export const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const adapters = {
  '/chat/completions': [ renderChatStream, renderChatResponse],
  '/responses': [ renderResponsesStream, renderResponsesResponse],
  '/messages': [ renderMessagesStream, renderMessagesResponse],
};
const errorStatus = code => code === '429' ? 429 : ['10605', '503'].includes(code) ? 503 : ['model_not_found', 'invalid_request'].includes(code) ? 400 : 502;

export function createGateway({getSettings,router,registry,sourceState,records,active,finishing}) {
  const providers=registry.providers;
  return async function gateway(req, res) {
    const settings=getSettings();
    res.setHeader('Cache-Control', 'no-store');
    const expected = `127.0.0.1:${settings.port}`;
    if (req.headers.host !== expected || req.headers.origin) return send(res, 403, { error: { message: '仅允许本机客户端访问' } });
    const key = req.headers.authorization?.replace(/^Bearer /, '') || req.headers['x-api-key'];
    if (!equalSecret(key, settings.apiKey)) return send(res, 401, { error: { message: 'API Key 无效', type: 'authentication_error' } });
    const route = new URL(req.url, `http://${expected}`).pathname.replace(/^\/api\/qoder(?=\/v1\/)/, '').replace(/^\/v1/, '');
    const controller = new AbortController();
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(() => deadline.abort(), 300_000);
    let model = '', sourceId, routedProvider, code = 200;
    const trace = req.method === 'POST' && protocolFor(route) ? new RequestTrace(route) : null;
    const observe = info => {
      if (info.stage === 'upstream' && sourceId) info = { ...info, sourceRevision: sourceState.revision(sourceId, routedProvider) };
      trace.observe(info);
    };
    const completion = Promise.withResolvers();
    active.add(controller); finishing.add(completion.promise);
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    req.on('error', disconnected); res.on('error', disconnected); res.on('close', disconnected);
    try {
      if (route === '/models' && req.method === 'GET') return send(res, 200, renderModelList(await router.listModels()));
      const adapter = adapters[route];
      if (!adapter || req.method !== 'POST') return send(res, 404, { error: { message: '接口不存在' } });
      const body = await readBody(req);
      if (!body || typeof body.model !== 'string' || !body.model.trim() || body.model.length > 200) fail('需要有效的 model');
      model = body.model;
      observe({ model, streaming: body.stream === true });
      if (body.stream !== undefined && typeof body.stream !== 'boolean') fail('stream 必须为布尔值');
      if (route !== '/responses' && !Array.isArray(body.messages)) fail('messages 必须为数组');
      if (route === '/responses' && typeof body.input !== 'string' && !Array.isArray(body.input)) fail('input 必须为文本或数组');
      const effort = body.reasoning_effort ?? body.reasoning?.effort ?? body.output_config?.effort;
      if (effort !== undefined && (typeof effort !== 'string' || !normalizeEffort(effort))) fail('推理强度无效');
      observe({ stage: 'routing' });
      const conversationId=req.headers['x-daylight-conversation-id'];
      if(conversationId!==undefined&&(typeof conversationId!=='string'||!conversationId.trim()||conversationId.length>200))fail('对话标识需为 1–200 个字符');
      const stateful=!!(body.previous_response_id || body.conversation);
      const candidates=await router.candidates({model},{conversationId,stateful});
      let iterator, firstStep, output;
      for(const [index,routed] of candidates.entries()) {
        sourceId=routed.provider;routedProvider=providers[sourceId];
        observe({provider:sourceId,sourceRevision:sourceState.revision(sourceId,routedProvider),upstreamModel:routed.upstreamId || routed.id});
        let accepted=false;
        try {
          observe({stage:'conversion'});
          output=await registry.execute(sourceId,{raw:body,protocol:protocolFor(route),model:routed,conversationId,stateful},{signal:AbortSignal.any([controller.signal,deadline.signal]),observe,conversationId:sourceId.startsWith('custom:')?conversationId:undefined});
          if(output.kind==='response'){
            clearTimeout(deadlineTimer);
            await relayResult(output,body,protocolFor(route),res,controller.signal,observe,{onAccepted:()=>{accepted=true;}});
            router.success(routed,conversationId);return;
          }
          observe({execution:'adapted'});
          if(output.headerTimeoutOnly)clearTimeout(deadlineTimer);
          iterator=output.events[Symbol.asyncIterator]();
          firstStep=await iterator.next();
          if(firstStep.value?.type==='error' && index<candidates.length-1 && !stateful && retryableRouteError(firstStep.value)) {
            observe({provider:sourceId,routeFailure:firstStep.value});router.failed(routed);await iterator.return?.();continue;
          }
          if(firstStep.value?.type!=='error')router.success(routed,conversationId);
          break;
        } catch(error) {
          await iterator?.return?.();iterator=undefined;
          if(accepted || res.headersSent || stateful || controller.signal.aborted || index===candidates.length-1 || !retryableRouteError(error))throw error;
          observe({provider:sourceId,routeFailure:error});router.failed(routed);
        }
      }
      async function* observed() {
        try {
          for (;;) {
            const step = firstStep || await iterator.next(); firstStep=undefined; if (step.done) return;
            const event = step.value;
            trace.event(event);
            if (event.type === 'error') code = errorStatus(event.code);
            yield event;
          }
        } finally { await iterator.return?.(); }
      }
      const events = observed(), first = await events.next();
      const renderStream = output.renderers?.[protocolFor(route)]?.[0] || adapter[0];
      const renderResponse = output.renderers?.[protocolFor(route)]?.[1] || adapter[1];
      if (first.value?.type === 'error') { await events.return(); return send(res, code, { error: { message: first.value.message, code: first.value.code, param: first.value.param, type: first.value.code === 'invalid_request' ? 'invalid_request_error' : 'upstream_error' } }); }
      async function* replay() { try { if (!first.done) yield first.value; yield* events; } finally { await events.return(); } }
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        for await (const chunk of renderStream(replay(), model)) {
          controller.signal.throwIfAborted();
          if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
        }
        res.end();
      } else send(res, 200, await renderResponse(replay(), model));
    } catch (error) {
      if (trace) trace.fail(error, controller.signal.aborted ? 'cancelled' : deadline.signal.aborted || error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : 'failed');
      code = controller.signal.aborted ? 499 : error.status || (error.code ? errorStatus(error.code) : 502);
      const message = error.status ? error.message : controller.signal.aborted ? '请求已取消' : '代理请求失败，请检查账号与网络后重试';
      try {
        if (!res.headersSent) send(res, code, { error: { message, type: 'proxy_error' } });
        else if (!res.destroyed) { res.write(`event: error\ndata: ${JSON.stringify({ error: { message, type: 'proxy_error' } })}\n\n`); res.end(); }
      } catch { /* the client already closed the socket */ }
    } finally {
      clearTimeout(deadlineTimer);
      active.delete(controller); res.off('close', disconnected);
      try {
        if (trace) {
          if (controller.signal.aborted) trace.entry.outcome = 'cancelled';
          await records.append(trace.finish(code, res.headersSent ? res.statusCode : undefined));
        }
      } finally { finishing.delete(completion.promise); completion.resolve(); }
    }
  }
}
