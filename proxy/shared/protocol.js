import {outputBudget,reasoningEffort} from './request-parameters.js';
import {decodeChatRequest} from './protocols/openai-chat.js';
import {decodeMessagesRequest} from './protocols/anthropic-messages.js';
import {decodeResponsesRequest} from './protocols/openai-responses.js';
import {SseParser} from './llm/sse.js';
import {parseUsage,mergeUsage} from './llm/usage.js';
import {toolTurns} from './tool-turns.js';
import {upstreamError} from './upstream-error.js';
export const invalid=(message,param)=>Object.assign(new Error(message),{status:400,code:'invalid_request',param});
const decoders={chat:decodeChatRequest,messages:decodeMessagesRequest,responses:decodeResponsesRequest};
// Decode only when an event adapter needs canonical messages; native relays retain raw fields.
export function decodeRequest(raw,protocol){
 try{return {...decoders[protocol](protocol==='responses'?normalizeResponsesHints(raw):raw),raw};}
 catch{throw invalid('请求格式不正确，请检查消息与工具字段');}
}
const allowed={chat:'model messages tools tool_choice stream stream_options max_tokens max_completion_tokens reasoning_effort service_tier parallel_tool_calls store',responses:'model input instructions tools tool_choice stream max_output_tokens reasoning service_tier parallel_tool_calls store',messages:'model messages system tools tool_choice stream max_tokens thinking output_config'};
function normalizeResponsesHints(raw){
  raw=structuredClone(raw);
  // These are optional output/cache hints, not resumable upstream state.
  if(raw.prompt_cache_key!==undefined){if(raw.prompt_cache_key!==null&&typeof raw.prompt_cache_key!=='string')throw invalid('prompt_cache_key 需为字符串');delete raw.prompt_cache_key;}
  if(raw.include!==undefined){if(!Array.isArray(raw.include)||raw.include.some(v=>v!=='reasoning.encrypted_content'))throw invalid('跨协议仅支持默认推理输出提示');delete raw.include;}
  if(raw.reasoning?.summary==='auto'){delete raw.reasoning.summary;}
  // Daylight's translated summaries are display text, never opaque reasoning state.
  if(Array.isArray(raw.input))raw.input=raw.input.filter(item=>!(item.type==='reasoning'&&item.id?.startsWith('rs_daylight-')&&!Object.hasOwn(item,'encrypted_content')&&Object.keys(item).every(k=>['type','id','summary'].includes(k))&&Array.isArray(item.summary)&&item.summary.every(p=>p.type==='summary_text'&&typeof p.text==='string')));
 return raw;
}
export function convertRequest(raw,from,to){
 if(from===to)return structuredClone(raw);
 if(from==='responses')raw=normalizeResponsesHints(raw);
 for(const k of Object.keys(raw))if(!allowed[from].split(' ').includes(k))throw invalid(`跨协议暂不支持 ${k}，请使用上游原生协议`,k);
 if(raw.store===true)throw invalid('跨协议不支持 store=true');
 if(raw.service_tier!==undefined&&to==='messages')throw invalid('Messages 无法转换 service_tier');
 const inspect=v=>{if(!v||typeof v!=='object')return;if(v.cache_control||v.signature||v.type==='reasoning'||v.type==='redacted_thinking')throw invalid('此内容需使用上游原生协议');for(const [k,x]of Object.entries(v))if(!['parameters','input_schema'].includes(k))inspect(x);};inspect(raw);
 if(raw.tools?.some(t=>from==='messages'?t.type&&t.type!=='custom':t.type!=='function'))throw invalid('跨协议仅支持函数工具');
 if(raw.tools?.some(t=>t.strict!==undefined&&t.strict!==false||t.function?.strict!==undefined&&t.function.strict!==false))throw invalid('strict 工具请使用上游原生协议');
 const seq=from==='responses'?raw.input:raw.messages;
 if(Array.isArray(seq)){
  let started=false;for(const m of seq){if(['system','developer'].includes(m.role)){if(started)throw invalid('中途插入系统消息请使用原生协议');}else started=true;
   const content=m.content;if(Array.isArray(content)&&content.some(b=>!['text','input_text','output_text','image','image_url','input_image','tool_use','tool_result'].includes(b.type)))throw invalid('无法跨协议转换该内容块');
  }
 }
 if(raw.reasoning&&Object.keys(raw.reasoning).some(k=>k!=='effort'))throw invalid('跨协议只支持 reasoning.effort');
 if(raw.output_config&&Object.keys(raw.output_config).some(k=>k!=='effort'))throw invalid('该 output_config 需使用原生协议');
 if(Array.isArray(seq)&&seq.some(m=>m.reasoning_content||Array.isArray(m.content)&&m.content.some(b=>b.type==='tool_result')&&m.content.some(b=>b.type!=='tool_result')))throw invalid('混合工具结果或推理历史需使用原生协议');
 const c=decoders[from](raw),out={model:raw.model,stream:true};
 const param=from==='responses'?'input':'messages',turns=toolTurns(c.messages,param);
 const max=outputBudget(raw);
 const effort=reasoningEffort(raw);
 if(raw.thinking&&raw.thinking.type!=='adaptive')throw invalid('手动 thinking 预算请使用原生协议');
 const texts=x=>typeof x==='string'?[{type:'text',text:x}]:x||[];
 const image=(url,target)=>{if(target==='messages'){const m=/^data:([^;]+);base64,(.*)$/s.exec(url);return{type:'image',source:m?{type:'base64',media_type:m[1],data:m[2]}:{type:'url',url}};}return target==='chat'?{type:'image_url',image_url:{url}}:{type:'input_image',image_url:url};};
 const content=(x,role)=>texts(x).map(p=>p.type==='image'?image(p.url,to):{type:to==='responses'?(role==='assistant'?'output_text':'input_text'):'text',text:p.text}).filter(p=>['image','image_url','input_image'].includes(p.type)||typeof p.text==='string'&&p.text.length>0);
 // Chat-completions upstreams expect assistant history as a plain string; block arrays leak into replies.
 const chatContent=(x,role)=>{const parts=content(x,role);if(parts.every(p=>p.type==='text'))return parts.map(p=>p.text).join('');return parts;};
 // Tool results follow each protocol's wire shape: Chat is text-only (images move to their own user
 // turn), Messages keeps native image blocks inside tool_result, Responses uses input_* part arrays.
 const toolParts=x=>texts(x),toolImages=x=>toolParts(x).filter(p=>p.type==='image'&&p.url);
 const toolText=x=>{const parts=toolParts(x),text=parts.filter(p=>p.type==='text'&&p.text).map(p=>p.text).join('\n');return text||(toolImages(x).length?'(see attached image)':'(no tool output)');};
 const toolOutput=x=>{const images=toolImages(x),text=toolText(x);return images.length?[{type:'input_text',text},...images.map(p=>({type:'input_image',detail:'auto',image_url:p.url}))]:text;};
 const imageTurn=results=>{
  const parts=results.flatMap(m=>{const images=toolImages(m.content);return images.length?[{type:'text',text:`Images from tool call ${m.toolCallId}:`},...images.map(p=>image(p.url,'chat'))]:[];});
  return parts.length?[{role:'user',content:parts}]:[];
 };
 const toolResultBlocks=x=>{const blocks=toolParts(x).map(p=>p.type==='image'?image(p.url,'messages'):{type:'text',text:p.text}).filter(b=>b.type==='image'||b.text);return blocks.length?blocks:[{type:'text',text:toolText(x)}];};
 if(to==='responses'){
  if(c.system)out.instructions=c.system;
  out.input=c.messages.flatMap(m=>m.role==='tool'?[{type:'function_call_output',call_id:m.toolCallId,output:toolOutput(m.content)}]:[...(texts(m.content).length?[{role:m.role,content:content(m.content,m.role)}]:[]),...(m.toolCalls||[]).map(t=>({type:'function_call',call_id:t.id,name:t.name,arguments:t.arguments}))]);
  if(max!==undefined)out.max_output_tokens=max;if(effort)out.reasoning={effort};
 }else if(to==='chat'){
  // Chat upstreams usually omit final counters unless explicitly requested.
  out.stream_options={include_usage:true};
  out.messages=[...(c.system?[{role:'system',content:c.system}]:[]),...turns.flatMap(({message:m,results})=>[
   {role:m.role,content:m.role==='assistant'?chatContent(m.content,m.role):content(m.content,m.role),...(m.toolCalls?.length?{tool_calls:m.toolCalls.map(t=>({id:t.id,type:'function',function:{name:t.name,arguments:t.arguments}}))}:{})},
   ...results.map(r=>({role:'tool',tool_call_id:r.toolCallId,content:toolText(r.content)})),...imageTurn(results),
  ])];
  if(max!==undefined)out.max_tokens=max;if(effort)out.reasoning_effort=effort;
 }else{
  if(max===undefined)throw invalid('转换为 Messages 需要显式 max_tokens 或模型默认输出预算');
  out.max_tokens=max;if(c.system)out.system=c.system;
  out.messages=turns.flatMap(({message:m,results})=>[
   {role:m.role,content:[...content(m.content,m.role),...(m.toolCalls||[]).map(t=>({type:'tool_use',id:t.id,name:t.name,input:JSON.parse(t.arguments)}))]},
   ...(results.length?[{role:'user',content:results.map(r=>({type:'tool_result',tool_use_id:r.toolCallId,content:toolResultBlocks(r.content)}))}]:[]),
  ]);
  if(effort){out.thinking={type:'adaptive'};out.output_config={effort};}
 }
 if(c.tools)out.tools=c.tools.map(t=>{const {name,description}=t;
  const parameters=t.parameters||{type:'object',properties:{}};
  return to==='messages'?{name,description,input_schema:parameters}:to==='chat'?{type:'function',function:{name,description,parameters}}:{type:'function',name,description,parameters};});
 if(raw.tool_choice!==undefined){const t=raw.tool_choice;const name=t?.function?.name??t?.name;const kind=typeof t==='string'?t:t?.type;
  if(to==='messages')out.tool_choice=name?{type:'tool',name}:{type:kind==='required'?'any':kind};
  else out.tool_choice=name?(to==='chat'?{type:'function',function:{name}}:{type:'function',name}):kind==='any'?'required':kind;
 }
 if(raw.parallel_tool_calls!==undefined){if(to==='messages')out.tool_choice={...(out.tool_choice||{type:'auto'}),disable_parallel_tool_use:!raw.parallel_tool_calls};else out.parallel_tool_calls=raw.parallel_tool_calls;}
 if(raw.tool_choice?.disable_parallel_tool_use!==undefined&&to!=='messages')out.parallel_tool_calls=!raw.tool_choice.disable_parallel_tool_use;
 if(raw.service_tier!==undefined)out.service_tier=raw.service_tier;
 // Re-decode the generated wire shape to catch any converter that breaks batch structure.
 toolTurns(decoders[to](out).messages,to==='responses'?'input':'messages');
 return out;
}
export function usageOf(u,protocol){
 if(!u)return;
 if(protocol==='chat')return parseUsage(u);
 if(protocol==='responses')return{inputTokens:u.input_tokens,outputTokens:u.output_tokens,totalTokens:u.total_tokens,cacheReadTokens:u.input_tokens_details?.cached_tokens,outputDetails:u.output_tokens_details,costUsdTicks:u.cost_in_usd_ticks,...(u.estimated?{estimated:true}:{})};
 return{inputTokens:u.input_tokens===undefined?undefined:u.input_tokens+(u.cache_read_input_tokens||0)+(u.cache_creation_input_tokens||0),outputTokens:u.output_tokens,cacheReadTokens:u.cache_read_input_tokens,cacheWriteTokens:u.cache_creation_input_tokens,...(u.output_tokens_details?{outputDetails:{...u.output_tokens_details,...(u.output_tokens_details.thinking_tokens!==undefined?{reasoning_tokens:u.output_tokens_details.thinking_tokens}:{})}}:{})};
}
export function observeResponse(body, protocol, observe) {
 const response=body.response||body.message||body;
 observe({reportedModel:response.model,actualTier:response.service_tier,usage:usageOf(response.usage,protocol)});
 const choice=body.choices?.[0],parts=response.content||response.output,blocks=Array.isArray(parts)?parts:[];
 const tools=choice?.delta?.tool_calls||choice?.message?.tool_calls||[];
 const toolCall=tools.length>0||blocks.some(b=>b?.type==='function_call'||b?.type==='tool_use')||body.type==='response.function_call_arguments.delta'||body.item?.type==='function_call'||body.content_block?.type==='tool_use';
 const content=!!(choice?.delta?.content||choice?.delta?.reasoning_content||choice?.message?.content||body.delta?.text||body.delta?.thinking||typeof body.delta==='string'&&body.delta||toolCall||blocks.some(b=>b?.text||Array.isArray(b?.content)&&b.content.some(c=>c?.text)));
 observe({content,toolCall});
}

export function readWithIdle(reader,ms,message){
 let timer;const idle=new Promise((_,reject)=>{timer=setTimeout(()=>{reject(Object.assign(new Error(message),{code:'idle_timeout'}));void reader.cancel().catch(()=>{});},ms);});
 idle.catch(()=>{});const raced=Promise.race([reader.read(),idle]).finally(()=>clearTimeout(timer));raced.catch(()=>{});raced.cancel=()=>clearTimeout(timer);return raced;
}
export async function* events(response,protocol,model,observe=()=>{}){
 const reader=response.body.getReader(),decoder=new TextDecoder(),parser=new SseParser();let terminal=false,usage,finish='stop',read;const toolArgs=new Map(),outputItems=new Map(),thoughtSignatures=new Map();
 try{while(true){read=readWithIdle(reader,300000,'上游响应空闲超时');const part=await read;
  for(const f of part.done?parser.flush():parser.push(decoder.decode(part.value,{stream:true}))){if(!f.data)continue;if(f.data==='[DONE]'){terminal=true;continue;}if(f.data.length>4000000)throw new Error('上游事件过大');const e=JSON.parse(f.data);
   if(e.error||e.type==='error'||e.type==='response.failed'){const error=upstreamError(e,502,response.headers);observe({error});throw error;}
   observeResponse(e,protocol,observe);
   if(e.model)e.model=model;if(e.response?.model)e.response.model=model;if(e.message?.model)e.message.model=model;
   const u=usageOf(e.usage||e.response?.usage||e.message?.usage,protocol);if(u)usage=mergeUsage(usage,u);
   const tier=e.service_tier??e.response?.service_tier;if(tier)observe({actualTier:tier});
   if(protocol==='responses'){
    if(e.type==='response.output_item.done')outputItems.set(e.output_index,e.item);
    if(['response.completed','response.incomplete'].includes(e.type)&&e.response&&(!e.response.output?.length)&&outputItems.size)e.response.output=[...outputItems.entries()].sort((a,b)=>a[0]-b[0]).map(([,item])=>item);
   }
   yield{type:'native',event:e,name:f.event||e.type};
   if(protocol==='chat'){
    const c=e.choices?.[0];if(c?.delta?.content)yield{type:'text',delta:c.delta.content};const thought=c?.delta?.reasoning_content??c?.delta?.reasoning;if(thought)yield{type:'reasoning',delta:thought};
    for(const t of c?.delta?.tool_calls||[])yield{type:'tool_call',index:t.index,id:t.id,name:t.function?.name,argumentsDelta:t.function?.arguments||''};
    if(c?.finish_reason)finish=c.finish_reason;
   }else if(protocol==='messages'){
    if(e.type==='content_block_start'){
     if(e.content_block.type==='text'&&e.content_block.text)yield{type:'text',delta:e.content_block.text};
     if(e.content_block.type==='thinking'&&e.content_block.thinking)yield{type:'reasoning',delta:e.content_block.thinking};
     if(e.content_block.type==='thinking'&&e.content_block.signature)thoughtSignatures.set(e.index,e.content_block.signature);
    }
    if(e.type==='content_block_start'&&e.content_block.type==='tool_use')yield{type:'tool_call',index:e.index,id:e.content_block.id,name:e.content_block.name,argumentsDelta:Object.keys(e.content_block.input||{}).length?JSON.stringify(e.content_block.input):''};
    if(e.delta?.type==='text_delta')yield{type:'text',delta:e.delta.text};if(e.delta?.type==='thinking_delta')yield{type:'reasoning',delta:e.delta.thinking};if(e.delta?.type==='input_json_delta')yield{type:'tool_call',index:e.index,argumentsDelta:e.delta.partial_json};
    if(e.delta?.type==='signature_delta')thoughtSignatures.set(e.index,(thoughtSignatures.get(e.index)||'')+e.delta.signature);
    if(e.type==='content_block_stop'&&thoughtSignatures.has(e.index)){yield{type:'reasoning_signature',signature:thoughtSignatures.get(e.index)};thoughtSignatures.delete(e.index);}
    if(e.delta?.stop_reason)finish=e.delta.stop_reason==='tool_use'?'tool_calls':e.delta.stop_reason==='max_tokens'?'length':'stop';if(e.type==='message_stop')terminal=true;
   }else{
    if(e.type==='response.output_text.delta')yield{type:'text',delta:e.delta};if(['response.reasoning_summary_text.delta','response.reasoning_text.delta'].includes(e.type))yield{type:'reasoning',delta:e.delta};
    if(e.type==='response.output_item.added'&&e.item.type==='function_call'){toolArgs.set(e.output_index,!!e.item.arguments);yield{type:'tool_call',index:e.output_index,id:e.item.call_id,name:e.item.name,argumentsDelta:e.item.arguments||''};finish='tool_calls';}
    if(e.type==='response.function_call_arguments.delta'){toolArgs.set(e.output_index,true);yield{type:'tool_call',index:e.output_index,argumentsDelta:e.delta};}
    if(e.type==='response.output_item.done'&&e.item.type==='function_call'&&!toolArgs.get(e.output_index)){yield{type:'tool_call',index:e.output_index,id:e.item.call_id,name:e.item.name,argumentsDelta:e.item.arguments||''};finish='tool_calls';}
    if(['response.completed','response.incomplete'].includes(e.type)){terminal=true;if(e.type==='response.incomplete')finish='length';}
   }
   if(u)yield{type:'usage',usage};
  }
  if(terminal||part.done)break;
 }
 if(!terminal){observe({error:{code:'incomplete_stream'}});throw new Error('上游连接提前结束');}observe({finish});yield{type:'finish',reason:finish};
 }finally{read?.cancel();await reader.cancel().catch(()=>{});reader.releaseLock();}
}
