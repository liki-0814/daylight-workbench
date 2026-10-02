export const settingsPage = `
    <header class="topbar"><span>我的工作空间 <span class="slash">/</span> 设置</span></header>
    <div class="workspace settings-workspace">
      <section class="page-heading"><div><h1>设置</h1><p>AI 对话、快捷键与快速搜索</p></div></section>
      <div class="ui-panel-grid settings-grid">
        <div class="ui-panel-stack">
          <section class="settings-panel" aria-labelledby="shortcuts-heading">
            <div class="settings-heading"><h2 id="shortcuts-heading">快捷键</h2><p>在快速搜索面板和主窗口中使用</p></div>
            <ul class="shortcut-list">
              <li><div><strong>快速搜索</strong><span>全局唤出悬浮搜索框，搜索 Google 或直接打开网址</span></div><span class="keys"><kbd>⌥</kbd><kbd>Space</kbd></span></li>
              <li><div><strong>新建任务</strong><span>在当前页面打开新建任务表单</span></div><span class="keys"><kbd>⌘</kbd><kbd>K</kbd></span></li>
              <li><div><strong>搜索任务</strong><span>聚焦顶部搜索框，查找任务</span></div><span class="keys"><kbd>/</kbd></span></li>
              <li><div><strong>打开设置</strong><span>从任意页面回到这里</span></div><span class="keys"><kbd>⌘</kbd><kbd>,</kbd></span></li>
              <li><div><strong>关闭</strong><span>关闭对话框或快速搜索面板</span></div><span class="keys"><kbd>Esc</kbd></span></li>
            </ul>
          </section>
          <section class="settings-panel" aria-labelledby="quick-heading">
            <div class="settings-heading"><h2 id="quick-heading">快速搜索</h2><p>按 ⌥ Space 唤出，输入后按 Enter</p></div>
            <dl class="settings-facts">
              <div><dt>搜索引擎</dt><dd>Google</dd></div>
              <div><dt>打开方式</dt><dd>Google Chrome，未安装时使用系统默认浏览器</dd></div>
              <div><dt>网址识别</dt><dd>输入网址（如 example.com、localhost:3000）直接打开</dd></div>
              <div><dt>关闭方式</dt><dd>Esc、再次按 ⌥ Space，或点击面板外部</dd></div>
            </dl>
          </section>
        </div>
      </div>
      <footer class="workspace-footer"><span>设置仅保留在本机</span><span>Daylight</span></footer>
    </div>`;
