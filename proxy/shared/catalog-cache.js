// Identity + generation guard: an old discovery cannot overwrite a newer account.
export class CatalogCache {
 constructor(ttl=300000){this.ttl=ttl;this.epoch=0;this.pending=new Map();}
 invalidate(){this.epoch++;this.value=undefined;this.pending.clear();}
 seed(value,identity){if(this.identity!==identity){this.invalidate();this.identity=identity;}if(value?.identity===identity&&!this.value)this.value=value;}
 async get({identity,refresh=false,valid=true,load,commit}){
  if(this.identity!==identity){this.invalidate();this.identity=identity;}
  if(!refresh&&valid&&this.value&&Date.now()-this.value.at<this.ttl)return this.value;
  const epoch=this.epoch;
  if(this.pending.has(epoch))return this.pending.get(epoch);
  const task=(async()=>{
   const data=await load();const value={...data,identity,at:Date.now()};
   if(this.epoch===epoch){if(commit)await commit(value);if(this.epoch===epoch)this.value=value;}
   return value;
  })();
  this.pending.set(epoch,task);
  try{return await task;}finally{if(this.pending.get(epoch)===task)this.pending.delete(epoch);}
 }
}
