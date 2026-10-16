import {AgyAuth} from '../../proxy/agy/auth.js';
import {AgyProvider} from '../../proxy/agy/provider.js';
// Synthetic OAuth and model API; never opens Google or reads a real credential store.
export function agyFixture({dataDir,loggedIn=false,...options}){
 const keys=new Map(),calls=[];let now=Date.now(),version=0,user='agy-user',failure=0;
 const client={client_id:'fixture.apps.googleusercontent.com',client_secret:'synthetic-client-secret'},tokenEndpoint='https://oauth2.googleapis.com/token';
 const secrets={get:async id=>keys.get(id),set:async(id,value)=>{keys.set(id,value);},delete:async id=>{keys.delete(id);}};
 const tokens=()=>({access_token:'synthetic-access-'+(++version),refresh_token:'synthetic-refresh-'+version,expires_in:3600});
 const fetchImpl=async(url,options={})=>{
  calls.push({url,options});
  if(url===tokenEndpoint)return Response.json(tokens());
  if(url.includes('/userinfo'))return Response.json({id:user,email:user+'@example.test'});
  if(failure)return Response.json({}, {status:failure});
  if(url.endsWith(':loadCodeAssist'))return Response.json({cloudaicompanionProject:'synthetic-project'});
  if(url.endsWith(':fetchAvailableModels'))return Response.json({models:{'agy-fixture':{displayName:'AGY Fixture',maxTokens:128000,maxOutputTokens:8192,supportsThinking:false}}});
  if(url.endsWith(':retrieveUserQuotaSummary'))return Response.json({buckets:[]});
  if(url.includes(':streamGenerateContent')){
   const body=JSON.parse(options.body),contents=body.request.contents,continued=contents.some(c=>c.parts?.some(p=>p.functionResponse));
   const tool=body.request.tools?.length&&!continued,part=tool?{functionCall:{name:'echo',args:{text:'hello'}},thoughtSignature:'synthetic-signature'}:{text:'OK'};
   return new Response('data: '+JSON.stringify({response:{candidates:[{content:{parts:[part]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:2,totalTokenCount:12}}})+'\n\n',{headers:{'Content-Type':'text/event-stream'}});
  }
  throw Error('Unexpected fixture endpoint');
 };
 const auth=new AgyAuth({dataDir,callbackPort:0,getOAuthClientImpl:async()=>client,secrets,fetchImpl,now:()=>now,tokenFile:null,credentials:{get:async()=>null},...options});
 const provider=new AgyProvider({dataDir,auth,fetchImpl});
 const seed=()=>auth.commit({...tokens(),clientId:client.client_id,method:'consumer',tokenEndpoint,expiresAt:now+3600000,account:{id:user,login:user+'@example.test'}},auth.epoch);
 return{auth,provider,secrets,keys,calls,client,fetchImpl,ready:loggedIn?seed():Promise.resolve(),seed,advance:ms=>{now+=ms;},switchAccount:()=>{user='agy-other';},fail:code=>{failure=code;},complete:async()=>{const p=auth.pending;return fetch(p.redirectUri+'?'+new URLSearchParams({code:'synthetic-code',state:p.state}));}};
}
