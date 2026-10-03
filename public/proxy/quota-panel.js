import {disclosureSection,mountDisclosures,refreshButton,setRefreshState} from '../components/section.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=value=>Number.isFinite(value)?value>0&&value<0.01?'<0.01':value.toLocaleString('zh-CN',{maximumFractionDigits:2}):'上游未提供';
const units={credits:'Credits',tokens:'Tokens',requests:'次',percent:'%',unknown:'单位未提供'};
export function renderQuota(snapshot){
 return (snapshot.buckets||[]).map(b=>{
  const known=Number.isFinite(b.usedPercent),progress=Math.min(100,Math.max(0,b.usedPercent||0)),unit=units[b.unit]||units.unknown,label=b.name||b.id;
  return `<article class="proxy-credit-bucket"><div class="proxy-credit-ring" role="img" aria-label="${esc(label)}已用 ${known?number(b.usedPercent)+'%':'上游未提供'}"><svg viewBox="0 0 120 120" aria-hidden="true"><circle class="proxy-credit-track" cx="60" cy="60" r="50"/><circle class="proxy-credit-progress" cx="60" cy="60" r="50" pathLength="100" stroke-dasharray="${progress} 100" transform="rotate(-90 60 60)"/></svg><div aria-hidden="true"><strong>${known?esc(number(b.usedPercent))+'%':'—'}</strong><span>${known?'已使用':'暂无占比'}</span></div></div><div class="proxy-credit-data"><h3>${esc(label)}</h3>${b.period?`<p class="proxy-hint">${esc(b.period)}</p>`:''}<dl>${b.unit==='percent'?`<div><dt>已用</dt><dd>${known?number(b.usedPercent)+'%':'上游未提供'}</dd></div><div><dt>剩余</dt><dd>${known?number(Math.max(0,100-b.usedPercent))+'%':'上游未提供'}</dd></div>`:`<div><dt>已用 ${esc(unit)}</dt><dd>${esc(number(b.used))}</dd></div><div><dt>剩余 ${esc(unit)}</dt><dd>${esc(number(b.remaining))}</dd></div><div><dt>总额度 ${esc(unit)}</dt><dd>${esc(number(b.limit))}</dd></div>`}</dl>${b.resetsAt?`<p class="proxy-hint">${esc(new Date(b.resetsAt).toLocaleString('zh-CN'))} 重置</p>`:''}</div></article>`;
 }).join('');
}
export function renderQuotaHistory(snapshot){
 return (snapshot.buckets||[]).map(bucket=>{
  const points=(snapshot.history||[]).map(row=>({at:Date.parse(row.checkedAt||row.updatedAt),value:row.buckets.find(b=>b.id===bucket.id)?.used})).filter(p=>Number.isFinite(p.at)&&Number.isFinite(p.value));
  if(!points.length)return '';const label=bucket.name||bucket.id,unit=units[bucket.unit]||units.unknown;
  if(points.length<2)return `<p class="proxy-hint">${esc(label)}：开始记录额度变化，积累两个小时的快照后显示趋势。</p>`;
  const max=Math.max(1,...points.map(p=>p.value)),start=points[0].at,end=points.at(-1).at,coords=points.map(p=>({...p,x:12+(p.at-start)/Math.max(1,end-start)*576,y:130-p.value/max*112}));
  return `<figure><figcaption>${esc(label)} · 已用 ${esc(unit)} 趋势</figcaption><svg viewBox="0 0 600 150" role="img" aria-label="${esc(label)}已用额度变化"><path class="proxy-trend-line" d="${coords.map((p,i)=>`${i?'L':'M'}${p.x},${p.y}`).join(' ')}"/>${coords.map(p=>`<circle cx="${p.x}" cy="${p.y}" r="3"><title>${esc(new Date(p.at).toLocaleString())}：${number(p.value)} ${esc(unit)}</title></circle>`).join('')}</svg><div class="proxy-trend-labels"><span>${esc(new Date(start).toLocaleString())}</span><span>${esc(new Date(end).toLocaleString())}</span></div></figure>`;
 }).join('');
}
export function createQuotaPanel({store,source}){
 const element=document.createElement('div');element.innerHTML=disclosureSection({id:source+'-usage-details',className:'proxy-disclosure',title:'订阅额度',description:'已用与剩余额度',actions:refreshButton({ariaLabel:'刷新额度',attrs:{'data-refresh-quota':true}}),content:'<p class="proxy-hint" role="status" data-summary></p><div class="proxy-credits" data-buckets></div><div class="proxy-credit-trend" data-trend></div><p class="proxy-hint" data-note hidden></p>'});mountDisclosures(element);
 const details=element.querySelector('details'),summary=element.querySelector('[data-summary]'),list=element.querySelector('[data-buckets]'),trend=element.querySelector('[data-trend]'),note=element.querySelector('[data-note]'),refresh=element.querySelector('[data-refresh-quota]');let version=0,loading=false,visible=false,checkedAt=0,last;
 async function load(force=false){
  if(loading)return;loading=true;checkedAt=Date.now();const current=version;setRefreshState(refresh,{loading:true});list.setAttribute('aria-busy','true');summary.textContent='正在读取额度…';
  try{const snapshot=await store.resource(source,'quota',{refresh:force,ttl:60000});if(version!==current||!snapshot)return;last=snapshot;list.innerHTML=renderQuota(snapshot);trend.innerHTML=renderQuotaHistory(snapshot);note.hidden=!snapshot.message;note.textContent=snapshot.message||'';summary.textContent=snapshot.buckets.length?`账户额度 · 获取于 ${new Date(snapshot.checkedAt||Date.now()).toLocaleString('zh-CN')} · 展开时每分钟刷新`:'上游未提供可读取的额度。';if(snapshot.historyError){const p=document.createElement('p');p.className='proxy-hint';p.textContent=snapshot.historyError;trend.append(p);}}
  catch(e){if(version===current&&e.name!=='AbortError')summary.textContent=e.message+(last?'。图表为上次数据，可点击刷新重试。':'');}
  finally{if(version===current){loading=false;setRefreshState(refresh);list.setAttribute('aria-busy','false');}}
 }
 details.ontoggle=()=>{if(details.open&&visible)void load();};refresh.onclick=()=>{void load(true);};
 return{element,setVisible(value){visible=value;if(value&&details.open)void load();},tick(){if(visible&&details.open&&Date.now()-checkedAt>=60000)void load();},reset(){version++;loading=false;checkedAt=0;last=null;list.replaceChildren();trend.replaceChildren();summary.textContent='';note.hidden=true;list.setAttribute('aria-busy','false');setRefreshState(refresh);},dispose(){version++;}};
}
