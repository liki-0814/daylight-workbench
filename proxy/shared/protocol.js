import {decodeChatRequest} from './protocols/openai-chat.js';
import {decodeMessagesRequest} from './protocols/anthropic-messages.js';
import {decodeResponsesRequest} from './protocols/openai-responses.js';
import {SseParser} from './llm/sse.js';
import {parseUsage,mergeUsage} from './llm/usage.js';
export const invalid=(message,param)=>Object.assign(new Error(message),{status:400,code:'invalid_request',param});
const decoders={chat:decodeChatRequest,messages:decodeMessagesRequest,responses:decodeResponsesRequest};
const allowed={chat:'model messages tools tool_choice stream stream_options max_tokens max_completion_tokens reasoning_effort service_tier parallel_tool_calls store',responses:'model input instructions tools tool_choice stream max_output_tokens reasoning service_tier parallel_tool_calls store',messages:'model messages system tools tool_choice stream max_tokens thinking output_config'};
export function convertRequest(raw,from,to){
 if(from===to)return structuredClone(raw);
 if(from==='responses'){
  raw=structuredClone(raw);
  // These are optional output/cache hints, not resumable upstream state.
  if(raw.prompt_cache_key!==undefined){if(raw.prompt_cache_key!==null&&typeof raw.prompt_cache_key!=='string')throw invalid('prompt_cache_key 需为字符串');delete raw.prompt_cache_key;}
  if(raw.include!==undefined){if(!Array.isArray(raw.include)||raw.include.some(v=>v!=='reasoning.encrypted_content'))throw invalid('跨协议仅支持默认推理输出提示');delete raw.include;}
  if(raw.reasoning?.summary==='auto'){delete raw.reasoning.summary;}
  // Daylight's translated summaries are display text, never opaque reasoning state.
  if(Array.isArray(raw.input))raw.input=raw.input.filter(item=>!(item.type==='reasoning'&&item.id?.startsWith('rs_daylight-')&&!Object.hasOwn(item,'encrypted_content')&&Object.keys(item).every(k=>['type','id','summary'].includes(k))&&Array.isArray(item.summary)&&item.summary.every(p=>p.type==='summary_text'&&typeof p.text==='string')));
 }
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
 const max=raw.max_output_tokens??raw.max_completion_tokens??raw.max_tokens;
 const effort=raw.reasoning_effort??raw.reasoning?.effort??raw.output_config?.effort;
 if(raw.thinking&&raw.thinking.type!=='adaptive')throw invalid('手动 thinking 预算请使用原生协议');
 const texts=x=>typeof x==='string'?[{type:'text',text:x}]:x||[];
 const image=(url,target)=>{if(target==='messages'){const m=/^data:([^;]+);base64,(.*)$/s.exec(url);return{type:'image',source:m?{type:'base64',media_type:m[1],data:m[2]}:{type:'url',url}};}return target==='chat'?{type:'image_url',image_url:{url}}:{type:'input_image',image_url:url};};
 const content=(x,role)=>texts(x).map(p=>p.type==='image'?image(p.url,to):{type:to==='responses'?(role==='assistant'?'output_text':'input_text'):'text',text:p.text});
 if(to==='responses'){
  if(c.system)out.instructions=c.system;
  out.input=c.messages.flatMap(m=>m.role==='tool'?[{type:'function_call_output',call_id:m.toolCallId,output:typeof m.content==='string'?m.content:JSON.stringify(m.content)}]:[...(texts(m.content).length?[{role:m.role,content:content(m.content,m.role)}]:[]),...(m.toolCalls||[]).map(t=>({type:'function_call',call_id:t.id,name:t.name,arguments:t.arguments}))]);
  if(max!==undefined)out.max_output_tokens=max;if(effort)out.reasoning={effort};
 }else if(to==='chat'){
  out.messages=[...(c.system?[{role:'system',content:c.system}]:[]),...c.messages.map(m=>m.role==='tool'?{role:'tool',tool_call_id:m.toolCallId,content:m.content}:{role:m.role,content:content(m.content,m.role),...(m.toolCalls?.length?{tool_calls:m.toolCalls.map(t=>({id:t.id,type:'function',function:{name:t.name,arguments:t.arguments}}))}:{})})];
  if(max!==undefined)out.max_tokens=max;if(effort)out.reasoning_effort=effort;
 }else{
  if(max===undefined)throw invalid('转换为 Messages 需要显式 max_tokens 或模型默认输出预算');
  out.max_tokens=max;if(c.system)out.system=c.system;
  out.messages=c.messages.map(m=>m.role==='tool'?{role:'user',content:[{type:'tool_result',tool_use_id:m.toolCallId,content:m.content}]}:{role:m.role,content:[...content(m.content,m.role),...(m.toolCalls||[]).map(t=>({type:'tool_use',id:t.id,name:t.name,input:JSON.parse(t.arguments)}))]});
  if(effort){out.thinking={type:'adaptive'};out.output_config={effort};}
 }
 if(c.tools)out.tools=c.tools.map(t=>to==='messages'?{name:t.name,description:t.description,input_schema:t.parameters}:to==='chat'?{type:'function',function:t}:{type:'function',...t});
 if(raw.tool_choice!==undefined){const t=raw.tool_choice;const name=t?.function?.name??t?.name;const kind=typeof t==='string'?t:t?.type;
  if(to==='messages')out.tool_choice=name?{type:'tool',name}:{type:kind==='required'?'any':kind};
  else out.tool_choice=name?(to==='chat'?{type:'function',function:{name}}:{type:'function',name}):kind==='any'?'required':kind;
 }
 if(raw.parallel_tool_calls!==undefined){if(to==='messages')out.tool_choice={...(out.tool_choice||{type:'auto'}),disable_parallel_tool_use:!raw.parallel_tool_calls};else out.parallel_tool_calls=raw.parallel_tool_calls;}
 if(raw.tool_choice?.disable_parallel_tool_use!==undefined&&to!=='messages')out.parallel_tool_calls=!raw.tool_choice.disable_parallel_tool_use;
 if(raw.service_tier!==undefined)out.service_tier=raw.service_tier;
 return out;
}
export function usageOf(u,protocol){
 if(!u)return;
 if(protocol==='chat')return parseUsage(u);
 if(protocol==='responses')return{inputTokens:u.input_tokens,outputTokens:u.output_tokens,totalTokens:u.total_tokens,cacheReadTokens:u.input_tokens_details?.cached_tokens,outputDetails:u.output_tokens_details,costUsdTicks:u.cost_in_usd_ticks};
 return{inputTokens:u.input_tokens===undefined?undefined:u.input_tokens+(u.cache_read_input_tokens||0)+(u.cache_creation_input_tokens||0),outputTokens:u.output_tokens,cacheReadTokens:u.cache_read_input_tokens,cacheWriteTokens:u.cache_creation_input_tokens};
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

export async function* events(response,protocol,model,observe=()=>{}){
 const reader=response.body.getReader(),decoder=new TextDecoder(),parser=new SseParser();let terminal=false,usage,finish='stop';const toolArgs=new Map(),outputItems=new Map();
 try{while(true){let timer;const part=await Promise.race([reader.read(),new Promise((_,reject)=>{timer=setTimeout(()=>{reject(Object.assign(new Error('上游响应空闲超时'),{code:'idle_timeout'}));void reader.cancel().catch(()=>{});},300000)})]).finally(()=>clearTimeout(timer));
  for(const f of part.done?parser.flush():parser.push(decoder.decode(part.value,{stream:true}))){if(!f.data)continue;if(f.data==='[DONE]'){terminal=true;continue;}if(f.data.length>4000000)throw new Error('上游事件过大');const e=JSON.parse(f.data);
   if(e.error||e.type==='error'||e.type==='response.failed'){observe({error:{code:e.error?.code||e.response?.error?.code,status:502}});throw Object.assign(new Error('上游返回错误'),{status:502});}
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
    const c=e.choices?.[0];if(c?.delta?.content)yield{type:'text',delta:c.delta.content};if(c?.delta?.reasoning_content)yield{type:'reasoning',delta:c.delta.reasoning_content};
    for(const t of c?.delta?.tool_calls||[])yield{type:'tool_call',index:t.index,id:t.id,name:t.function?.name,argumentsDelta:t.function?.arguments||''};
    if(c?.finish_reason)finish=c.finish_reason;
   }else if(protocol==='messages'){
    if(e.type==='content_block_start'&&e.content_block.type==='tool_use')yield{type:'tool_call',index:e.index,id:e.content_block.id,name:e.content_block.name,argumentsDelta:Object.keys(e.content_block.input||{}).length?JSON.stringify(e.content_block.input):''};
    if(e.delta?.type==='text_delta')yield{type:'text',delta:e.delta.text};if(e.delta?.type==='thinking_delta')yield{type:'reasoning',delta:e.delta.thinking};if(e.delta?.type==='input_json_delta')yield{type:'tool_call',index:e.index,argumentsDelta:e.delta.partial_json};
    if(e.delta?.stop_reason)finish=e.delta.stop_reason==='tool_use'?'tool_calls':e.delta.stop_reason==='max_tokens'?'length':'stop';if(e.type==='message_stop')terminal=true;
   }else{
    if(e.type==='response.output_text.delta')yield{type:'text',delta:e.delta};if(e.type==='response.reasoning_summary_text.delta')yield{type:'reasoning',delta:e.delta};
    if(e.type==='response.output_item.added'&&e.item.type==='function_call'){toolArgs.set(e.output_index,!!e.item.arguments);yield{type:'tool_call',index:e.output_index,id:e.item.call_id,name:e.item.name,argumentsDelta:e.item.arguments||''};finish='tool_calls';}
    if(e.type==='response.function_call_arguments.delta'){toolArgs.set(e.output_index,true);yield{type:'tool_call',index:e.output_index,argumentsDelta:e.delta};}
    if(e.type==='response.output_item.done'&&e.item.type==='function_call'&&!toolArgs.get(e.output_index)){yield{type:'tool_call',index:e.output_index,id:e.item.call_id,name:e.item.name,argumentsDelta:e.item.arguments||''};finish='tool_calls';}
    if(['response.completed','response.incomplete'].includes(e.type)){terminal=true;if(e.type==='response.incomplete')finish='length';}
   }
  }
  if(terminal||part.done)break;
 }
 if(!terminal){observe({error:{code:'incomplete_stream'}});throw new Error('上游连接提前结束');}if(usage)yield{type:'usage',usage};observe({finish});yield{type:'finish',reason:finish};
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
