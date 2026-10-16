// Synthetic GitHub/Copilot service. Never reads a real account, CLI or Keychain.
import {CopilotAuth} from '../../proxy/copilot/auth.js';
import {CopilotProvider} from '../../proxy/copilot/provider.js';
export const catalog={data:[
 {id:'copilot-chat-fixture',name:'Copilot Chat Fixture',supported_endpoints:['/chat/completions'],capabilities:{type:'chat',limits:{max_context_window_tokens:128000,max_output_tokens:8192},supports:{tool_calls:true,vision:true,reasoning:true},reasoning_effort:{supported_values:['low','high']}}},
 {id:'copilot-responses-fixture',name:'Copilot Responses Fixture',supported_endpoints:['/responses'],capabilities:{type:'chat',limits:{max_context_window_tokens:200000,max_output_tokens:16000},supports:{tool_calls:true}}},
]};
export function fixture({dataDir,loggedIn=false}={}){
 const keys=new Map(),calls=[];let now=Date.now(),pollResult={access_token:'synthetic-github-secret'},modelResult=catalog,blocked=false;
 if(loggedIn)keys.set('copilot-oauth',JSON.stringify({accessToken:'synthetic-github-secret',account:{id:'123',login:'fixture-user'}}));
 const secrets={get:async id=>keys.get(id),set:async(id,value)=>{keys.set(id,value);},delete:async id=>{keys.delete(id);}};
 const fetchImpl=async(url,init={})=>{
  calls.push({url,init});const endpoint=new URL(url).pathname;
  if(endpoint==='/login/device/code')return Response.json({device_code:'synthetic-device-secret',user_code:'TEST-CODE',verification_uri:'https://github.com/login/device',interval:5,expires_in:900});
  if(endpoint==='/login/oauth/access_token')return Response.json(pollResult);
  if(endpoint==='/user')return Response.json({id:123,login:'fixture-user'});
  if(endpoint==='/copilot_internal/v2/token')return blocked?Response.json({}, {status:403}):Response.json({token:'synthetic-copilot-secret',expires_at:Math.floor(now/1000)+3600,endpoints:{api:'https://api.githubcopilot.com'}});
  if(endpoint==='/copilot_internal/user')return Response.json({copilot_plan:'individual',quota_reset_date:'2026-11-01',quota_snapshots:{premium_interactions:{entitlement:300,remaining:240,percent_remaining:80},chat:{unlimited:true},completions:{}}});
  if(endpoint==='/models')return Response.json(modelResult);
  const body=JSON.parse(init.body),messages=body.messages||body.input||[],continued=messages.some(m=>m.role==='tool'||m.type==='function_call_output');
  if(endpoint==='/v1/messages'){
   const continued=messages.some(m=>Array.isArray(m.content)&&m.content.some(c=>c.type==='tool_result')),tool=body.tools?.length&&!continued;
   if(body.stream){const event=(type,data)=>`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`;return new Response(
    event('message_start',{message:{id:'msg_fixture',type:'message',role:'assistant',model:body.model,content:[],usage:{input_tokens:10,output_tokens:0}}})+
    event('content_block_start',{index:0,content_block:tool?{type:'tool_use',id:'call_echo',name:'echo',input:{}}:{type:'text',text:''}})+
    event('content_block_delta',{index:0,delta:tool?{type:'input_json_delta',partial_json:'{"text":"hello"}'}:{type:'text_delta',text:'OK'}})+
    event('content_block_stop',{index:0})+event('message_delta',{delta:{stop_reason:tool?'tool_use':'end_turn'},usage:{output_tokens:2}})+event('message_stop',{}),{headers:{'Content-Type':'text/event-stream'}});
   }
   return Response.json({id:'msg_fixture',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:'OK'}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:2}});
  }
  if(endpoint==='/responses')return Response.json({id:'resp_fixture',object:'response',model:body.model,status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}],usage:{input_tokens:10,output_tokens:2,total_tokens:12}});
  if(body.stream){
   const delta=body.tools?.length&&!continued?{tool_calls:[{index:0,id:'call_echo',type:'function',function:{name:'echo',arguments:'{"text":"hello"}'}}]}:{content:'OK'};
   const chunk=(delta,finish_reason=null,usage)=>'data: '+JSON.stringify({id:'chat_fixture',model:body.model,choices:[{index:0,delta,finish_reason}],...(usage?{usage}:{})})+'\n\n';
   return new Response(chunk(delta)+chunk({},delta.tool_calls?'tool_calls':'stop',{prompt_tokens:10,completion_tokens:2,total_tokens:12})+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  }
  return Response.json({id:'chat_fixture',model:body.model,choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}});
 };
 const auth=new CopilotAuth({fetchImpl,secrets,now:()=>now});
 return{auth,p:new CopilotProvider({dataDir,auth,fetchImpl}),fetchImpl,secrets,keys,calls,advance:ms=>{now+=ms;},setPoll:value=>{pollResult=value;},setModels:value=>{modelResult=value;},block:value=>{blocked=value;}};
}
