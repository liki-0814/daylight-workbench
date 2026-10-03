export function createProxyApi(getToken){
 async function request(path,body,{signal}={}){
  const response=await fetch('/api/proxy/'+path,{method:body===undefined?'GET':'POST',headers:{'x-workbench-token':getToken(),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(65000)]):AbortSignal.timeout(65000)});
  let result;try{result=await response.json();}catch{throw Error('代理服务暂时无法连接，请稍后重试');}
  if(!response.ok)throw Error(typeof result.error==='string'?result.error:result.error?.message||'操作失败，请重试');return result;
 }
 return {request,source:(id,operation,body,options)=>request('sources/'+encodeURIComponent(id)+'/'+operation,body,options),custom:(operation,body,options)=>request('custom/'+(operation==='sources'?'sources':operation==='test'?'test':'sources/'+operation),body,options)};
}
