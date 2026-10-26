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

export function createNetworkFetch({env=process.env,fetchImpl=undiciFetch}={}){
 const dispatcher=new EnvHttpProxyAgent({...proxyOptions(env),proxyTunnel:true});
 return{fetch:(url,options={})=>fetchImpl(url,{...options,dispatcher}),close:()=>dispatcher.close()};
}
let network;
export const networkFetch=(url,options)=>(network??=createNetworkFetch()).fetch(url,options);
