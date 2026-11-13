import {proxySources} from '../core/proxy-sources.js';
import {actionButton} from './components/button.js';
import {createProxyApi} from './proxy/api.js';
import {createProxyState} from './proxy/state.js';
import {createServicePanel} from './proxy/service-panel.js';
import {createSourcePage} from './proxy/source-page.js';
import {createCustomPage} from './proxy/custom-sources.js';
import {createRoutesPage} from './model-routes.js';
import {createStatisticsPage} from './proxy/statistics-page.js';
import {createQuotaPage} from './proxy/quota-panel.js';
import {createSourceCards} from './proxy/source-cards.js';

export function createProxyPage({getToken}){
 const root=document.createElement('main');root.id='proxy-page';root.className='proxy-page';root.hidden=true;
 root.innerHTML=`<header class="topbar"><span>我的工作空间 <span class="slash">/</span> 反向代理</span></header><div class="workspace proxy-heading"><section class="page-heading"><div><h1>反向代理</h1></div></section></div>`;
 const api=createProxyApi(getToken),store=createProxyState(api);let selected=null,visible=false,settingsVisible=false,timer,disposed=false;
 const service=createServicePanel({store,getExampleModel:()=>pages[selected]?.getModel?.(),onOpenPage:id=>openTool(id)});
 const pages=Object.fromEntries(proxySources.filter(source=>source.kind==='provider').map(({id:source,name})=>[source,createSourcePage({store,source,name,confirmAction:service.confirmAction})]));
 const board=createSourceCards({store,onChange({page:source}){if(tools.has(selected))closeTool();select(source);}});
 pages.custom=createCustomPage({store,onRoutes:()=>openTool('routes')});pages.routes=createRoutesPage({api});
 pages.quota=createQuotaPage({store});pages.statistics=createStatisticsPage({api,store});
 const tools=new Set(['custom','routes','quota','statistics']);
 const back=document.createElement('div');back.innerHTML=actionButton({variant:'secondary',label:'返回来源',attrs:{'data-leave-tool':true,hidden:true}});
 const backButton=back.firstElementChild;root.querySelector('.page-heading').append(backButton);
 root.querySelector('.proxy-heading').append(service.element,board.element);for(const page of Object.values(pages))root.append(page.element);
 async function refresh(){if(disposed||!(visible||settingsVisible)||document.hidden||!getToken())return;await store.refresh();await store.pollLogins();}
 function markTools(){for(const button of service.element.querySelectorAll('[data-open-page]'))button.setAttribute('aria-pressed',String(button.dataset.openPage===selected));}
 function select(source){selected=source;for(const [name,page] of Object.entries(pages))if(!tools.has(name))page.setVisible(visible&&name===source);markTools();}
 function showConnect(value){const details=service.element.querySelector('#proxy-connect-details');if(details)details.hidden=!value;}
 function closeTool(){if(tools.has(selected)){pages[selected].setVisible(false);selected=null;}board.element.hidden=false;backButton.hidden=true;showConnect(true);markTools();}
 function openTool(id){if(!pages[id])return;if(selected===id){closeTool();return;}if(tools.has(selected))pages[selected].setVisible(false);board.element.hidden=true;pages[id].setVisible(true);selected=id;backButton.hidden=false;showConnect(false);markTools();}
 backButton.onclick=()=>closeTool();
 const updatePolling=()=>{clearInterval(timer);if(!document.hidden&&(visible||settingsVisible)){void refresh();timer=setInterval(refresh,3000);}};
 const onVisibility=()=>{if(document.hidden)service.hideKey();updatePolling();};document.addEventListener('visibilitychange',onVisibility);
 return{element:root,settingsElement:service.settingsElement,setSettingsVisible(value){if(settingsVisible===value)return;settingsVisible=value;updatePolling();},setVisible(value){visible=value;root.hidden=!value;select(selected);if(value)board.refresh();else service.hideKey();updatePolling();},dispose(){disposed=true;clearInterval(timer);document.removeEventListener('visibilitychange',onVisibility);board.dispose();service.dispose();for(const page of Object.values(pages))page.dispose?.();store.dispose();}};
}
