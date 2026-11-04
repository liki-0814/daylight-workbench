import {refreshButton,setRefreshState} from '../components/section.js';
import {actionButton} from '../components/button.js';
import {createModelList} from './model-list.js';
import {createMediaModels} from '../components/media-models.js';

export function createSourcePage({store,source,name,confirmAction}){
 const root=document.createElement('section');root.id='proxy-panel-'+source;root.className='proxy-provider-page';root.hidden=true;root.setAttribute('role','tabpanel');root.setAttribute('aria-labelledby','proxy-tab-'+source);
 root.innerHTML=`<div class="workspace proxy-workspace"><section class="proxy-panel" aria-label="账号"><div class="proxy-account"><div class="proxy-account-info"><span class="proxy-caption" data-caption></span><span data-account>正在读取…</span></div><div class="proxy-account-actions">${refreshButton({label:'刷新登录',attrs:{'data-refresh-account':true,hidden:true}})}${actionButton({variant:'text',label:'修复凭证访问',attrs:{'data-repair':true,hidden:true}})}${actionButton({variant:'text',label:'重新登录',attrs:{'data-relogin':true,hidden:true}})}${actionButton({variant:'text',attrs:{'data-action':true,hidden:true}})}${actionButton({variant:'text',label:'取消操作',attrs:{'data-cancel-operation':true,hidden:true}})}</div></div><p class="proxy-error" role="alert" data-error hidden></p><p class="proxy-account-notice" role="status" data-notice hidden></p><div class="proxy-login" data-login hidden><p data-login-note>在浏览器中完成授权，此页会自动更新。</p><p data-login-code hidden></p><a data-login-link rel="noreferrer" target="_blank">打开登录页面 ↗</a>${actionButton({variant:'text',label:'取消',attrs:{'data-cancel':true}})}</div></section></div>`;
 const $=s=>root.querySelector(s),workspace=$('.workspace'),models=createModelList({store,source}),media=createMediaModels({source,appearance:'panel',load:refresh=>store.resource(source,'media-models',{refresh}),save:input=>store.setMediaModel(source,input)});workspace.append(models.element,media.element);
 let localError='';let actionEpoch=0;let visible=false,busy=false,activeOperation='',identity,revision,disposed=false;
 function error(message=''){localError=message;$('[data-error]').textContent=message;$('[data-error]').hidden=!message;}
 function paint(){
  if(disposed)return;const focusBefore=document.activeElement;const description=store.source(source),status=store.status,authentication=description?.authentication||{operations:[]},ops=authentication.operations,connected=status?.sources?.[source]?.connected||false;
  $('[data-caption]').textContent=(description?.name||name)+' 账号';
  const account=description?.account||(authentication.requiresStoppedService?status?.account:undefined);
  $('[data-account]').textContent=account?[account.login,account.organization,account.uid].filter(Boolean).join(' · '):(!description?.configured&&authentication.instruction)||status?.sources?.[source]?.error||description?.error?.hint||(connected?'已连接 '+(description?.name||name):authentication.instruction||'尚未连接 · 请登录后刷新');
  const identityKey=description?.identityKey,nextRevision=description?.revision,revisionChanged=revision!==nextRevision;revision=nextRevision;
  if(identity!==identityKey){identity=identityKey;models.reset();media.reset();if(visible){models.setVisible(true);media.setVisible(true);}}
  else if(revisionChanged&&visible){models.refreshIfOpen();void media.refresh();}
  const locked=authentication.requiresStoppedService&&status?.state!=='stopped',action=$('[data-action]');
  const operation=account&&ops.includes('logout')?'logout':!connected&&ops.includes('login')?'login':null;
  action.hidden=!operation;action.dataset.operation=operation||'';
  action.textContent=operation==='logout'?'退出账号':description?.credentialRecovery?'重新登录':authentication.loginLabel||'网页登录';action.disabled=locked||busy||!description||!!status?.runtimeError;action.title=locked?'请先停止代理，再更换或退出账号':'';
  const cancelOperation=$('[data-cancel-operation]');cancelOperation.textContent='取消操作';cancelOperation.hidden=!busy||!ops.includes('cancel');
  const recovery=description?.credentialRecovery,repair=$('[data-repair]'),relogin=$('[data-relogin]');
  repair.textContent=activeOperation==='repair'?'正在验证凭证…':'修复凭证访问';repair.hidden=!recovery||!ops.includes('repair');repair.disabled=busy||!!status?.runtimeError;
  relogin.textContent='重新登录';relogin.hidden=!ops.includes('login')||!account;relogin.disabled=locked||busy||!!status?.runtimeError;
  const notice=activeOperation==='repair'?'请完成系统钥匙串授权，正在验证后台访问…':store.authNotice?.(source),message=localError||(!busy&&recovery?.message)||'';
  $('[data-error]').textContent=message;$('[data-error]').hidden=!message;
  $('[data-notice]').textContent=notice||'';$('[data-notice]').hidden=!notice;
  const refresh=$('[data-refresh-account]');refresh.hidden=!ops.includes('refresh');setRefreshState(refresh,{loading:busy,disabled:busy||!!status?.runtimeError});
  const login=store.login(source);$('[data-login]').hidden=!login;
  if(login){const expires=login.expiresAt>1e12?login.expiresAt:login.expiresAt*1000,expired=Number.isFinite(expires)&&Date.now()>=expires;
   $('[data-login-link]').href=login.url;$('[data-login-link]').hidden=expired||!!login.terminal;$('[data-login-code]').hidden=!login.userCode&&!expired;$('[data-login-code]').textContent=expired?'授权已过期，请取消后重新登录。':login.userCode?'授权码：'+login.userCode:'';$('[data-login-note]').textContent=login.error||'点击下方链接，在浏览器中完成授权，此页会自动更新。';
  }
  if(visible&&root.contains(focusBefore)&&focusBefore.closest('[hidden]')){const target=action.hidden?refresh:action;if(!target.disabled&&!target.closest('[hidden]'))target.focus();}
 }
 async function run(operation){if(busy&&operation!=='cancel')return;const epoch=++actionEpoch;
  if(operation==='logout'&&!await confirmAction('退出账号？','将删除本机保存的登录凭证。重新登录后可继续使用代理。','退出账号'))return;
  const trigger=document.activeElement;
  busy=true;activeOperation=operation;error();paint();try{const result=await store.auth(source,operation);if(epoch!==actionEpoch)return;if(operation==='repair'&&(result?.credentialRepaired!==true||store.source(source)?.credentialRecovery))error(result?.credentialRepaired===false?result.error||'凭证访问未恢复，可重新登录':store.source(source)?.credentialRecovery?.message||'未完成后台读取验证，请重试修复或重新登录');if(result?.connected===false&&!result?.authorized&&operation!=='repair')error('凭证已保留，连接检测失败：'+result.error);if(result?.warning)error(result.warning);if(operation==='logout'){models.reset();media.reset();}if(visible){models.refreshIfOpen(operation==='refresh');media.setVisible(true);}if(store.login(source))$('[data-login-link]').focus();}
  catch(e){if(epoch===actionEpoch)error(e.message);}finally{if(epoch!==actionEpoch)return;busy=false;activeOperation='';paint();if(visible&&(document.activeElement===document.body||root.contains(document.activeElement)&&document.activeElement.closest('[hidden]'))){const target=root.contains(trigger)&&!trigger.disabled&&!trigger.closest('[hidden]')?trigger:$('[data-action]');if(!target.disabled&&!target.closest('[hidden]'))target.focus();}}
 }
 $('[data-cancel-operation]').onclick=()=>{void run('cancel');};
 $('[data-repair]').onclick=()=>{void run('repair');};$('[data-relogin]').onclick=()=>{void run('login');};
 $('[data-action]').onclick=()=>{void run($('[data-action]').dataset.operation);};$('[data-refresh-account]').onclick=()=>{void run('refresh');};$('[data-cancel]').onclick=()=>{void run('cancel');};
 const unsubscribe=store.subscribe(paint);paint();
 return{element:root,getModel:models.getModel,setVisible(value){visible=value;root.hidden=!value;models.setVisible(value);media.setVisible(value);if(!value){store.cancel(source);root.querySelectorAll('workbench-select').forEach(select=>select.setOpen(false));}paint();},dispose(){disposed=true;unsubscribe();models.dispose();media.dispose();}};
}
