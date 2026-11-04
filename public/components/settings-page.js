import { sectionHeading, settingToggleRow } from './section.js';
export const settingsPage = `
    <header class="topbar"><span>我的工作空间 <span class="slash">/</span> 设置</span></header>
    <div class="workspace settings-workspace">
      <section class="page-heading"><div><h1>设置</h1></div></section>
      <div class="ui-panel-grid settings-grid">
        <div class="ui-panel-stack">
          <section class="settings-panel" aria-label="任务显示">
            ${sectionHeading({title:'任务显示',className:'settings-heading'})}
            ${settingToggleRow({name:'show-done-entry',label:'任务页底部显示「已完成」折叠区',description:'关闭后，任务页与搜索都不再显示已完成任务；刚完成的任务仍可用提示中的撤销恢复。'})}
          </section>
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
        </div>
      </div>
    </div>`;

/** Local display preferences live in localStorage; the owner re-renders on change. */
export function mountSettingsPreferences(root, { isDoneEntryVisible, onDoneEntryChange }) {
  const input = root.querySelector('[name=show-done-entry]');
  if (!input) return;
  input.checked = isDoneEntryVisible();
  input.addEventListener('change', () => onDoneEntryChange(input.checked));
}
