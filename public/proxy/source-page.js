import {refreshButton,setRefreshState} from '../components/section.js';
import {actionButton} from '../components/button.js';
import {createModelList} from './model-list.js';
import {createQuotaPanel} from './quota-panel.js';

export function createSourcePage({store,source,name,confirmAction}){
 const root=document.createElement('section');root.id='proxy-panel-'+source;root.className='proxy-provider-page';root.hidden=true;root.setAttribute('role','tabpanel');root.setAttribute('aria-labelledby','proxy-tab-'+source);
 root.innerHTML=`<div class="workspace proxy-workspace"><section class="proxy-panel" aria-label="账号"><div class="proxy-account"><div class="proxy-account-info"><span class="proxy-caption" data-caption></span><span data-account>正在读取…</span></div><div class="proxy-account-actions">${refreshButton({label:'刷新登录',attrs:{'data-refresh-account':true,hidden:true}})}${actionButton({variant:'text',attrs:{'data-action':true,hidden:true}})}</div></div><p class="proxy-error" role="alert" data-error hidden></p><div class="proxy-login" data-login hidden><p data-login-note>在浏览器中完成授权，此页会自动更新。</p><p data-login-code hidden></p><a data-login-link rel="noreferrer" target="_blank">打开登录页面 ↗</a><button class="text-button" data-cancel>取消</button></div></section></div>`;
 const $=s=>root.querySelector(s),workspace=$('.workspace'),models=createModelList({store,source}),quota=createQuotaPanel({store,source});workspace.append(models.element,quota.element);
 let visible=false,busy=false,identity,disposed=false;
 function error(message=''){$('[data-error]').textContent=message;$('[data-error]').hidden=!message;}
 function paint(){
  if(disposed)return;const description=store.source(source),status=store.status,authentication=description?.authentication||{operations:[]},ops=authentication.operations,connected=status?.sources?.[source]?.connected||false;
  $('[data-caption]').textContent=(description?.name||name)+' 账号';
  const account=authentication.requiresStoppedService?status?.account:undefined;
  $('[data-account]').textContent=status?.sources?.[source]?.error||description?.error?.hint||(account?[account.organization,account.uid].filter(Boolean).join(' · '):connected?'已连接本机 '+(description?.name||name):authentication.instruction||'尚未连接 · 请登录后刷新');
  const identityKey=description?.identityKey;if(identity!==identityKey){identity=identityKey;models.reset();quota.reset();if(visible){models.setVisible(true);quota.setVisible(true);}}
  quota.element.hidden=!description?.capabilities.quota;
  const locked=authentication.requiresStoppedService&&status?.state!=='stopped',action=$('[data-action]');
  const operation=account&&ops.includes('logout')?'logout':!connected&&ops.includes('login')?'login':null;
  action.hidden=locked||!operation;action.dataset.operation=operation||'';
  action.textContent=operation==='logout'?'退出账号':'网页登录';action.disabled=busy||!description||!!status?.runtimeError;
  const refresh=$('[data-refresh-account]');refresh.hidden=!ops.includes('refresh');setRefreshState(refresh,{loading:busy,disabled:busy||!!status?.runtimeError});
  const login=store.login(source);$('[data-login]').hidden=!login;
  if(login){const expires=login.expiresAt>1e12?login.expiresAt:login.expiresAt*1000,expired=Number.isFinite(expires)&&Date.now()>=expires;
   $('[data-login-link]').href=login.url;$('[data-login-link]').hidden=expired;$('[data-login-code]').hidden=!login.userCode&&!expired;$('[data-login-code]').textContent=expired?'授权已过期，请取消后重新登录。':login.userCode?'授权码：'+login.userCode:'';$('[data-login-note]').textContent=login.error||'点击下方链接，在浏览器中完成授权，此页会自动更新。';
  }
  quota.tick();
 }
 async function run(operation){if(busy)return;
  if(operation==='logout'&&!await confirmAction('退出账号？','将删除本机保存的登录凭证。重新登录后可继续使用代理。','退出账号'))return;
  const trigger=document.activeElement;
  busy=true;error();paint();try{const result=await store.auth(source,operation);if(result?.connected===false)error(result.error);if(operation==='logout')models.reset();if(visible){models.refreshIfOpen(operation==='refresh');quota.tick();}if(store.login(source))$('[data-login-link]').focus();}
  catch(e){error(e.message);}finally{busy=false;paint();if(visible&&root.contains(trigger)&&!trigger.disabled&&!trigger.closest('[hidden]')&&document.activeElement===document.body)trigger.focus();}
 }
 $('[data-action]').onclick=()=>{void run($('[data-action]').dataset.operation);};$('[data-refresh-account]').onclick=()=>{void run('refresh');};$('[data-cancel]').onclick=()=>{void run('cancel');};
 const unsubscribe=store.subscribe(paint);paint();
 return{element:root,getModel:models.getModel,setVisible(value){visible=value;root.hidden=!value;models.setVisible(value);quota.setVisible(value&&!!store.source(source)?.capabilities.quota);if(!value){store.cancel(source);root.querySelectorAll('workbench-select').forEach(select=>select.setOpen(false));}paint();},dispose(){disposed=true;unsubscribe();models.dispose();quota.dispose();}};
}
