import {icon} from './icons.js';
export function createProxyDrawer(root) {
 const dialog=document.createElement('dialog');dialog.className='proxy-drawer';root.append(dialog);
 let dirty=false,busy=false,opener,previousOverflow,closing=false,closeTimer;
 const confirmation=document.createElement('dialog');confirmation.className='proxy-discard';confirmation.innerHTML='<div class="dialog-header"><h2>放弃未保存的修改？</h2></div><div class="form-body"><p class="field-note">关闭后，这次修改不会保存。</p></div><div class="dialog-footer"><button type="button" class="secondary" data-continue>继续编辑</button><button type="button" class="primary" data-discard>放弃修改</button></div>';root.append(confirmation);
 const actionConfirmation=document.createElement('dialog');actionConfirmation.className='proxy-discard';actionConfirmation.setAttribute('aria-labelledby',root.id+'-action-title');actionConfirmation.innerHTML='<div class="dialog-header"><h2></h2></div><div class="form-body"><p class="field-note"></p></div><div class="dialog-footer"><button type="button" class="secondary" data-action-cancel>取消</button><button type="button" class="primary" data-action-confirm>删除来源</button></div>';actionConfirmation.querySelector('h2').id=root.id+'-action-title';root.append(actionConfirmation);
 let settleAction;
 function completeAction(value){actionConfirmation.close();const resolve=settleAction;settleAction=null;resolve?.(value);}
 actionConfirmation.addEventListener('cancel',event=>{event.preventDefault();completeAction(false);});
 actionConfirmation.querySelector('[data-action-cancel]').onclick=()=>completeAction(false);
 actionConfirmation.querySelector('[data-action-confirm]').onclick=()=>completeAction(true);
 function confirmAction({title,message}){if(settleAction||busy||closing)return Promise.resolve(false);actionConfirmation.querySelector('h2').textContent=title;actionConfirmation.querySelector('p').textContent=message;return new Promise(resolve=>{settleAction=resolve;actionConfirmation.showModal();actionConfirmation.querySelector('[data-action-cancel]').focus();});}
 function finishClose(){completeAction(false);clearTimeout(closeTimer);dialog.classList.remove('is-closing');closing=false;confirmation.close();dialog.close();document.body.style.overflow=previousOverflow;dirty=false;const target=typeof opener==='function'?opener():opener;target?.focus();root.querySelectorAll('[data-editing]').forEach(row=>row.removeAttribute('data-editing'));}
 function close(){if(!dialog.open||closing)return;confirmation.close();if(matchMedia('(prefers-reduced-motion: reduce)').matches){finishClose();return;}closing=true;dialog.classList.add('is-closing');closeTimer=setTimeout(finishClose,180);}
 dialog.addEventListener('animationend',event=>{if(event.target===dialog&&closing)finishClose();});
 function requestClose(){if(busy||closing)return;if(dirty)confirmation.showModal();else close();}
 dialog.addEventListener('cancel',event=>{event.preventDefault();requestClose();});
 dialog.addEventListener('click',event=>{const r=dialog.getBoundingClientRect();if(event.target===dialog&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom))requestClose();});
 dialog.addEventListener('input',()=>{dirty=true;});dialog.addEventListener('change',()=>{dirty=true;});
 confirmation.querySelector('[data-continue]').onclick=()=>confirmation.close();confirmation.querySelector('[data-discard]').onclick=close;
 return {element:dialog,open(html,{titleId,returnFocus}={}){if(closing)finishClose();if(dialog.open)return;dialog.innerHTML=html;dialog.setAttribute('aria-labelledby',titleId);opener=returnFocus || document.activeElement;dirty=false;busy=false;previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';dialog.showModal();const closeButton=dialog.querySelector('[data-close]');closeButton.className='icon-button';closeButton.innerHTML=icon('close');closeButton.onclick=requestClose;},markDirty(){dirty=true;},setBusy(value){busy=value;},close,requestClose,confirmAction};
}
