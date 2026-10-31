// 反向代理页顶部：状态卡（四态）+ 配置卡 + 接入卡。全部由 0.8 组件库拼装，用 morph 增量更新（焦点停在开关上不动）。
// 行为约定：开关乐观切换（100ms 内出反馈）；状态变化写进 role="status"；失败走 role="alert"；配置在任何状态下都可改。
import {morph} from '../ui/core/morph.js';
import {html,trusted,slot} from '../ui/core/html.js';
import {serviceHero} from '../ui/patterns/service-status/service-status.js';
import {settingsGroup,settingsRow,settingsReadout} from '../ui/patterns/settings/settings.js';
import {input} from '../ui/components/input/input.js';
import {select} from '../ui/components/select/select.js';
import {switchControl} from '../ui/components/switch/switch.js';
import {button} from '../ui/components/button/button.js';
import {createDialogShell} from '../components/dialog-shell.js';
import {saveProxySetting} from '../pages/proxy-settings-actions.js';
import {START_SLOW_MS,heroProps,viewState,portHint,validPort} from '../pages/proxy-service-view.js';

const protocols=[{value:'chat',label:'Chat Completions'},{value:'responses',label:'Responses'},{value:'messages',label:'Anthropic Messages'}];
const MASK='••••••••••••••••';

export function createServicePanel({store,getExampleModel,onViewLogs=()=>{}}){
 const element=document.createElement('div');element.className='workspace proxy-common';
 element.innerHTML='<section class="px-service" aria-label="代理服务"><div data-slot="body"></div></section>';
 const host=element.querySelector('[data-slot="body"]');
 const local={pending:'',slow:false,announce:'',portDraft:null,portError:'',protocol:'chat',keyVisible:false,key:'',keyError:'',copied:{},check:'',checking:false,today:undefined,todayAt:0,message:'',shown:'',cancelling:false};
 let keyLoading,disposed=false,slowTimer=0,startingSince=0,announced='';
 const status=()=>store.status;
 const sourcesSummary=()=>{const enabled=store.sources.filter(source=>source.enabled);return enabled.length?{total:enabled.length,available:enabled.filter(source=>source.state==='ready').length}:undefined;};

 const hostOf=url=>url.replace(/^https?:\/\//,'').replace(/\/v1$/,'');
 function stateNow(){return viewState(status(),local.pending);}
 function actions(props){
  const error=props.error;if(!error)return props;
  const alternate=error.alternate?button({label:`改用 ${error.alternate}`,variant:'ghost',attrs:{'data-action':'use-port','data-port':String(error.alternate)}}):'';
  return {...props,error:{what:error.what,why:error.why,todo:error.todo,actions:html`${button({label:'重试',attrs:{'data-action':'retry'}})}${alternate}${button({label:'查看日志',variant:'ghost',attrs:{'data-action':'view-logs'}})}`}};
 }
 function baseUrl(){const url=status()?.baseUrl||'';return local.protocol==='messages'?url.replace(/\/v1$/,''):url;}
 function view(){
  const current=status(),state=stateNow(),running=current?.state==='running'&&!local.pending;
  const props=actions(heroProps({status:current,pending:local.pending,slow:local.slow,sources:sourcesSummary(),today:local.today,announce:local.announce}));
  const portValue=local.portDraft??String(current?.port??4319);
  const config=settingsGroup({title:'',key:'config',flush:true,rows:[
   settingsRow({key:'port',label:'本机端口',hint:local.portError||portHint(state,{slow:local.slow}),hintTone:local.portError?'error':undefined,control:input({name:'port',value:portValue,label:'本机端口',type:'number',mono:true,invalid:!!local.portError,attrs:{min:'1024',max:'65535',inputmode:'numeric'}})}),
   settingsRow({key:'autoStart',label:'随 Daylight 启动',hint:'关闭窗口后继续运行，退出 Daylight 时停止',control:switchControl({name:'autoStart',checked:!!current?.autoStart,label:'随 Daylight 启动代理'})}),
  ]});
  const keyReady=!!local.key,unavailable=!!current?.runtimeError;
  const connect=settingsGroup({title:'接入配置',key:'connect',flush:true,rows:[
   settingsRow({key:'protocol',label:'客户端协议',hint:'决定下面的 Base URL 与请求示例',control:select({name:'protocol',value:local.protocol,label:'客户端协议',options:protocols})}),
   settingsRow({key:'base',label:'Base URL',control:html`${settingsReadout({text:baseUrl()||'正在读取…',mono:true,attrs:{'data-copy-source':''}})}${button({label:local.copied.url?'已复制':'复制',variant:'ghost',disabled:!baseUrl(),attrs:{'data-action':'copy-url'}})}`}),
   settingsRow({key:'apikey',label:'API Key',hint:local.keyError||(keyReady?'':'正在读取…'),hintTone:local.keyError?'error':undefined,control:html`${settingsReadout({text:local.keyVisible&&keyReady?local.key:MASK,mono:true,attrs:{'data-key-readout':''}})}${button({label:local.keyVisible?'隐藏':'显示',variant:'ghost',disabled:!keyReady,attrs:{'data-action':'toggle-key'}})}${button({label:local.copied.key?'已复制':'复制',variant:'ghost',disabled:!keyReady,attrs:{'data-action':'copy-key'}})}`}),
   settingsRow({key:'example',label:'请求示例',hint:'curl，含当前协议、Base URL 与模型',control:button({label:local.copied.example?'已复制':'复制请求示例',disabled:!keyReady||unavailable,attrs:{'data-action':'copy-example'}})}),
   settingsRow({key:'check',label:'连接测试',hint:html`<span role="status">${local.check||'开启代理后，验证本机接口、鉴权与模型目录'}</span>`,control:button({label:local.checking?'测试中…':'测试连接',disabled:!running||local.checking,busy:local.checking,attrs:{'data-action':'test-connection'}})}),
  ]});
  return html`<div class="px-hero" data-key="hero">${serviceHero(props)}</div>${(local.message||store.error)?html`<p class="px-message" role="alert" data-key="message">${local.message||store.error}</p>`:''}<div class="px-config" data-key="config">${config}</div><div class="px-connect" data-key="connect">${connect}</div>`;
 }
 function sync(){
  // 开关的 aria-checked 由组件自己维护（morph 不覆盖），所以状态来自服务端 / 回滚时在这里写回。
  const state=stateNow(),on=state==='running'||state==='starting';
  const hero=host.querySelector('.dl-hero__switch .dl-switch');if(hero&&hero.getAttribute('aria-checked')!==String(on))hero.setAttribute('aria-checked',String(on));
  const auto=host.querySelector('.dl-switch[data-name="autoStart"]');if(auto&&auto.getAttribute('aria-checked')!==String(!!status()?.autoStart))auto.setAttribute('aria-checked',String(!!status()?.autoStart));
  const live=host.querySelector('.dl-hero [role="status"]');if(live&&live.textContent!==local.announce)live.textContent=local.announce;
 }
 function tick(){
  const state=stateNow();
  if(state==='starting'){if(!startingSince){startingSince=Date.now();clearTimeout(slowTimer);slowTimer=setTimeout(()=>{if(stateNow()==='starting'){local.slow=true;paint();}},START_SLOW_MS);}}
  else if(startingSince||local.slow){startingSince=0;local.slow=false;clearTimeout(slowTimer);}
  if(state!==announced){
   if(announced){const addr=hostOf(status()?.baseUrl||'');local.announce=state==='running'?`反向代理已启用，地址 ${addr}`:state==='starting'?'正在启动反向代理…':state==='error'?'反向代理启动失败':'反向代理已停用';}
   announced=state;
  }
  if(state==='running'&&Date.now()-local.todayAt>15000){local.todayAt=Date.now();void loadToday();}
 }
 async function loadToday(){try{const report=await store.api.request('statistics');const n=report?.summary?.requests;local.today=Number.isFinite(n)?n:undefined;}catch{local.today=undefined;}if(!disposed)paint();}
 function paint(){
  if(disposed)return;
  tick();
  if(status()||store.error||local.message)morph(host,view());
  sync();
  if(status()&&!local.key&&!status().runtimeError&&!keyLoading)void loadKey().catch(e=>{local.keyError=e.message;paint();});
 }
 async function loadKey(){
  if(keyLoading)return keyLoading;
  keyLoading=store.api.request('key').then(result=>{if(disposed)return;local.key=result.apiKey;local.keyError='';paint();}).finally(()=>{keyLoading=null;});return keyLoading;
 }
 async function copy(id,value){
  try{await navigator.clipboard.writeText(value);local.copied[id]=true;paint();setTimeout(()=>{delete local.copied[id];paint();},1600);}
  catch{local.message='复制未完成，请选中内容后手动复制。';paint();}
 }
 let confirmResolve;
 const confirm=createDialogShell({title:'确认操作',onClose(){confirmResolve?.(false);confirmResolve=null;}});
 function confirmAction(title,message,label){return new Promise(resolve=>{
  if(confirmResolve){resolve(false);return;}
  confirm.element.querySelector('h2').textContent=title;
  const description=document.createElement('p');description.textContent=message;
  const actions=document.createElement('div');actions.className='dialog-footer';actions.innerHTML='<button type="button" class="secondary" data-confirm-cancel>取消</button><button type="button" class="primary" data-confirm-ok></button>';
  actions.querySelector('[data-confirm-ok]').textContent=label;const content=document.createElement('div');content.append(description,actions);confirm.setContent(content);
  const finish=value=>{confirmResolve=null;resolve(value);confirm.close();};actions.querySelector('[data-confirm-cancel]').onclick=()=>finish(false);actions.querySelector('[data-confirm-ok]').onclick=()=>finish(true);
  if(!confirm.open()){resolve(false);return;}confirmResolve=resolve;actions.querySelector('[data-confirm-cancel]').focus();
 });}

 async function setService(enabled,force=false){
  local.message='';local.pending=enabled?'starting':'stopping';paint();
  try{await store.api.request('service',{enabled,force});}
  catch(e){if(!/已取消启动/.test(e.message))local.message=enabled?'':e.message;}
  finally{await store.refresh();local.pending='';local.cancelling=false;paint();}
 }
 async function toggle(enabled){
  if(!status()||local.pending)return paint();
  if(!enabled&&status().activeRequests){
   const force=await confirmAction('停止代理？',`将中断 ${status().activeRequests} 个正在进行的请求。`,'停止代理');
   if(!force)return paint();return setService(false,true);
  }
  return setService(enabled);
 }
 async function savePort(raw){
  const text=String(raw).trim();
  if(!validPort(text)){local.portDraft=text;local.portError='端口需为 1024–65535 的整数';return paint();}
  local.portDraft=null;local.portError='';
  if(Number(text)===status()?.port)return paint();
  if(status()?.state==='running')local.pending='starting'; // 运行中改端口 = 自动重启，先给「启动中」的反馈
  paint();
  const failure=await saveProxySetting(store,'port',Number(text));
  if(failure&&!/已被占用/.test(failure))local.portError=failure; // 端口被占用时，状态卡会显示「启动失败」三段话
  local.pending='';paint();
 }
 async function saveAutoStart(value){
  local.message=await saveProxySetting(store,'autoStart',value);paint();
 }
 function example(){
  const protocol=local.protocol,model=getExampleModel()||'替换为模型 ID',body=protocol==='responses'?{model,input:'你好',stream:true}:{model,messages:[{role:'user',content:'你好'}],...(protocol==='messages'?{max_tokens:1024}:{}),stream:true};
  const route={chat:'/chat/completions',responses:'/responses',messages:'/messages'}[protocol],quote=value=>`'${value.replaceAll("'","'\\''")}'`;
  return `curl -N ${quote(status().baseUrl+route)} \\\n  -H ${quote(`Authorization: Bearer ${local.key}`)} \\\n  -H 'Content-Type: application/json' \\\n  -d ${quote(JSON.stringify(body))}`;
 }
 element.addEventListener('ui:change',event=>{
  const target=event.target,name=target.dataset?.name||target.name||target.closest?.('[data-name]')?.dataset.name;
  if(target.closest('.dl-hero')&&target.classList.contains('dl-switch')){void toggle(event.detail.value);return;}
  if(name==='port'){void savePort(event.detail.value);return;}
  if(name==='autoStart'){void saveAutoStart(event.detail.value);return;}
  if(name==='protocol'){local.protocol=String(event.detail.value);paint();}
 });
 element.addEventListener('click',async event=>{
  const control=event.target.closest?.('[data-action]');if(!control||!element.contains(control))return;
  const action=control.dataset.action;
  if(action==='copy-address')return copy('address',control.dataset.copy);
  if(action==='copy-url')return copy('url',baseUrl());
  if(action==='copy-key')return copy('key',local.key);
  if(action==='copy-example')return copy('example',example());
  if(action==='toggle-key'){local.keyVisible=!local.keyVisible;return paint();}
  if(action==='cancel-start'){if(local.cancelling)return;local.cancelling=true;try{await store.api.request('service/cancel',{});}catch(e){local.message=e.message;paint();}return;}
  if(action==='retry')return setService(true);
  if(action==='use-port'){await savePort(control.dataset.port);return setService(true);}
  if(action==='view-logs')return onViewLogs();
  if(action==='test-connection'){local.checking=true;local.check='正在验证本机接口、鉴权与模型目录…';paint();try{local.check=(await store.api.request('check',{})).message;}catch(e){local.check=e.message;}finally{local.checking=false;paint();}}
 });
 function hideKey(){if(local.keyVisible){local.keyVisible=false;paint();}}
 const unsubscribe=store.subscribe(paint);
 paint();
 return{element,hideKey,confirmAction,paint,dispose(){disposed=true;clearTimeout(slowTimer);unsubscribe();confirm.dispose();}};
}
