import {once} from 'node:events';
import {events,observeResponse} from './protocol.js';
import {renderChatStream,renderChatResponse} from '../qoder/providers/openai-chat.js';
import {renderResponsesStream,renderResponsesResponse} from '../qoder/providers/openai-responses.js';
import {renderMessagesStream,renderMessagesResponse} from '../qoder/providers/anthropic-messages.js';
const renderers={chat:[renderChatStream,renderChatResponse],responses:[renderResponsesStream,renderResponsesResponse],messages:[renderMessagesStream,renderMessagesResponse]};
export async function relay(provider,raw,protocol,res,signal,observe){
 const timeout=new AbortController();const timer=setTimeout(()=>timeout.abort(),300000);let result;
 try{result=await provider.forward(raw,protocol,{signal:AbortSignal.any([signal,timeout.signal]),observe});}catch(error){if(timeout.signal.aborted)observe({error:{name:'TimeoutError'}});throw error;}finally{clearTimeout(timer);}
 const {response,model,upstreamModel,requestedTier}=result;observe({upstreamModel,requestedTier,upstreamStatus:response.status,upstreamProtocol:result.protocol,execution:protocol===result.protocol?'native':'converted',stage:'response'});
 if(!response.ok){await response.body?.cancel();throw Object.assign(new Error(`上游请求失败（${response.status}）`),{status:response.status>=400&&response.status<600?response.status:502});}
 const json=v=>{res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(v));};
 const native=protocol===result.protocol;
 if(!result.streaming&&!response.headers.get('content-type')?.includes('text/event-stream')){
  if(!native||raw.stream){await response.body?.cancel();throw new Error('上游未按请求返回流式响应');}
  const body=await response.json();observeResponse(body,protocol,observe);
  if(body.error||body.status==='failed')observe({error:{code:body.error?.code}});
  else observe({finish:body.status==='incomplete'||body.choices?.[0]?.finish_reason==='length'||body.stop_reason==='max_tokens'?'length':'stop'});
  if(body.model)body.model=model;json(body);return;
 }
 const stream=events(response,result.protocol,model,observe);
 if(native){
  if(raw.stream){res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});
   for await(const e of stream)if(e.type==='native'){const chunk=(protocol==='chat'?'':`event: ${e.name}\n`)+`data: ${JSON.stringify(e.event)}\n\n`;if(!res.write(chunk))await once(res,'drain',{signal});}
   if(protocol==='chat')res.write('data: [DONE]\n\n');res.end();
  }else if(protocol==='responses'){let completed;for await(const e of stream)if(e.type==='native'&&['response.completed','response.incomplete'].includes(e.event.type))completed=e.event.response;if(!completed)throw new Error('未收到完整响应');json(completed);
  }else{json(await renderers[protocol][1](stream,model));}
 }else if(raw.stream){res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store'});for await(const chunk of renderers[protocol][0](stream,model))if(!res.write(chunk))await once(res,'drain',{signal});res.end();}
 else json(await renderers[protocol][1](stream,model));
}
