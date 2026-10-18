import {EnvHttpProxyAgent} from 'undici';

// Finder-launched apps have no shell proxy environment. The native parent passes
// the macOS HTTP/HTTPS settings; explicit environment settings take precedence.
export function proxyOptions(env=process.env){
 let system={};try{system=JSON.parse(env.DAYLIGHT_SYSTEM_PROXY||'{}');}catch{}
 const httpProxy=env.http_proxy??env.HTTP_PROXY??system.httpProxy??'';
 const httpsProxy=env.https_proxy??env.HTTPS_PROXY??system.httpsProxy??httpProxy;
 const noProxy=['localhost','127.0.0.1','[::1]',env.no_proxy??env.NO_PROXY??system.noProxy??''].filter(Boolean).join(',');
 return{httpProxy,httpsProxy,noProxy};
}

export function createNetworkFetch({env=process.env,fetchImpl=fetch}={}){
 const dispatcher=new EnvHttpProxyAgent(proxyOptions(env));
 return{fetch:(url,options={})=>fetchImpl(url,{...options,dispatcher}),close:()=>dispatcher.close()};
}
let network;
export const networkFetch=(url,options)=>(network??=createNetworkFetch()).fetch(url,options);
