const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function modelGroups(models,row,{open=false,selected=m=>m.enabled!==false}={}) {
  const enabled=models.map((m,i)=>({m,i})).filter(({m})=>selected(m));
  const disabled=models.map((m,i)=>({m,i})).filter(({m})=>!selected(m));
  return enabled.map(({m,i})=>row(m,i)).join('')+(disabled.length?`<details class="proxy-disabled-models" ${open?'open':''}><summary>未启用模型 <span>${disabled.length}</span></summary>${disabled.map(({m,i})=>row(m,i)).join('')}</details>`:'');
}

export function modelHeading(m,selection){
 return `<div class="proxy-model-heading"><div>${esc(m.displayName||m.upstreamId||m.id)}<small>${esc(m.id)}</small></div><label class="proxy-checkbox ui-first-line-slot">${selection}启用</label></div>`;
}
