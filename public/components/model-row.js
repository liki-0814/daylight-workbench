const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function modelGroups(models,row,{open=false,selected=m=>m.enabled!==false}={}) {
  const enabled=models.map((m,i)=>({m,i})).filter(({m})=>selected(m));
  const disabled=models.map((m,i)=>({m,i})).filter(({m})=>!selected(m));
  return enabled.map(({m,i})=>row(m,i)).join('')+(disabled.length?`<details class="proxy-disabled-models" ${open?'open':''}><summary>未启用模型 <span>${disabled.length}</span></summary>${disabled.map(({m,i})=>row(m,i)).join('')}</details>`:'');
}

export function modelHeading(m,selection){
 return `<div class="proxy-model-heading"><div>${esc(m.displayName||m.upstreamId||m.id)}<small>${esc(m.id)}</small></div><label class="proxy-checkbox ui-first-line-slot">${selection}启用</label></div>`;
}

function scrollParent(element){
  for(let node=element.parentElement;node;node=node.parentElement){
    const{overflowY}=getComputedStyle(node);
    if(/(auto|scroll)/.test(overflowY)&&node.scrollHeight>node.clientHeight)return node;
  }
  return document.scrollingElement||document.documentElement;
}

// Rebuilding a model list moves a toggled row between the enabled list and the collapsed disabled group.
// Keep that row where the pointer left it and keep keyboard focus on its control, otherwise the page appears to jump.
export function repaintKeepingControl(list,selector,paint,{focus=false}={}){
  const before=list.querySelector(selector);
  if(!before){paint();return;}
  const top=before.getBoundingClientRect().top,hadFocus=focus||before===document.activeElement;
  paint();
  const after=list.querySelector(selector);
  if(!after)return;
  const delta=after.getBoundingClientRect().top-top;
  if(delta){const scroller=scrollParent(after);scroller.scrollTop+=delta;}
  if(hadFocus)after.focus({preventScroll:true});
}
