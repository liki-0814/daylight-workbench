export const settingsPage = `
    <header class="topbar"><span>我的工作空间 <span class="slash">/</span> 设置</span></header>
    <div class="workspace settings-workspace">
      <section class="page-heading"><div><h1>设置</h1><p>反向代理、AI 对话、专注计时、快捷键与应用更新</p></div></section>
      <div class="ui-panel-grid settings-grid">
        <div class="ui-panel-stack">
          <section class="settings-panel" aria-labelledby="extensions-settings-heading"><div class="settings-heading"><h2 id="extensions-settings-heading">本地扩展</h2><p>主来源位于 ~/.agents。管理 Skills、MCP 与本机软件接入。</p></div><a class="text-button" href="#extensions">打开扩展管理</a></section>
          <section class="settings-panel" aria-labelledby="shortcuts-heading">
            <div class="settings-heading"><h2 id="shortcuts-heading">快捷键</h2><p>在快捷面板和主窗口中使用</p></div>
            <ul class="shortcut-list">
              <li><div><strong>快捷问答与搜索</strong><span>全局唤出临时 AI 问答，也可切换 Google 搜索</span></div><span class="keys"><kbd>⌥</kbd><kbd>Space</kbd></span></li>
              <li><div><strong>新建任务</strong><span>在当前页面打开新建任务表单</span></div><span class="keys"><kbd>⌘</kbd><kbd>K</kbd></span></li>
              <li><div><strong>搜索任务</strong><span>聚焦顶部搜索框，查找任务</span></div><span class="keys"><kbd>/</kbd></span></li>
              <li><div><strong>打开设置</strong><span>从任意页面回到这里</span></div><span class="keys"><kbd>⌘</kbd><kbd>,</kbd></span></li>
              <li><div><strong>关闭</strong><span>关闭对话框或快捷面板</span></div><span class="keys"><kbd>Esc</kbd></span></li>
            </ul>
          </section>
          <section class="settings-panel" aria-labelledby="quick-heading">
            <div class="settings-heading"><h2 id="quick-heading">快捷问答与搜索</h2><p>按 ⌥ Space 唤出，输入后按 Enter</p></div>
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
      <footer class="workspace-footer"><span>设置仅保留在本机</span><span>Daylight</span></footer>
    </div>`;
