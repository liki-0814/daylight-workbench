const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function renderModelSpeed(model){return `<p class="proxy-hint ui-model-speed" data-model-speed="${esc(model.id)}" data-speed-upstream="${esc(model.upstreamId||model.id)}">生成速度：等待实际请求</p>`;}
export function updateModelSpeeds(root,stats=[],{stale=false,loading=false}={}){
 for(const element of root.querySelectorAll('[data-model-speed]')){
  const groups=stats.filter(row=>(row.model===element.dataset.modelSpeed||row.upstreamModel===element.dataset.speedUpstream||row.model===element.dataset.speedUpstream)&&Number.isFinite(row.tokensPerSecond)&&row.samples>0),latest=groups[0];
  if(!latest){element.textContent=stale?'生成速度：统计暂时不可用':loading?'生成速度：正在读取统计…':'生成速度：等待实际请求';element.removeAttribute('title');continue;}
  const number=(value,digits=1)=>value.toLocaleString(undefined,{maximumFractionDigits:digits});
  const label=row=>`${number(row.tokensPerSecond)} tok/s${Number.isFinite(row.firstContentMs)&&row.firstContentMs>=0?' · 首次输出 '+number(row.firstContentMs/1000,2)+'s':''} · 最近 ${row.samples} 次${row.effort&&row.effort!=='auto'?' · '+row.effort:''}${row.tier&&row.tier!=='auto'?' · '+row.tier:''}${row.estimated?' · 估算':''}${row.timing==='upstream'?' · 含首包等待':''}`;
  element.textContent='生成速度：'+label(latest)+(stale?' · 暂未更新':'');
  element.title=groups.map(row=>label(row)+' · '+new Date(row.updatedAt).toLocaleString()+(Number.isFinite(row.lastTokensPerSecond)?' · 最近一次 '+number(row.lastTokensPerSecond)+' tok/s':'')).join('\n');
 }
}

// Statistics have their own read lifecycle; they never enter Pi config/versioning.
export function createModelSpeedFeed({api,onChange=()=>{},page=globalThis.document,repeat=globalThis.setInterval,stop=globalThis.clearInterval}){
 let sources=new Map(),loaded=false,error=false,visible=false,disposed=false,pending,controller,timer,epoch=0;
 const notify=()=>{if(!disposed)onChange();};
 function cancel(){epoch++;controller?.abort();controller=undefined;pending=undefined;}
 function refresh(){
  if(disposed||!visible||page.hidden)return Promise.resolve();
  if(pending)return pending;
  const current=epoch;controller=new AbortController();const signal=controller.signal;
  pending=(async()=>{
   try{
    const result=await Promise.resolve().then(()=>api.request('sources',undefined,{signal}));
    if(disposed||current!==epoch)return;
    if(!Array.isArray(result.sources))throw Error('Invalid source statistics');
    sources=new Map(result.sources.map(source=>[source.id,Array.isArray(source.performance)?source.performance:[]]));loaded=true;error=false;
   }catch(cause){if(!disposed&&current===epoch&&cause.name!=='AbortError')error=true;}
   finally{if(!disposed&&current===epoch){pending=undefined;controller=undefined;notify();}}
  })();
  notify();return pending;
 }
 function synchronize(){
  if(timer!==undefined){stop(timer);timer=undefined;}
  if(disposed||!visible||page.hidden){cancel();return;}
  void refresh();timer=repeat(()=>{void refresh();},3000);
 }
 page.addEventListener('visibilitychange',synchronize);
 return{refresh,get:source=>sources.get(source)||[],get loading(){return!loaded&&!error;},get stale(){return error;},setVisible(value){if(visible===value||disposed)return;visible=value;synchronize();},dispose(){disposed=true;visible=false;synchronize();page.removeEventListener('visibilitychange',synchronize);sources.clear();}};
}
