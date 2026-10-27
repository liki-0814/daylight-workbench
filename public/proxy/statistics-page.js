import {sectionHeading,refreshButton,setRefreshState,disclosureSection,mountDisclosures} from '../components/section.js';
import {escapeButtonText as esc} from '../components/button.js';
import {updateSelectField} from '../components/select.js';
import {createDateRange} from '../components/date-range.js';
import {formatTokens,formatUsd} from '../components/format-number.js';
import {metricCard} from '../components/metric-card.js';
import {createBarChart} from '../components/bar-chart.js';
import {createDistributionList} from '../components/distribution-list.js';
import {segmentedControl,mountSegmentedControl} from '../components/segmented-control.js';
import {proxySourceNames} from '../../core/proxy-sources.js';
import {addCivilDays} from '../../core/date.js';

const number=value=>Number(value).toLocaleString('zh-CN',{maximumFractionDigits:1});
const tokens=formatTokens;
const percent=value=>value===null?'—':(value*100).toLocaleString('zh-CN',{maximumFractionDigits:1})+'%';
export function createStatisticsPage({api,store}){
 const root=document.createElement('section');root.id='proxy-panel-statistics';root.className='proxy-provider-page';root.hidden=true;root.setAttribute('role','tabpanel');root.setAttribute('aria-labelledby','proxy-tab-statistics');
 root.innerHTML=`<div class="workspace proxy-workspace"><section class="proxy-panel proxy-statistics-panel">${sectionHeading({title:'使用统计',description:'经过 Daylight 代理的已结束请求 · 永久保存按日汇总',actions:refreshButton({ariaLabel:'刷新使用统计',attrs:{'data-refresh-statistics':true}})})}<div class="proxy-statistics-toolbar ui-filter-fields" data-statistics-filters><div data-statistics-range></div></div><p class="proxy-statistics-note" data-statistics-coverage></p><p class="proxy-statistics-feedback proxy-error" role="alert" data-statistics-error></p><button class="text-button" type="button" data-statistics-reset hidden>清除来源和模型筛选</button></section><div class="proxy-statistics-metrics" data-statistics-metrics></div><div class="proxy-statistics-price"><div data-statistics-price></div>${disclosureSection({id:'statistics-price-notes',title:'价格依据与折算口径',content:'<div data-statistics-prices></div>'})}</div><section class="proxy-panel proxy-statistics-panel">${sectionHeading({title:'每日趋势',description:'按请求开始日期归属；点击日期查看当日汇总',actions:segmentedControl({id:'proxy-statistics-metric',label:'统计指标',value:'requests',options:[{value:'requests',label:'请求次数'},{value:'tokens',label:'Token 数'},{value:'cost',label:'API 折算'}]})})}<div data-statistics-chart></div></section><div class="proxy-statistics-distributions"><section class="proxy-panel proxy-statistics-panel">${sectionHeading({title:'模型分布',description:'点击模型筛选当前统计'})}<div data-model-distribution></div></section><section class="proxy-panel proxy-statistics-panel">${sectionHeading({title:'来源分布',description:'按最终处理请求的实际来源归属'})}<div data-source-distribution></div></section></div><section class="proxy-panel proxy-statistics-panel">${sectionHeading({title:'Token 构成',description:'缓存属于输入，思考属于输出；细分项不重复累加'})}<div data-token-breakdown></div></section></div>`;
 const $=selector=>root.querySelector(selector),filters=$('[data-statistics-filters]'),refresh=$('[data-refresh-statistics]'),error=$('[data-statistics-error]');
 const localDay=new Date().toLocaleDateString('en-CA');let range={preset:'today',from:localDay,to:localDay,today:localDay},source='',model='',metric='requests',report,initialized=false,visible=false,disposed=false,timer,controller,ticket=0,pending=false,readError=false,lastPaint='';
 const sourceName=id=>store.source(id)?.name||proxySourceNames[id]||id;
 const dates=createDateRange({id:'proxy-statistics-range',value:range,onChange(next){range=next;initialized=true;void load(true);}});$('[data-statistics-range]').append(dates.element);
 const chart=createBarChart({label:'每日代理用量',valueLabel:'用量',onSelect(day){range={...range,preset:'custom',from:day,to:day};dates.update(range);void load(true);}});$('[data-statistics-chart]').append(chart.element);
 const distributions={models:createDistributionList({label:'模型用量分布',format:value=>metric==='cost'?formatUsd(value):metric==='tokens'?tokens(value):number(value)+' 次',onSelect(id){model=id;void load(true);}}),sources:createDistributionList({label:'来源用量分布',format:value=>metric==='cost'?formatUsd(value):metric==='tokens'?tokens(value):number(value)+' 次',onSelect(id){source=id;model='';void load(true);}})};
 $('[data-model-distribution]').append(distributions.models.element);$('[data-source-distribution]').append(distributions.sources.element);
 const unmountSegments=mountSegmentedControl($('#proxy-statistics-metric'),{onChange(value){metric=value;paint();}});
 function paintFilters(){
  const sources=report?.options.sources||[],models=report?.options.models||[];
  updateSelectField(filters,{id:'statistics-source',name:'statistics-source',compact:true,label:'来源',value:source,options:[{value:'',label:'全部来源'},...[...new Set([...sources,...(source?[source]:[])])].map(id=>({value:id,label:sourceName(id)}))]});
  updateSelectField(filters,{id:'statistics-model',name:'statistics-model',compact:true,label:'模型',value:model,options:[{value:'',label:'全部模型'},...[...new Set([...models,...(model?[model]:[])])].map(id=>({value:id,label:id}))]});
  $('[data-statistics-reset]').hidden=!source&&!model;
 }
 function metricCards(summary){
  const s=summary,loading=!s,safe=s||{},state=loading?(readError?'error':'loading'):'ready',pendingNote=readError?'暂无可用统计':'正在读取统计';
  return metricCard({label:'请求次数',value:loading?'—':number(s.requests),unit:'次',state,note:loading?pendingNote:`失败 ${s.failed} · 超时 ${s.timedOut} · 取消 ${s.cancelled}${s.unknown?' · 状态未知 '+s.unknown:''}`})+
   metricCard({label:'总 Token',value:loading?'—':tokens(s.totalTokens),title:loading||s.totalTokens===null?'':number(s.totalTokens)+' Token',state,note:loading?pendingNote:`真实用量覆盖 ${s.tokenRequests} / ${s.requests} 次请求`})+
   metricCard({label:'缓存命中率',value:loading?'—':percent(s.cacheHitRate),state,note:loading?pendingNote:`按输入 Token 加权 · 有效计数 ${s.cacheRequests} 次`})+
   metricCard({label:'请求成功率',value:loading?'—':percent(s.successRate),state,note:loading?pendingNote:`成功 ${safe.succeeded} 次 · 取消与未知状态不计入分母`});
 }
 function paintMetrics(){
  $('[data-statistics-metrics]').innerHTML=metricCards(report?.summary);
  const s=report?.summary,state=s?'ready':readError?'error':'loading';
  $('[data-statistics-price]').innerHTML=metricCard({label:'官方 API 参考折算（USD）',value:formatUsd(s?.referenceCostUsd),state,note:s?`按当前参考目录收录的官方 API 公开单价折算，不代表订阅或账号的实际扣费。可折算 ${s.pricedRequests} / ${s.requests} 次请求；未计入部分不视为免费。`:readError?'暂无可用统计':'正在读取参考金额'});
 }
 function paint(){
  paintFilters();paintMetrics();
  if(!report)return;
  const s=report.summary,time=new Date(report.startedAt).toLocaleString('zh-CN',{timeZone:report.timeZone});
  $('[data-statistics-coverage]').textContent=`${report.from} 至 ${report.to} · ${report.timeZone}。持续统计始于 ${time}，回填 ${report.importedRequests} 条现存旧记录。${report.partial?'所选范围包含开始统计前的时段，早期数据可能不完整。':''}手动测试不计入；汇总永久保存。`;
  const value=row=>metric==='requests'?row.requests:metric==='cost'?row.referenceCostUsd:row.totalTokens;
  const display=row=>metric==='requests'?number(row.requests)+' 次':metric==='cost'?formatUsd(row.referenceCostUsd):tokens(row.totalTokens);
  chart.update(report.daily.map(day=>({key:day.day,label:day.day.slice(5),value:day.requests?value(day):0,valueText:day.requests?display(day):'无请求'})));
  for(const [key,list] of Object.entries(distributions))list.update(report[key].filter(row=>value(row)!==null).map(row=>({key:row.id,label:key==='sources'?sourceName(row.id):row.id,value:value(row)})).sort((a,b)=>b.value-a.value));
  $('[data-statistics-prices]').innerHTML='<p class="proxy-statistics-note">按当前参考单价统一折算历史用量，价格更新后参考金额也会变化。只有真实输入、输出与缓存计数完整且价表可用的部分参与；存在长上下文分档而历史汇总无法还原逐请求分档时不估算。未单列缓存写入的输入按普通输入价折算；单列写入但缺少价格的部分不计入。参考金额不包含订阅折扣、赠送额度、税费或实际账单调整。</p><ul>'+((report.references||[]).map(ref=>`<li>${esc(sourceName(ref.source))} · ${esc(ref.model)} · ${esc(ref.referenceId||'')} · 价表 ${esc(ref.updatedAt||'日期未知')} ${(ref.sources||[]).filter(url=>typeof url==='string'&&url.startsWith('https://')).map(url=>`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">价格来源</a>`).join(' · ')}</li>`).join('')||'<li>尚无可用的官方 API 参考价表</li>')+'</ul>';
  $('[data-token-breakdown]').innerHTML=`<div class="proxy-statistics-metrics">${metricCard({label:'输入（含缓存）',value:s.tokenRequests?tokens(s.inputTokens):'—',note:'计入总 Token'})}${metricCard({label:'输出（含思考）',value:s.tokenRequests?tokens(s.outputTokens):'—',note:'计入总 Token'})}${metricCard({label:'缓存读取',value:s.cacheRequests?tokens(s.cacheReadTokens):'—',note:`输入的细分 · 覆盖 ${s.cacheRequests} 次`})}${metricCard({label:'缓存写入',value:s.cacheWriteRequests?tokens(s.cacheWriteTokens):'—',note:`输入的细分 · 覆盖 ${s.cacheWriteRequests} 次`})}</div><p class="proxy-statistics-note">已报告的思考 Token：${s.reasoningRequests?tokens(s.reasoningTokens):'未知'}，属于输出的细分（覆盖 ${s.reasoningRequests} 次请求）。Token 汇总只使用同时提供真实输入与输出计数的请求；缺失、估算用量不补为零。${metric==='tokens'?'分布占比基于已知 Token；未知用量的模型不参与占比。':''}</p>`;
 }
 async function load(force=false){
  if(disposed||!visible||document.hidden||!force&&(pending||root.contains(document.activeElement)))return;
  controller?.abort();controller=new AbortController();const current=++ticket,scroll=window.scrollY;
  const params=new URLSearchParams({...initialized?{from:range.from,to:range.to}:{},...source?{source}:{},...model?{model}:{}}),queryKey=params.toString();
  pending=true;if(!report){readError=false;paintMetrics();}setRefreshState(refresh,{loading:true});root.setAttribute('aria-busy','true');
  try{
   const next=await api.request('statistics?'+params,undefined,{signal:controller.signal});if(disposed||current!==ticket)return;
   if(!initialized){range={preset:'today',from:next.from,to:next.to,today:next.today};dates.update(range);initialized=true;}else range.today=next.today;
   report=next;readError=false;paint();error.textContent=next.error||'';
   if(lastPaint===queryKey)window.scrollTo({top:scroll});lastPaint=queryKey;
  }catch(cause){if(!disposed&&current===ticket&&cause.name!=='AbortError'){readError=true;error.textContent=(report?'刷新失败，保留上次汇总。':'使用统计读取失败。')+' '+cause.message;if(!report)paintMetrics();}}
  finally{if(!disposed&&current===ticket){pending=false;setRefreshState(refresh);root.removeAttribute('aria-busy');}}
 }
 refresh.onclick=()=>void load(true);
 $('[data-statistics-reset]').onclick=()=>{source='';model='';void load(true);};
 const onChange=event=>{const select=event.target.closest('workbench-select');if(select?.id==='statistics-source'){source=select.value;model='';void load(true);}if(select?.id==='statistics-model'){model=select.value;void load(true);}};root.addEventListener('change',onChange);
 const visibility=()=>{clearInterval(timer);if(visible&&!document.hidden){void load();timer=setInterval(()=>void load(),30000);}else{ticket++;controller?.abort();pending=false;setRefreshState(refresh);root.removeAttribute('aria-busy');}};document.addEventListener('visibilitychange',visibility);
 mountDisclosures(root);paint();
 return{element:root,setVisible(value){if(visible===value)return;visible=value;root.hidden=!value;visibility();},dispose(){disposed=true;visible=false;visibility();dates.dispose();chart.dispose();for(const list of Object.values(distributions))list.dispose();unmountSegments();document.removeEventListener('visibilitychange',visibility);root.removeEventListener('change',onChange);root.remove();}};
}
