import {operationError} from './operation-error.js';
// Account transitions invalidate all dependent catalogs, including in-flight loads.
export function bindAccountCatalog(provider,{caches=[provider.catalogCache],reset}={}){
 const previous=provider.auth.onChange;
 provider.auth.onChange=()=>{for(const cache of caches)cache.invalidate();provider.lastError=null;reset?.();previous?.call(provider.auth);};
}

export async function checkAccountCatalog(provider,refresh,{success=()=>({}),error=e=>operationError(e)}={}){
 const epoch=provider.auth.epoch;
 try{
  const models=await provider.listModels(refresh);
  if(epoch!==provider.auth.epoch)return{connected:false,error:'账号已变化，请重新检测'};
  provider.lastError=null;return{connected:true,...success(models)};
 }catch(e){
  const message=error(e);if(epoch===provider.auth.epoch)provider.lastError=message;
  return{connected:false,error:message};
 }
}
