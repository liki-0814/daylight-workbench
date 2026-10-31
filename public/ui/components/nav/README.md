# nav

`nav({ label, kind, header, sections: [{ title, items, action, empty }], footer, attrs })` → SafeHtml（`<nav>`）。`items: [{ value, label, icon, dot, count, active, kbd, attrs }]`。`kind: 'sidebar'`（固定在左侧，宽 `--sidebar-width`，条目高 36）或 `'list'`（页面内二级导航，设置页左栏 200 宽）。当前项带 `aria-current="page"`。↑ ↓ Home End 在条目间移动焦点，Tab 进出。窗口 ≤ 999px 退化成只显示图标。

## 派发的事件（目标是 `<nav>` 根元素，冒泡）
| 事件 | 时机 | detail |
|---|---|---|
| `ui:select` | 点击 / Enter / Space 某个条目 | `{ value, source }` |

组件**不**自己切换 `is-active`——页面收到 `ui:select` 后更新状态再 `update()` 重绘（morph 保留焦点）。分区标题上的「+」按钮是页面级命令，用 `section.action.attrs` 带 `data-action`。

## 转义
所有 `label` / `title` / `value` / `count` / `empty` 经 `esc()`；`header` 只接受 `trusted()` / 组件返回值。

快捷键 `kbd` 用 `.dl-kbd` 的令牌 `--ui-kbd-fg`：`.dl-nav__item` 默认 secondary，hover / 选中 primary（契约见 button/README.md）。
