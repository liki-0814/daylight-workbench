// One service poll; model and quota requests are keyed by source and resource.
export function createProxyState(api){
 let status,sources=[],error='',disposed=false,refreshing;const listeners=new Set(),resources=new Map(),logins=new Map(),authTasks=new Map();
 const notify=()=>{if(!disposed)for(const listener of listeners)listener();};
 const source=id=>sources.find(s=>s.id===id);
 function cancel(id){for(const [key,row] of resources)if(key.startsWith(id+':')){row.epoch++;row.controller?.abort();row.pending=null;row.controller=null;}}
 function invalidate(id){cancel(id);for(const [key,row] of resources)if(key.startsWith(id+':')){row.value=undefined;row.at=0;}}
 async function refresh(){
  if(disposed)return;if(refreshing)return refreshing;
  refreshing=(async()=>{
   try{
    const [statusResult,sourcesResult]=await Promise.allSettled([api.request('status'),api.request('sources')]);
    if(disposed)return;if(statusResult.status==='rejected')throw statusResult.reason;
    const next=statusResult.value,definitions=sourcesResult.status==='fulfilled'?sourcesResult.value:{sources:[]};
    for(const item of definitions.sources){const previous=source(item.id);if(previous&&(previous.identityKey!==item.identityKey||previous.revision!==item.revision))invalidate(item.id);}
    status=next;sources=definitions.sources;error=sourcesResult.status==='rejected'?sourcesResult.reason.message:'';
    for(const item of sources)if(item.authentication?.operations.includes('poll')&&next.login&&item.authentication.requiresStoppedService&&!logins.has(item.id))logins.set(item.id,next.login);
   }catch(e){error=e.message;}finally{refreshing=null;notify();}
  })();return refreshing;
 }
 async function resource(id,kind,{refresh=false,ttl=Infinity}={}){
  const key=id+':'+kind;let row=resources.get(key);if(!row){row={epoch:0,at:0};resources.set(key,row);}
  if(row.pending)return row.pending;if(!refresh&&row.value!==undefined&&Date.now()-row.at<ttl)return row.value;
  const epoch=row.epoch,controller=new AbortController();row.controller=controller;
  const task=(async()=>{
   const result=id==='custom'?await api.custom(kind,undefined,{signal:controller.signal}):await api.source(id,kind+(refresh&&kind==='models'?'?refresh=1':''),undefined,{signal:controller.signal});
   if(disposed||epoch!==row.epoch)return undefined;row.value=kind==='models'?result.models:result;row.at=Date.now();return row.value;
  })();row.pending=task;
  try{return await task;}finally{if(row.pending===task){row.pending=null;row.controller=null;}}
 }
 async function setModel(id,input){
  const result=await api.source(id,'models/setting',input);invalidate(id);resources.set(id+':models',{epoch:0,at:Date.now(),value:result.models});await refresh();return result.models;
 }
 async function auth(id,operation){
  if(authTasks.has(id))return authTasks.get(id);
  const task=(async()=>{
   const result=await api.source(id,'auth/'+operation,operation==='poll'?undefined:{});
   if(operation==='login'&&result?.url)logins.set(id,result);
   if(['cancel','logout'].includes(operation)||result?.authorized||result?.status==='authenticated')logins.delete(id);
   if(operation==='poll'&&result?.status&&result.status!=='pending'&&result.status!=='authenticated'){logins.delete(id);throw Error('登录未完成：'+result.status);}
   if(operation!=='poll'||result?.authorized||result?.status==='authenticated'){invalidate(id);await refresh();}
   notify();return result;
  })();authTasks.set(id,task);try{return await task;}finally{authTasks.delete(id);}
 }
 async function pollLogins(){
  await Promise.all([...logins.keys()].map(async id=>{
   const login=logins.get(id),expires=login.expiresAt>1e12?login.expiresAt:login.expiresAt*1000;
   if(Number.isFinite(expires)&&Date.now()>expires)return;
   try{await auth(id,'poll');}catch(e){logins.set(id,{...login,error:e.message});notify();}
  }));
 }
 return {api,refresh,resource,setModel,auth,pollLogins,cancel,invalidate,source,login:id=>logins.get(id),get status(){return status;},get sources(){return sources;},get error(){return error;},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},dispose(){disposed=true;for(const row of resources.values())row.controller?.abort();listeners.clear();}};
}
