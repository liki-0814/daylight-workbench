// Fully isolated OAuth + inference fixture. Never touches a real CLI, Keychain or account.
import {generateKeyPairSync,sign} from 'node:crypto';
import {KimiAuth} from '../../proxy/kimi/auth.js';
import {GrokAuth} from '../../proxy/grok/auth.js';
import {CodexAuth} from '../../proxy/codex/auth.js';
import {KimiProvider} from '../../proxy/kimi/provider.js';
import {GrokProvider} from '../../proxy/grok/provider.js';
import {CodexProvider} from '../../proxy/codex/provider.js';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
export const jwk={...publicKey.export({format:'jwk'}),kid:'fixture-key',alg:'RS256',use:'sig'};
export function jwt(claims){const a=Buffer.from(JSON.stringify({alg:'RS256',kid:'fixture-key'})).toString('base64url'),b=Buffer.from(JSON.stringify(claims)).toString('base64url');return a+'.'+b+'.'+sign('sha256',Buffer.from(a+'.'+b),privateKey).toString('base64url');}
export function accountFixture({id,dataDir,loggedIn=false}={}){
 const keys=new Map(),calls=[];let now=Date.now(),pollError,failModels=false,user=id+'-user',version=0;
 const issuer=id==='grok'?'https://auth.x.ai':'https://auth.openai.com';
 const tokenEndpoint=id==='kimi'?'https://auth.kimi.com/api/oauth/token':id==='grok'?issuer+'/oauth2/token':issuer+'/api/accounts/oauth/token';
 const clientId=id==='codex'?'oaiapp_fixture':id==='kimi'?'17e5f671-d194-4dfb-9706-5516cb48c098':'b1a00492-073a-47ea-816f-4c329264a828';
 const scope='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
 const secrets={get:async key=>keys.get(key),set:async(key,value)=>{keys.set(key,value);},delete:async key=>{keys.delete(key);}};
 let auth;
 const tokenData=()=>({access_token:'synthetic-'+id+'-access-'+(++version),refresh_token:'synthetic-'+id+'-refresh-'+version,expires_in:3600,scope,...(id==='codex'?{id_token:jwt({iss:issuer,sub:user,email:user+'@example.test',aud:clientId,exp:Math.floor(now/1000)+3600,nonce:auth.pending?.nonce})}:{})});
 const fetchImpl=async(url,options={})=>{
  calls.push({url,options});const u=new URL(url),form=new URLSearchParams(options.body);
  if(u.pathname==='/.well-known/openid-configuration')return Response.json({issuer,device_authorization_endpoint:issuer+'/oauth2/device',token_endpoint:tokenEndpoint,userinfo_endpoint:issuer+'/userinfo',jwks_uri:issuer+'/jwks'});
  if(u.pathname==='/jwks')return Response.json({keys:[jwk]});
  if(u.pathname.endsWith('/device_authorization')||u.pathname==='/oauth2/device')return Response.json({device_code:'synthetic-device-secret',user_code:'TEST-CODE',verification_uri:id==='kimi'?'https://www.kimi.com/code/authorize_device':'https://accounts.x.ai/oauth2/device',expires_in:900,interval:5});
  if(url===tokenEndpoint){if(form.get('grant_type')!=='refresh_token'&&pollError)return Response.json({error:pollError});return Response.json(tokenData());}
  if(u.pathname.endsWith('/me'))return Response.json({user_id:user,nickname:user});
  if(u.pathname==='/userinfo')return Response.json({sub:user,email:user+'@example.test'});
  if(u.pathname.endsWith('/models')){
   if(failModels)return Response.json({}, {status:503});
   if(id==='codex')return Response.json({models:[{slug:id+'-fixture',display_name:'Codex Fixture',visibility:'list',context_window:200000,max_output_tokens:16000,supported_reasoning_efforts:['low','high']}]});
   if(id==='kimi')return Response.json({data:[{id:id+'-fixture',display_name:'Kimi Fixture',context_length:128000,max_output_tokens:8192,supports_reasoning:true,reasoning:{effort:{valid:['low','high']}}}]});
   return Response.json({data:[{id:id+'-fixture',name:'Grok Fixture',api_backend:'responses',context_window:128000,max_completion_tokens:8192,reasoning_efforts:[{value:'low'},{value:'high'}]}]});
  }
  if(u.pathname.endsWith('/usages'))return Response.json({usage:{limit:100,used:25}});
  if(u.pathname.endsWith('/billing'))return Response.json({config:{creditUsagePercent:25}});
  const body=JSON.parse(options.body),messages=body.messages||body.input||[],continued=messages.some(m=>m.role==='tool'||m.type==='function_call_output'),tool=body.tools?.length&&!continued;
  if(id==='kimi'){
   const message=tool?{tool_calls:[{index:0,id:'call_echo',type:'function',function:{name:'echo',arguments:'{"text":"hello"}'}}]}:{content:'OK'};
   if(!body.stream)return Response.json({choices:[{message:{role:'assistant',...message},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:2}});
   const chunk=(delta,finish_reason=null)=>'data: '+JSON.stringify({id:'chat_fixture',model:body.model,choices:[{index:0,delta,finish_reason}],usage:{prompt_tokens:10,completion_tokens:2}})+'\n\n';
   return new Response(chunk(message)+chunk({},tool?'tool_calls':'stop')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  }
  const item=tool?{type:'function_call',id:'fc_echo',call_id:'call_echo',name:'echo',arguments:'{"text":"hello"}',...(id==='codex'?{namespace:'daylight'}:{})}:{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]};
  const events=[{type:'response.created',response:{id:'resp_fixture',model:body.model,output:[]}},{type:'response.output_item.added',output_index:0,item:tool?{...item,arguments:''}:item},...(tool?[{type:'response.function_call_arguments.delta',output_index:0,delta:item.arguments}]:[{type:'response.output_text.delta',delta:'OK'}]),{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'resp_fixture',model:body.model,status:'completed',output:[item],usage:{input_tokens:10,output_tokens:2,total_tokens:12}}}];
  return new Response(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
 };
 auth=new ({kimi:KimiAuth,grok:GrokAuth,codex:CodexAuth}[id])({dataDir,fetchImpl,secrets,now:()=>now});
 const provider=new ({kimi:KimiProvider,grok:GrokProvider,codex:CodexProvider}[id])({dataDir,fetchImpl,auth});
 const seed=async()=>auth.commit({...tokenData(),expiresAt:now+3600000,clientId,tokenEndpoint,account:{id:user,login:user}},auth.epoch);
 const ready=loggedIn?seed():Promise.resolve();
 return{id,auth,provider,keys,calls,fetchImpl,secrets,ready,seed,advance:ms=>{now+=ms;},deny:value=>{pollError=value;},failModels:value=>{failModels=value;},switchAccount:()=>{user=id+'-other';},async completeLogin(){if(id==='codex'){const p=auth.pending;return fetch(p.redirectUri+'?'+new URLSearchParams({code:'synthetic-code',state:p.state,client_id:clientId}));}now+=5000;return auth.poll();}};
}
