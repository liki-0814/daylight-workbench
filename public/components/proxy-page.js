import { disclosureSection, refreshButton } from './section.js';

export const proxyPage = `
    <header class="topbar"><span>我的工作空间 <span class="slash">/</span> 反向代理</span></header>
    <div class="workspace proxy-workspace">
      <section class="page-heading"><div><h1>反向代理</h1><p>将 Qoder 模型接入你的客户端</p></div></section>
      <section class="proxy-panel" aria-label="代理服务">
        <div class="proxy-service">
          <div><h2><span id="service-dot" class="proxy-dot"></span><span id="service-state">正在读取状态…</span></h2><p id="service-note">代理默认关闭，按需开启。</p></div>
          <button id="service-switch" class="proxy-switch" type="button" role="switch" aria-checked="false" aria-label="开启代理" disabled><span></span></button>
        </div>
        <div id="service-error" class="proxy-error" role="alert" hidden></div>
        <div class="proxy-account"><div class="proxy-account-info"><span class="proxy-caption">Qoder 账号</span><span id="account-name">正在读取…</span></div><div class="proxy-account-actions">${refreshButton({id:'account-refresh',label:'刷新登录',attrs:{hidden:true,disabled:true}})}<button id="account-action" class="text-button" type="button" hidden disabled>登录 Qoder</button></div></div>
        <div id="login-panel" class="proxy-login" hidden><p id="login-note">在浏览器中完成授权，此页会自动更新。</p><p id="login-code" hidden></p><a id="login-link" rel="noreferrer" target="_blank">打开登录页面 ↗</a><button id="login-cancel" class="text-button">取消</button></div>
      </section>
      <section class="proxy-panel proxy-connect" aria-labelledby="connect-heading">
        <div class="proxy-section-title"><h2 id="connect-heading">接入配置</h2><div id="protocol-control" class="proxy-protocol"></div></div>
        <label class="proxy-caption" for="base-url">Base URL</label>
        <div class="proxy-copy"><input id="base-url" readonly value="正在读取…" spellcheck="false"><button id="copy-url" class="small-button" disabled>复制</button></div>
        <label class="proxy-caption" for="api-key">API Key</label>
        <div class="proxy-copy"><input id="api-key" type="password" readonly value="" placeholder="正在读取…" autocomplete="off" spellcheck="false"><button id="show-key" class="small-button" disabled>显示</button><button id="copy-key" class="small-button" disabled>复制</button></div>
        <div class="proxy-connect-actions"><button id="copy-example" class="secondary" disabled>复制请求示例</button><button id="test-connection" class="text-button" disabled>测试连接</button></div>
        <p id="connection-result" class="proxy-hint" role="status">开启代理后，即可在客户端中填写以上地址与密钥。</p>
      </section>
      ${disclosureSection({id:'models-details',className:'proxy-disclosure',title:'模型设置',description:'启用与默认参数',actions:refreshButton({id:'refresh-models',ariaLabel:'刷新模型'}),content:'<div id="models-list"></div><p id="models-message" class="proxy-hint proxy-model-message ui-feedback-row" role="status"></p>'})}
      ${disclosureSection({id:'usage-details',className:'proxy-disclosure',title:'Credits 用量',description:'已用与剩余额度',actions:refreshButton({id:'refresh-usage',ariaLabel:'刷新额度'}),content:'<p id="usage-summary" class="proxy-hint" role="status"></p><div id="usage-list" class="proxy-credits"></div><div id="usage-trend" class="proxy-credit-trend"></div><p id="usage-note" class="proxy-hint" hidden>账户额度包含其他客户端的使用；团队资源包包含团队使用。每小时保留一个快照，展示近 30 天已用额度变化；额度重置可能使曲线下降，不代表退款或单次请求费用。</p>'})}
      ${disclosureSection({id:'settings-details',className:'proxy-disclosure',title:'设置',description:'端口与自动启动',content:`<form id="settings-form" class="proxy-settings-form">
        <p id="settings-readonly" class="proxy-hint ui-feedback-row" hidden></p>
        <div id="settings-edit" hidden>
        <label class="proxy-field">本机端口<input id="proxy-port" type="number" min="1024" max="65535" required value="4319"></label>
        <label class="proxy-checkbox"><input id="auto-start" type="checkbox">随 Daylight 启动代理</label>
        </div>
        <p class="proxy-hint">关闭窗口后继续运行，退出 Daylight 时停止。</p>
        <div class="proxy-node"><span class="proxy-caption">Node 运行环境</span><p id="node-info" class="proxy-hint">正在检测…</p><div id="node-setting" hidden><label class="proxy-field">Node 路径 <input id="node-path" placeholder="留空自动检测，或填写绝对路径" spellcheck="false"></label><button id="save-node" type="button" class="text-button">重新检测 / 应用路径</button></div></div>
        <div id="settings-actions" class="proxy-section-title" hidden><button id="save-settings" class="secondary" type="submit">保存设置</button><button id="rotate-key" class="danger-link" type="button">更换 API Key</button></div><p id="settings-result" class="proxy-hint" role="status"></p>
      </form>`})}
      <footer class="workspace-footer"><span>凭证与配置保存在本机</span><span>Qoder 协议桥</span></footer>
    </div>

<dialog id="proxy-confirm" aria-labelledby="confirm-title"><div class="dialog-header"><h2 id="confirm-title"></h2></div><div class="form-body"><p id="confirm-message"></p></div><div class="dialog-footer"><button id="confirm-cancel" class="secondary">取消</button><button id="confirm-ok" class="primary">确认</button></div></dialog>`;

export function modelGroups(models,row,{open=false,selected=m=>m.enabled!==false}={}) {
  const enabled=models.map((m,i)=>({m,i})).filter(({m})=>selected(m));
  const disabled=models.map((m,i)=>({m,i})).filter(({m})=>!selected(m));
  return enabled.map(({m,i})=>row(m,i)).join('')+(disabled.length?`<details class="proxy-disabled-models" ${open?'open':''}><summary>未启用模型 <span>${disabled.length}</span></summary>${disabled.map(({m,i})=>row(m,i)).join('')}</details>`:'');
}
