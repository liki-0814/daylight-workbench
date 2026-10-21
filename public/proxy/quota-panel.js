import {refreshButton,setRefreshState,sectionHeading} from '../components/section.js';
import {escapeButtonText as esc} from '../components/button.js';
import {createProgressMeter} from '../components/progress-meter.js';

const number=value=>value.toLocaleString('zh-CN',{maximumFractionDigits:2});
const units={credits:'Credits',tokens:'Tokens',requests:'次'};
const plans={individual:'Copilot Pro',individual_pro:'Copilot Pro+',individual_max:'Copilot Max',business:'Copilot Business',enterprise:'Copilot Enterprise',free:'Copilot Free'};
function resetLabel(value){
 const time=Date.parse(value);if(!Number.isFinite(time))return '';
 const minutes=Math.ceil((time-Date.now())/60000),days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60);
 const relative=minutes<=0?'即将重置':days?`${days} 天 ${hours} 小时后重置`:hours?`${hours} 小时 ${minutes%60} 分钟后重置`:`${minutes} 分钟后重置`;
 return `<span title="${esc(new Date(time).toLocaleString('zh-CN'))}">${esc(relative)}</span>`;
}

// Buckets arrive validated by the quota adapters; rendering only chooses their layout.
export function renderQuota(snapshot){
 const buckets=snapshot.buckets||[],unlimited=buckets.filter(b=>b.unlimited);
 const metered=buckets.filter(b=>!b.unlimited);
 return metered.map(b=>{
  const percent=b.usedPercent,known=Number.isFinite(percent),remaining=known?Math.max(0,Math.min(100,100-percent)):undefined,label=[b.name||b.id,b.period].filter(Boolean).join(' · '),unit=units[b.unit];
  const amount=unit?(Number.isFinite(b.remaining)?`剩余 ${number(b.remaining)}${Number.isFinite(b.limit)?' / '+number(b.limit):''} ${unit}`:Number.isFinite(b.used)?`已用 ${number(b.used)}${Number.isFinite(b.limit)?' / '+number(b.limit):''} ${unit}`:Number.isFinite(b.limit)?`总额 ${number(b.limit)} ${unit}`:''):'';
  return `<div class="proxy-quota-window"><div class="proxy-quota-window-heading"><span>${esc(label)}</span>${known?`<strong>${esc(number(remaining))}%</strong>`:''}</div>${known?`<div data-quota-progress data-value="${remaining/100}" data-label="${esc(label)}剩余 ${esc(number(remaining))}%"></div>`:''}<div class="proxy-quota-window-meta">${resetLabel(b.resetsAt)}${amount?`<span>${esc(amount)}</span>`:''}</div></div>`;
 }).join('')+(unlimited.length?`<p class="proxy-quota-unlimited">${unlimited.map(b=>esc(b.name||b.id)+'：不限量').join(' · ')}</p>`:'');
}

export function createQuotaPage({store}){
 const root=document.createElement('section');root.id='proxy-panel-quota';root.className='proxy-provider-page';root.hidden=true;root.setAttribute('role','tabpanel');root.setAttribute('aria-labelledby','proxy-tab-quota');
 root.innerHTML=`<div class="workspace proxy-workspace"><section class="proxy-panel proxy-quota-panel">${sectionHeading({title:'账户额度',description:'各账号的剩余额度 · 每分钟刷新',actions:refreshButton({ariaLabel:'刷新账户额度',attrs:{'data-refresh-quota':true}})})}<div class="proxy-quota-columns" aria-hidden="true"><span>账号</span><span>剩余额度</span></div><div data-quota-accounts aria-busy="false"></div><p class="proxy-quota-empty" role="status" data-quota-empty></p></section></div>`;
 const list=root.querySelector('[data-quota-accounts]'),empty=root.querySelector('[data-quota-empty]'),refresh=root.querySelector('[data-refresh-quota]'),rows=new Map();
 let visible=false,disposed=false,timer,focusAfterRefresh=false;
 function paint(){
  if(disposed||!visible)return;
  list.innerHTML=[...rows.values()].map(row=>{
   const content=renderQuota(row.snapshot||{});if(!content&&!row.loading&&!row.error)return '';
   const account=row.source.account,login=account?.login||account?.organization||account?.uid,plan=row.source.id==='copilot'?plans[row.snapshot?.plan]:undefined;
   return `<article class="proxy-quota-account" data-quota-source="${esc(row.source.id)}"><div class="proxy-quota-identity"><strong>${esc(login||row.source.name)}</strong>${login?`<span>${esc(row.source.name)}</span>`:''}${plan?`<span>${esc(plan)}</span>`:''}${row.snapshot?.checkedAt?`<small>更新于 ${esc(new Date(row.snapshot.checkedAt).toLocaleTimeString('zh-CN'))}</small>`:''}</div><div class="proxy-quota-windows">${content}${row.loading&&!content?'<p class="proxy-hint" role="status">正在读取额度…</p>':''}${row.error?`<p class="proxy-error" role="alert">${content?'刷新失败 · 显示上次数据':'额度读取失败'}，请点击刷新重试。</p>`:''}</div></article>`;
  }).join('');
  for(const slot of list.querySelectorAll('[data-quota-progress]')){const meter=createProgressMeter({label:slot.dataset.label});meter.setValue(Number(slot.dataset.value),slot.dataset.label);slot.append(meter.element);}
  const loading=[...rows.values()].some(row=>row.loading);setRefreshState(refresh,{loading});list.setAttribute('aria-busy',String(loading));
  if(!loading&&focusAfterRefresh){focusAfterRefresh=false;if(document.activeElement===document.body||document.activeElement===refresh)refresh.focus({preventScroll:true});}
  empty.hidden=!!list.children.length;empty.textContent=store.error?'账户状态读取失败，请点击刷新重试。':rows.size?'暂无可展示的账户额度':'登录账号后在这里查看额度。';
 }
 async function load(row,force=false){
  if(row.loading||!force&&Date.now()-row.at<60000)return;
  row.loading=true;row.at=Date.now();paint();
  try{
   const snapshot=await store.resource(row.source.id,'quota',{refresh:force,ttl:60000});
   if(disposed||rows.get(row.source.id)!==row)return;
   if(snapshot){row.snapshot=snapshot;row.error=false;}else row.at=0;
  }catch(error){if(!disposed&&rows.get(row.source.id)===row&&error.name!=='AbortError')row.error=true;}
  finally{row.loading=false;paint();}
 }
 function sync(force=false){
  if(disposed||!visible||document.hidden)return;
  const sources=store.sources.filter(s=>s.capabilities?.quota&&(s.configured||s.connected)),ids=new Set(sources.map(s=>s.id));
  for(const id of rows.keys())if(!ids.has(id))rows.delete(id);
  for(const source of sources){
   let row=rows.get(source.id);
   if(!row||row.source.identityKey!==source.identityKey||row.source.revision!==source.revision){row={source,at:0};rows.set(source.id,row);}else row.source=source;
   void load(row,force);
  }
  paint();
 }
 refresh.onclick=async()=>{const restore=document.activeElement===refresh;await store.refresh();focusAfterRefresh=restore;sync(true);};
 const unsubscribe=store.subscribe(()=>sync()),onVisibility=()=>{if(!document.hidden)sync();};document.addEventListener('visibilitychange',onVisibility);
 return{element:root,setVisible(value){visible=value;root.hidden=!value;clearInterval(timer);if(value){sync();timer=setInterval(sync,60000);}},dispose(){disposed=true;clearInterval(timer);unsubscribe();document.removeEventListener('visibilitychange',onVisibility);rows.clear();}};
}
