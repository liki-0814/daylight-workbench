import {createDialogShell} from '../components/dialog-shell.js';
import {actionButton,escapeButtonText as esc} from '../components/button.js';
import {segmentedControl,mountSegmentedControl,setSegmentedValue,segmentKeyboardValue} from '../components/segmented-control.js';
import {proxySourceTabs} from '../../core/proxy-sources.js';

// One registration drives page creation, display choices and keyboard order.
export const proxyTabs=[
 ...proxySourceTabs,
 {id:'routes',name:'模型路由',kind:'utility'},
 {id:'quota',name:'账户额度',kind:'utility'},
 {id:'statistics',name:'使用统计',kind:'utility'},
];
export function visibleTabs(tabs,hiddenSources=[]){return tabs.filter(tab=>tab.kind==='utility'||!hiddenSources.includes(tab.id));}
export function resolveTab(tabs,selected){return tabs.some(tab=>tab.id===selected)?selected:tabs[0]?.id;}
export function keyboardTab(tabs,selected,key){return segmentKeyboardValue(tabs.map(tab=>({...tab,value:tab.id})),selected,key);}

export function createSourceNavigation({api,tabs=proxyTabs,onChange}){
 const element=document.createElement('div');element.className='proxy-navigation';
 element.innerHTML=`<div class="proxy-navigation-row">${segmentedControl({id:'proxy-source-tabs',label:'反向代理页面',value:tabs[0]?.id,mode:'tabs',className:'proxy-tabs',hidden:true,options:tabs.map(tab=>({value:tab.id,label:tab.name,id:'proxy-tab-'+tab.id,controls:'proxy-panel-'+tab.id}))})}${actionButton({label:'显示来源',attrs:{'data-source-display':true}})}</div><p class="proxy-hint sr-only" data-navigation-status role="status">正在读取来源显示设置…</p>`;
 const $=selector=>element.querySelector(selector),trigger=$('[data-source-display]'),tablist=$('[role=tablist]');
 const dialog=createDialogShell({title:'显示来源',description:'选择反向代理页面中显示的来源。隐藏只影响页面展示，不会停用转发、退出账号或删除配置。'});
 dialog.setContent(`<form data-display-form><fieldset class="proxy-source-choices" disabled><legend class="sr-only">显示的来源</legend>${tabs.filter(tab=>tab.kind!=='utility').map(tab=>`<label class="proxy-checkbox"><input type="checkbox" value="${esc(tab.id)}">${esc(tab.name)}</label>`).join('')}</fieldset><p class="proxy-hint">${tabs.filter(tab=>tab.kind==='utility').map(tab=>esc(tab.name)).join('、')}始终显示。</p><p class="proxy-error" data-display-error role="alert" hidden></p><p class="proxy-hint" data-display-status role="status"></p><div class="dialog-footer">${actionButton({label:'重新读取',attrs:{'data-display-reload':true,hidden:true}})}${actionButton({label:'全部显示',attrs:{'data-display-all':true,disabled:true}})}${actionButton({label:'保存',variant:'primary',attrs:{type:'submit','data-display-save':true,disabled:true}})}</div></form>`);
 const d=selector=>dialog.element.querySelector(selector),choices=[...dialog.element.querySelectorAll('input[type=checkbox]')];
 let snapshot,selected=tabs[0].id,ready=false,disposed=false,controller,pending,saving=false;
 const available=()=>visibleTabs(tabs,snapshot?.hiddenSources);
 function paint(){
  const active=document.activeElement,wasFocused=tablist.contains(active),shown=available();selected=resolveTab(shown,selected);
  for(const tab of tabs){const button=$('#proxy-tab-'+tab.id),visible=shown.includes(tab);button.hidden=!visible;}
  setSegmentedValue(tablist,selected);tablist.hidden=!ready;onChange({selected,ready});
  if(ready&&wasFocused&&active.hidden)$('#proxy-tab-'+selected)?.focus({preventScroll:true});
 }
 function select(id){selected=resolveTab(available(),id);paint();}
 function editable(value){d('fieldset').disabled=!value;d('[data-display-save]').disabled=!value;d('[data-display-all]').disabled=!value;}
 function fill(){for(const choice of choices)choice.checked=!snapshot.hiddenSources.includes(choice.value);}
 async function read(){
  if(disposed||saving)return;if(pending)return pending;controller=new AbortController();
  pending=(async()=>{
   try{
    const result=await api.request('view',undefined,{signal:controller.signal});if(disposed)return;
    snapshot=result;ready=true;paint();$('[data-navigation-status]').hidden=true;
    if(dialog.element.open){fill();editable(true);d('[data-display-status]').textContent='选择后保存，下次打开仍按此设置显示。';d('[data-display-error]').hidden=true;d('[data-display-reload]').hidden=true;}
   }catch(error){
    if(disposed||error.name==='AbortError')return;
    ready=true;paint();$('[data-navigation-status]').hidden=false;$('[data-navigation-status]').classList.remove('sr-only');$('[data-navigation-status]').textContent='来源显示设置读取失败，已保留当前显示；可在“显示来源”中重试。';
    if(dialog.element.open){editable(false);d('[data-display-error]').textContent=error.message;d('[data-display-error]').hidden=false;d('[data-display-reload]').hidden=false;d('[data-display-status]').textContent='读取成功后才能保存。';}
   }finally{pending=null;}
  })();return pending;
 }
 async function loadDialog(){if(saving)return;editable(false);d('[data-display-status]').textContent='正在读取已保存的设置…';d('[data-display-error]').hidden=true;d('[data-display-reload]').hidden=true;await read();}
 trigger.onclick=()=>{if(dialog.open())void loadDialog();};
 d('[data-display-reload]').onclick=()=>void loadDialog();
 d('[data-display-all]').onclick=()=>{for(const choice of choices)choice.checked=true;};
 d('[data-display-form]').onsubmit=async event=>{
  event.preventDefault();if(saving||d('[data-display-save]').disabled)return;
  saving=true;editable(false);dialog.setBusy(true);d('[data-display-error]').hidden=true;d('[data-display-status]').textContent='正在保存…';
  try{
   const managed=new Set(choices.map(choice=>choice.value));
   const hiddenSources=[...snapshot.hiddenSources.filter(id=>!managed.has(id)),...choices.filter(choice=>!choice.checked).map(choice=>choice.value)];
   const result=await api.request('view',{version:snapshot.version,hiddenSources},{signal:controller.signal});if(disposed)return;
   snapshot=result;paint();$('[data-navigation-status]').hidden=false;$('[data-navigation-status]').classList.add('sr-only');$('[data-navigation-status]').textContent='来源显示设置已保存';dialog.setBusy(false);dialog.close();
  }catch(error){if(!disposed&&error.name!=='AbortError'){d('[data-display-error]').textContent=error.message;d('[data-display-error]').hidden=false;d('[data-display-reload]').hidden=false;d('[data-display-status]').textContent='未保存，选择已保留。';}}
  finally{saving=false;if(!disposed){dialog.setBusy(false);editable(true);}}
 };
 const unmountTabs=mountSegmentedControl(tablist,{onChange:select});
 return{element,select,load:read,get ready(){return ready;},dispose(){disposed=true;controller?.abort();unmountTabs();dialog.dispose();}};
}
