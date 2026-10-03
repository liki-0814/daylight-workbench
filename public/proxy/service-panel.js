import {disclosureSection,mountDisclosures} from '../components/section.js';
import {selectField} from '../components/select.js';
const template=`<div class="workspace proxy-common"><section class="proxy-panel" aria-label="代理服务">        <div class="proxy-service">
          <div><h2><span id="service-dot" class="proxy-dot"></span><span id="service-state">正在读取状态…</span></h2><p id="service-note">代理默认关闭，按需开启。</p></div>
          <button id="service-switch" class="proxy-switch" type="button" role="switch" aria-checked="false" aria-label="开启代理" disabled><span></span></button>
        </div>
        <div id="service-error" class="proxy-error" role="alert" hidden></div>
</section>      <section class="proxy-panel proxy-connect" aria-labelledby="connect-heading">
        <div class="proxy-section-title"><h2 id="connect-heading">接入配置</h2><div id="protocol-control" class="proxy-protocol"></div></div>
        <label class="proxy-caption" for="base-url">Base URL</label>
        <div class="proxy-copy"><input id="base-url" readonly value="正在读取…" spellcheck="false"><button id="copy-url" class="small-button" disabled>复制</button></div>
        <label class="proxy-caption" for="api-key">API Key</label>
        <div class="proxy-copy"><input id="api-key" type="password" readonly value="" placeholder="正在读取…" autocomplete="off" spellcheck="false"><button id="show-key" class="small-button" disabled>显示</button><button id="copy-key" class="small-button" disabled>复制</button></div>
        <div class="proxy-connect-actions"><button id="copy-example" class="secondary" disabled>复制请求示例</button><button id="test-connection" class="text-button" disabled>测试连接</button></div>
        <p id="connection-result" class="proxy-hint" role="status">开启代理后，即可在客户端中填写以上地址与密钥。</p>
      </section>
<dialog id="proxy-confirm" aria-labelledby="confirm-title"><div class="dialog-header"><h2 id="confirm-title"></h2></div><div class="form-body"><p id="confirm-message"></p></div><div class="dialog-footer"><button id="confirm-cancel" class="secondary">取消</button><button id="confirm-ok" class="primary">确认</button></div></dialog></div>`;
const settingsTemplate=`${disclosureSection({id:'settings-details',className:'proxy-disclosure',title:'设置',description:'端口与自动启动',content:`<form id="settings-form" class="proxy-settings-form">
        <p id="settings-readonly" class="proxy-hint ui-feedback-row" hidden></p>
        <div id="settings-edit" hidden>
        <label class="proxy-field">本机端口<input id="proxy-port" type="number" min="1024" max="65535" required value="4319"></label>
        <label class="proxy-checkbox"><input id="auto-start" type="checkbox">随 Daylight 启动代理</label>
        </div>
        <p class="proxy-hint">关闭窗口后继续运行，退出 Daylight 时停止。</p>
        <div class="proxy-node"><span class="proxy-caption">Node 运行环境</span><p id="node-info" class="proxy-hint">正在检测…</p><div id="node-setting" hidden><label class="proxy-field">Node 路径 <input id="node-path" placeholder="留空自动检测，或填写绝对路径" spellcheck="false"></label><button id="save-node" type="button" class="text-button">重新检测 / 应用路径</button></div></div>
        <div id="settings-actions" class="proxy-section-title" hidden><button id="save-settings" class="secondary" type="submit">保存设置</button><button id="rotate-key" class="danger-link" type="button">更换 API Key</button></div><p id="settings-result" class="proxy-hint" role="status"></p>
      </form>`})}`;

export function createServicePanel({store,getExampleModel}){
 const root=document.createElement('div');root.innerHTML=template;
 const element=root.firstElementChild,footer=document.createElement('div');footer.className='workspace proxy-footer';footer.innerHTML=settingsTemplate;
 const nodes=new Map([...root.querySelectorAll('[id]'),...footer.querySelectorAll('[id]')].map(n=>[n.id,n]));const $=id=>nodes.get(id);
 mountDisclosures(root);mountDisclosures(footer);
 $('protocol-control').innerHTML=selectField({id:'protocol',name:'protocol',label:'客户端协议',value:'chat',compact:true,hideLabel:true,options:[{value:'chat',label:'Chat Completions'},{value:'responses',label:'Responses'},{value:'messages',label:'Anthropic Messages'}]});nodes.set('protocol',$('protocol-control').querySelector('#protocol'));
 let working=false,checking=false,savingSettings=false,savingNode=false,settingsDirty=false,key='',keyLoading,disposed=false;
 const names={stopped:'已停止',starting:'启动中…',running:'运行中',stopping:'停止中…'};
 function error(message=''){$('service-error').textContent=message;$('service-error').hidden=!message;}
 function paint(){
  const status=store.status;if(!status)return;
  const running=status.state==='running',transition=working||['starting','stopping'].includes(status.state),unavailable=!!status.runtimeError,locked=running||transition;
  $('service-state').textContent=working?(running?'停止中…':'启动中…'):unavailable?'运行环境待设置':names[status.state]||'正在准备…';
  $('service-dot').classList.toggle('running',running);$('service-switch').setAttribute('aria-checked',String(running));$('service-switch').setAttribute('aria-label',running?'停止代理':'开启代理');$('service-switch').setAttribute('aria-busy',String(transition));$('service-switch').disabled=transition||unavailable||checking;
  $('service-note').textContent=unavailable?'在下方设置中选择 Node 22 或更新版本。':running?`${status.activeRequests} 个请求进行中 · 所有来源共用此开关`:'统一代理 · 至少一个来源可用即可开启';
  $('base-url').value=$('protocol').value==='messages'?status.baseUrl?.replace(/\/v1$/,'')||'':status.baseUrl||'';
  $('copy-url').disabled=!$('base-url').value;$('test-connection').disabled=!running||transition||checking;$('copy-example').disabled=!key||unavailable;
  $('settings-edit').hidden=locked;$('settings-readonly').hidden=!locked;$('settings-readonly').textContent=`本机端口 ${status.port} · ${status.autoStart?'随 Daylight 自动启动':'手动启动'}`;
  $('settings-actions').hidden=locked;$('settings-result').hidden=locked;$('save-settings').disabled=locked||unavailable||savingSettings;
  $('proxy-port').disabled=locked;$('auto-start').disabled=locked;$('rotate-key').disabled=locked||unavailable;
  if(!settingsDirty){$('proxy-port').value=status.port||4319;$('auto-start').checked=!!status.autoStart;}
  $('node-info').textContent=status.runtimeError||`${status.node?.version||''} · ${status.node?.path||''}`;$('node-setting').hidden=!status.native||locked;$('save-node').disabled=locked||savingNode;$('node-path').disabled=locked;
  if(store.error||status.runtimeError||status.lastError)error(store.error||status.runtimeError||status.lastError);
  if(!key&&!unavailable&&!keyLoading)void loadKey().catch(e=>error(e.message));
 }
 async function loadKey(){
  if(keyLoading)return keyLoading;
  keyLoading=store.api.request('key').then(result=>{if(disposed)return;key=result.apiKey;$('api-key').value=key;$('show-key').disabled=false;$('copy-key').disabled=false;paint();}).finally(()=>{keyLoading=null;});return keyLoading;
 }
 async function copy(button,value){try{await navigator.clipboard.writeText(value);const label=button.textContent;button.textContent='已复制';button.disabled=true;setTimeout(()=>{if(!disposed){button.textContent=label;button.disabled=false;}},1600);}catch{error('复制未完成，请选中输入框内容后手动复制。');}}
 function confirmAction(title,message,label){return new Promise(resolve=>{
  const dialog=$('proxy-confirm'),focus=document.activeElement;$('confirm-title').textContent=title;$('confirm-message').textContent=message;$('confirm-ok').textContent=label;
  const finish=value=>{dialog.close();focus?.focus();resolve(value);};$('confirm-cancel').onclick=()=>finish(false);$('confirm-ok').onclick=()=>finish(true);dialog.oncancel=e=>{e.preventDefault();finish(false);};dialog.showModal();$('confirm-cancel').focus();
 });}
 $('service-switch').onclick=async()=>{
  if(working||!store.status)return;const enabled=store.status.state!=='running';let force=false;
  if(!enabled&&store.status.activeRequests){force=await confirmAction('停止代理？',`将中断 ${store.status.activeRequests} 个正在进行的请求。`,'停止代理');if(!force)return;}
  working=true;error();paint();try{await store.api.request('service',{enabled,force});}catch(e){error(e.message);}finally{working=false;await store.refresh();paint();}
 };
 $('protocol').onchange=paint;$('copy-url').onclick=()=>copy($('copy-url'),$('base-url').value);$('copy-key').onclick=()=>copy($('copy-key'),key);
 $('show-key').onclick=()=>{const visible=$('api-key').type==='password';$('api-key').type=visible?'text':'password';$('show-key').textContent=visible?'隐藏':'显示';};
 $('copy-example').onclick=()=>{
  const protocol=$('protocol').value,model=getExampleModel()||'替换为模型 ID',body=protocol==='responses'?{model,input:'你好',stream:true}:{model,messages:[{role:'user',content:'你好'}],...(protocol==='messages'?{max_tokens:1024}:{}),stream:true};
  const route={chat:'/chat/completions',responses:'/responses',messages:'/messages'}[protocol],quote=value=>`'${value.replaceAll("'","'\\''")}'`;
  void copy($('copy-example'),`curl -N ${quote(store.status.baseUrl+route)} \\\n  -H ${quote(`Authorization: Bearer ${key}`)} \\\n  -H 'Content-Type: application/json' \\\n  -d ${quote(JSON.stringify(body))}`);
 };
 $('test-connection').onclick=async()=>{checking=true;paint();$('test-connection').textContent='测试中…';$('connection-result').textContent='正在验证本机接口、鉴权与模型目录…';try{$('connection-result').textContent=(await store.api.request('check',{})).message;}catch(e){$('connection-result').textContent=e.message;}finally{checking=false;$('test-connection').textContent='测试连接';paint();}};
 $('settings-form').oninput=()=>{settingsDirty=true;};
 $('settings-form').onsubmit=async e=>{e.preventDefault();if(savingSettings)return;savingSettings=true;$('save-settings').textContent='保存中…';paint();try{await store.api.request('settings',{port:Number($('proxy-port').value),autoStart:$('auto-start').checked});settingsDirty=false;$('settings-result').textContent='设置已保存';error();await store.refresh();}catch(e){$('settings-result').textContent=e.message;}finally{savingSettings=false;$('save-settings').textContent='保存设置';paint();}};
 $('save-node').onclick=async()=>{if(savingNode)return;savingNode=true;paint();try{await store.api.request('runtime',{nodePath:$('node-path').value.trim()});await store.refresh();error();}catch(e){error(e.message);}finally{savingNode=false;paint();}};
 $('rotate-key').onclick=async()=>{if(!await confirmAction('更换 API Key？','现有客户端中的旧密钥将立即失效，需要重新复制配置。','更换密钥'))return;try{await store.api.request('key/rotate',{});await loadKey();$('settings-result').textContent='密钥已更换，请更新客户端配置';}catch(e){error(e.message);}};
 function hideKey(){$('api-key').type='password';$('show-key').textContent='显示';}
 const unsubscribe=store.subscribe(paint);
 return{element,footer,hideKey,confirmAction,dispose(){disposed=true;unsubscribe();hideKey();}};
}
