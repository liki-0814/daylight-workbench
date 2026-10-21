import {createProxyApi} from './proxy/api.js';
import {createProxyState} from './proxy/state.js';
import {createServicePanel} from './proxy/service-panel.js';
import {createSourcePage} from './proxy/source-page.js';
import {createCustomPage} from './proxy/custom-sources.js';
import {createRoutesPage} from './model-routes.js';
import {createQuotaPage} from './proxy/quota-panel.js';
import {createSourceNavigation,proxyTabs} from './proxy/source-navigation.js';

export function createProxyPage({getToken}){
 const root=document.createElement('main');root.id='proxy-page';root.className='proxy-page';root.hidden=true;
 root.innerHTML=`<header class="topbar"><span>我的工作空间 <span class="slash">/</span> 反向代理</span></header><div class="workspace proxy-heading"><section class="page-heading"><div><h1>反向代理</h1><p>一个地址，连接你的模型</p></div></section></div>`;
 const api=createProxyApi(getToken),store=createProxyState(api);let selected='qoder',visible=false,settingsVisible=false,timer,disposed=false;
 const service=createServicePanel({store,getExampleModel:()=>pages[selected].getModel?.()});
 const pages=Object.fromEntries(proxyTabs.filter(tab=>tab.kind==='provider').map(({id:source,name})=>[source,createSourcePage({store,source,name,confirmAction:service.confirmAction})]));
 pages.custom=createCustomPage({store,onRoutes:()=>select('routes')});pages.routes=createRoutesPage({api});
 pages.quota=createQuotaPage({store});
 const navigation=createSourceNavigation({api,onChange({selected:source,ready}){selected=source;for(const [name,page] of Object.entries(pages))page.setVisible(visible&&ready&&name===source);}});
 root.querySelector('.proxy-heading').append(service.element,navigation.element);for(const page of Object.values(pages))root.append(page.element);
 async function refresh(){if(disposed||!(visible||settingsVisible)||document.hidden||!getToken())return;await store.refresh();await store.pollLogins();}
 function select(source){navigation.select(source);}
 const updatePolling=()=>{clearInterval(timer);if(!document.hidden&&(visible||settingsVisible)){void refresh();timer=setInterval(refresh,3000);}};
 const onVisibility=()=>{if(document.hidden)service.hideKey();updatePolling();};document.addEventListener('visibilitychange',onVisibility);
 return{element:root,settingsElement:service.settingsElement,setSettingsVisible(value){if(settingsVisible===value)return;settingsVisible=value;updatePolling();},setVisible(value){visible=value;root.hidden=!value;select(selected);if(value)void navigation.load();else service.hideKey();updatePolling();},dispose(){disposed=true;clearInterval(timer);document.removeEventListener('visibilitychange',onVisibility);navigation.dispose();service.dispose();for(const page of Object.values(pages))page.dispose?.();store.dispose();}};
}
