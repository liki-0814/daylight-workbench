import {sectionHeading} from './section.js';
export const settingsPage = `
    <header class="topbar"><span>我的工作空间 <span class="slash">/</span> 设置</span></header>
    <div class="workspace settings-workspace">
      <section class="page-heading"><div><h1>设置</h1></div></section>
      <div class="ui-panel-grid settings-grid">
        <div class="ui-panel-stack">
          <section class="settings-panel" aria-label="本地扩展">${sectionHeading({title:'本地扩展',className:'settings-heading'})}<a class="text-button" href="#extensions">打开扩展管理</a></section>
          <section class="settings-panel" aria-label="应用更新">${sectionHeading({title:'应用更新',className:'settings-heading'})}<a class="text-button" href="#update">打开更新页面</a></section>
          <section class="settings-panel" aria-label="快捷键">
            ${sectionHeading({title:'快捷键',className:'settings-heading'})}
            <ul class="shortcut-list">
              <li><div><strong>快捷问答与搜索</strong></div><span class="keys"><kbd>⌥</kbd><kbd>Space</kbd></span></li>
              <li><div><strong>新建任务</strong></div><span class="keys"><kbd>⌘</kbd><kbd>K</kbd></span></li>
              <li><div><strong>搜索任务</strong></div><span class="keys"><kbd>/</kbd></span></li>
              <li><div><strong>打开设置</strong></div><span class="keys"><kbd>⌘</kbd><kbd>,</kbd></span></li>
              <li><div><strong>关闭</strong></div><span class="keys"><kbd>Esc</kbd></span></li>
            </ul>
          </section>
          <section class="settings-panel" aria-label="快捷问答与搜索">
            ${sectionHeading({title:'快捷问答与搜索',className:'settings-heading'})}
            <dl class="settings-facts">
              <div><dt>临时问答</dt><dd>复用 AI 对话模型与推理设置，仅一轮，关闭即清空</dd></div>
              <div><dt>搜索引擎</dt><dd>切换 Google 模式搜索或打开网址</dd></div>
              <div><dt>打开方式</dt><dd>Google Chrome，未安装时使用系统默认浏览器</dd></div>
              <div><dt>网址识别</dt><dd>输入网址（如 example.com、localhost:3000）直接打开</dd></div>
              <div><dt>关闭方式</dt><dd>Esc、再次按 ⌥ Space，或点击面板外部</dd></div>
            </dl>
          </section>
        </div>
      </div>
    </div>`;
