import {escapeButtonText as esc} from './button.js';

/** Numeric distributions; the consumer supplies labels, formatting (or per-row `valueText`) and selection. */
export function createDistributionList({label,format=value=>value.toLocaleString(),onSelect=()=>{},limit=8}){
 const element=document.createElement('section');element.className='ui-distribution';element.setAttribute('aria-label',label);
 let data=[],expanded=false;
 function paint(){
  const total=data.reduce((sum,row)=>sum+row.value,0),shown=expanded?data:data.slice(0,limit);
  element.innerHTML=shown.length?`<ol>${shown.map(row=>{const share=total>0?row.value/total:0;return `<li><button type="button" data-distribution-key="${esc(row.key)}"><span class="ui-distribution-copy"><strong>${esc(row.label)}</strong><span>${esc(row.valueText??format(row.value))} · ${(share*100).toLocaleString(undefined,{maximumFractionDigits:1})}%</span></span><span class="ui-distribution-track" aria-hidden="true"><span style="width:${share*100}%"></span></span></button></li>`;}).join('')}</ol>${data.length>limit?`<button type="button" class="text-button" data-distribution-expand aria-expanded="${expanded}">${expanded?'收起':'展开全部 '+data.length+' 项'}</button>`:''}`:'<p class="proxy-hint">当前范围暂无数据</p>';
 }
 const controller=new AbortController();
 element.addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;if(button.hasAttribute('data-distribution-expand')){expanded=!expanded;paint();element.querySelector('[data-distribution-expand]')?.focus({preventScroll:true});}else onSelect(button.dataset.distributionKey);},{signal:controller.signal});
 return{element,update(rows){data=rows.filter(row=>Number.isFinite(row.value)&&row.value>=0);paint();},dispose(){controller.abort();element.remove();}};
}
