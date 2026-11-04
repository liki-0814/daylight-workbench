import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {EnvHttpProxyAgent,fetch as undiciFetch} from 'undici';
// undici 8 notes:
// - Dispatchers accept only the new handler API (onRequestStart...), while Node's
//   bundled fetch still drives them with legacy handlers, so pair the dispatcher
//   with the fetch from the same undici package.
// - ProxyAgent no longer tunnels plain http:// targets by default (it forwards an
//   absolute-form request). System/corporate proxies are configured for CONNECT,
//   so keep tunnelling every proxied request with proxyTunnel:true.

// Finder-launched apps have no shell proxy environment. The native parent passes
// the macOS HTTP/HTTPS settings; explicit environment settings take precedence.
export function proxyOptions(env=process.env){
 let system={};try{system=JSON.parse(env.DAYLIGHT_SYSTEM_PROXY||'{}');}catch{}
 const httpProxy=env.http_proxy??env.HTTP_PROXY??system.httpProxy??'';
 const httpsProxy=env.https_proxy??env.HTTPS_PROXY??system.httpsProxy??httpProxy;
 const noProxy=['localhost','127.0.0.1','[::1]',env.no_proxy??env.NO_PROXY??system.noProxy??''].filter(Boolean).join(',');
 return{httpProxy,httpsProxy,noProxy};
}

// Read settings without restarting the sidecar. No request is replayed when they change.
export async function readSystemProxy(){
 const {stdout}=await promisify(execFile)('/usr/sbin/scutil',['--proxy'],{timeout:2000,maxBuffer:65536});
 const field=name=>stdout.match(new RegExp('^\\s*'+name+'\\s*:\\s*(.+)$','m'))?.[1]?.trim();
 const result={};
 for(const [prefix,key] of [['HTTP','httpProxy'],['HTTPS','httpsProxy']]){
  const host=field(prefix+'Proxy'),port=Number(field(prefix+'Port'));
  if(field(prefix+'Enable')==='1'&&host&&Number.isInteger(port)&&port>0&&port<=65535){const url=new URL('http://localhost');url.hostname=host;url.port=String(port);result[key]=url.origin;}
 }
 const exceptions=stdout.match(/ExceptionsList\s*:\s*<array>\s*{([^}]+)}/)?.[1];
 if(exceptions)result.noProxy=[...exceptions.matchAll(/\d+\s*:\s*(.+)/g)].map(m=>m[1].trim()).filter(s=>!s.includes('/')&&s!=='<local>').join(',');
 return result;
}
export function createNetworkFetch({env=process.env,fetchImpl=undiciFetch,systemProxy=env===process.env&&process.platform==='darwin'&&env.DAYLIGHT_SYSTEM_PROXY!==undefined?readSystemProxy:undefined,now=Date.now,pollMs=5000,dispatcherFactory=options=>new EnvHttpProxyAgent(options)}={}){
 let dispatcher,key,checking,checkedAt=-Infinity,closed=false;const retired=new Set();let system=env.DAYLIGHT_SYSTEM_PROXY;
 async function current(){
  if(closed)throw Error('网络连接已关闭');
  if(systemProxy&&now()-checkedAt>=pollMs){
   if(!checking)checking=(async()=>{try{system=JSON.stringify(await systemProxy());}catch{/* Keep the last known settings on a transient OS query failure. */}finally{checkedAt=now();}})().finally(()=>{checking=null;});
   await checking;
  }
  if(closed)throw Error('网络连接已关闭');
  const options={...proxyOptions({...env,DAYLIGHT_SYSTEM_PROXY:system}),proxyTunnel:true},nextKey=JSON.stringify(options);
  if(nextKey!==key){const old=dispatcher;dispatcher=dispatcherFactory(options);key=nextKey;if(old){const task=Promise.resolve(old.close()).catch(()=>{}).finally(()=>retired.delete(task));retired.add(task);}}
  return dispatcher;
 }
 return{fetch:async(url,options={})=>fetchImpl(url,{...options,dispatcher:await current()}),close:async()=>{closed=true;await checking;await dispatcher?.close();await Promise.all(retired);}};
}
let network;
export const networkFetch=(url,options)=>(network??=createNetworkFetch()).fetch(url,options);
