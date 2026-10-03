import {createProxyApi} from './proxy/api.js';
import {createProxyState} from './proxy/state.js';
import {createServicePanel} from './proxy/service-panel.js';
import {createSourcePage} from './proxy/source-page.js';
import {createCustomPage} from './proxy/custom-sources.js';
import {createRoutesPage} from './model-routes.js';

export function createProxyPage({getToken}){
 const root=document.createElement('main');root.id='proxy-page';root.className='proxy-page';root.hidden=true;
 const tabs=[['qoder','Qoder'],['agy','AGY'],['grok','Grok'],['codex','Codex'],['kimi','Kimi'],['custom','自定义'],['routes','模型路由']];
 root.innerHTML=`<header class="topbar"><span>我的工作空间 <span class="slash">/</span> 反向代理</span></header><div class="workspace proxy-heading"><section class="page-heading"><div><h1>反向代理</h1><p>一个地址，连接你的模型</p></div></section><div class="proxy-tabs" role="tablist" aria-label="模型来源">${tabs.map(([id,name],i)=>`<button id="proxy-tab-${id}" role="tab" aria-controls="proxy-panel-${id}" aria-selected="${i===0}" tabindex="${i===0?0:-1}">${name}</button>`).join('')}</div></div>`;
 const api=createProxyApi(getToken),store=createProxyState(api);let selected='qoder',visible=false,timer,disposed=false;
 const service=createServicePanel({store,getExampleModel:()=>pages[selected].getModel?.()});
 const pages=Object.fromEntries(tabs.slice(0,5).map(([source,name])=>[source,createSourcePage({store,source,name,confirmAction:service.confirmAction})]));
 pages.custom=createCustomPage({store,onRoutes:()=>select('routes')});pages.routes=createRoutesPage({api});
 root.querySelector('.proxy-tabs').before(service.element);for(const page of Object.values(pages))root.append(page.element);root.append(service.footer);
 async function refresh(){if(disposed||!visible||document.hidden||!getToken())return;await store.refresh();await store.pollLogins();}
 function select(source){selected=source;for(const [name,page] of Object.entries(pages)){const button=root.querySelector('#proxy-tab-'+name);button.setAttribute('aria-selected',String(name===source));button.tabIndex=name===source?0:-1;page.setVisible(visible&&name===source);}}
 for(const [source] of tabs){const button=root.querySelector('#proxy-tab-'+source);button.onclick=()=>select(source);button.onkeydown=event=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const keys=Object.keys(pages),next=event.key==='Home'?keys[0]:event.key==='End'?keys.at(-1):keys[(keys.indexOf(selected)+(event.key==='ArrowRight'?1:keys.length-1))%keys.length];select(next);root.querySelector('#proxy-tab-'+next).focus();
 };}
 const onVisibility=()=>{clearInterval(timer);if(document.hidden)service.hideKey();else if(visible){void refresh();timer=setInterval(refresh,3000);}};document.addEventListener('visibilitychange',onVisibility);
 return{element:root,setVisible(value){visible=value;root.hidden=!value;select(selected);clearInterval(timer);if(value){void refresh();timer=setInterval(refresh,3000);}else service.hideKey();},dispose(){disposed=true;clearInterval(timer);document.removeEventListener('visibilitychange',onVisibility);service.dispose();for(const page of Object.values(pages))page.dispose?.();store.dispose();}};
}
