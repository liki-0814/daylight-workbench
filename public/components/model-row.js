const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// pins: Map(key -> group the row was in when it was last regrouped). A pinned row keeps that placement
// (marked "pending") so a toggle never moves it; pins are cleared on the next refresh / page entry.
export function modelGroups(models,row,{open=false,selected=m=>m.enabled!==false,pins,key=m=>m.id}={}) {
  const placed=m=>pins?.has(key(m))?pins.get(key(m)):selected(m);
  const all=models.map((m,i)=>({m,i,pending:!!pins?.has(key(m))}));
  const enabled=all.filter(({m})=>placed(m)),disabled=all.filter(({m})=>!placed(m));
  const html=({m,i,pending})=>row(m,i,{pending,selected:selected(m)});
  return enabled.map(html).join('')+(disabled.length?`<details class="proxy-disabled-models" ${open?'open':''}><summary>未启用模型 <span>${disabled.length}</span></summary>${disabled.map(html).join('')}</details>`:'');
}

// Record a toggle against the pins. `wasSelected` is the state before the click.
export function pinToggle(pins,k,wasSelected){if(pins.has(k))pins.delete(k);else pins.set(k,wasSelected);}

// Regroup: drop every pin and repaint. Called on page entry, refresh and browser-tab return. Returns whether anything moved.
export function regroupPins(pins,paint){if(!pins.size)return false;pins.clear();paint();return true;}

// Run `handler` whenever the browser tab becomes visible again. Returns an unsubscribe function.
export function onTabReturn(handler,doc=globalThis.document){
  if(!doc?.addEventListener)return()=>{};
  const listener=()=>{if(!doc.hidden)handler();};
  doc.addEventListener('visibilitychange',listener);
  return()=>doc.removeEventListener('visibilitychange',listener);
}

export function modelHeading(m,selection,{pending=false,selected=m.enabled!==false}={}){
 const note=pending?`<span class="proxy-pending" role="status">${selected?'已启用':'已停用'} · <button type="button" class="proxy-undo" aria-label="撤销${selected?'启用':'停用'} ${esc(m.id)}">撤销</button></span>`:'';
 return `<div class="proxy-model-heading${pending?' is-pending':''}"><div>${esc(m.displayName||m.upstreamId||m.id)}<small>${esc(m.id)}</small></div>${note}<label class="proxy-checkbox ui-first-line-slot">${selection}启用</label></div>`;
}

if(typeof document!=='undefined'&&!globalThis.__modelUndoBound){
  globalThis.__modelUndoBound=true;
  // Undo re-clicks the row's own checkbox, so every list handles it through its normal change path.
  document.addEventListener('click',event=>{
    const button=event.target.closest?.('.proxy-undo');if(!button)return;
    const box=button.closest('.proxy-model-heading')?.querySelector('input[type=checkbox]');
    if(box&&!box.disabled){box.click();box.focus({preventScroll:true});}
  });
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
