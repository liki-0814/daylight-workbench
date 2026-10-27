import {once} from 'node:events';
import {events,observeResponse,usageOf} from './protocol.js';
import {StreamingUsage,nativeStreamingUsage} from './llm/streaming-usage.js';
import {chatUsage,responsesUsage} from './llm/usage.js';
import {renderChatStream,renderChatResponse} from './protocols/openai-chat.js';
import {renderResponsesStream,renderResponsesResponse} from './protocols/openai-responses.js';
import {renderMessagesStream,renderMessagesResponse} from './protocols/anthropic-messages.js';
import {readUpstreamError,upstreamError} from './upstream-error.js';
const renderers={chat:[renderChatStream,renderChatResponse],responses:[renderResponsesStream,renderResponsesResponse],messages:[renderMessagesStream,renderMessagesResponse]};
export async function relayResult(result,raw,protocol,res,signal,observe,options={}){
 const {response,model,upstreamModel,requestedTier}=result;observe({upstreamModel,requestedTier,upstreamStatus:response.status,upstreamProtocol:result.protocol,execution:protocol===result.protocol?'native':'converted',stage:'response'});
 if(!response.ok)throw await readUpstreamError(response);
 options.onAccepted?.();
 const json=v=>{res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(v));};
 const native=protocol===result.protocol;
 if(!result.streaming&&!response.headers.get('content-type')?.includes('text/event-stream')){
  if(!native||raw.stream){await response.body?.cancel();throw new Error('上游未按请求返回流式响应');}
  const body=await response.json();observeResponse(body,protocol,observe);
  if(body.error||body.status==='failed'){const error=upstreamError(body,502,response.headers);observe({error});throw error;}
  else observe({finish:body.status==='incomplete'||body.choices?.[0]?.finish_reason==='length'||body.stop_reason==='max_tokens'?'length':'stop'});
  if(body.model)body.model=model;json(body);return;
 }
 async function* observedEvents(){for await(const event of events(response,result.protocol,model,observe)){options.onEvent?.(event);yield event;}}
 const stream=observedEvents();
 if(native){
  if(raw.stream){res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});
   const counter=new StreamingUsage(options);let finish;
   for await(const e of stream){if(e.type==='native'){
    const usage=nativeStreamingUsage(e.event,protocol,counter,usageOf(e.event.usage||e.event.response?.usage||e.event.message?.usage,protocol));
    const event=usage?{...e.event,usage:protocol==='chat'?chatUsage(usage):responsesUsage(usage)}:e.event;
    const chunk=(protocol==='chat'?'':`event: ${e.name}\n`)+`data: ${JSON.stringify(event)}\n\n`;if(!res.write(chunk))await once(res,'drain',{signal});}
    else if(e.type==='finish')finish=e.reason;
   }
   await counter.complete(finish);
   if(protocol==='chat')res.write('data: [DONE]\n\n');res.end();
  }else if(protocol==='responses'){let completed;for await(const e of stream)if(e.type==='native'&&['response.completed','response.incomplete'].includes(e.event.type))completed=e.event.response;if(!completed)throw new Error('未收到完整响应');json(completed);
  }else{json(await renderers[protocol][1](stream,model));}
 }else if(raw.stream){res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store'});for await(const chunk of renderers[protocol][0](stream,model,options))if(!res.write(chunk))await once(res,'drain',{signal});res.end();}
 else json(await renderers[protocol][1](stream,model));
}
