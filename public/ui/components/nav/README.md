# nav

`nav({ label, kind, header, sections: [{ title, items, action, empty }], footer, attrs })` → SafeHtml（`<nav>`）。`items: [{ value, label, icon, dot, count, active, kbd, attrs }]`。`kind: 'sidebar'`（固定在左侧，宽 `--sidebar-width`，条目高 36）或 `'list'`（页面内二级导航，设置页左栏 200 宽）。当前项带 `aria-current="page"`。↑ ↓ Home End 在条目间移动焦点，Tab 进出。窗口 ≤ 999px 退化成只显示图标。

## 派发的事件（目标是 `<nav>` 根元素，冒泡）
| 事件 | 时机 | detail |
|---|---|---|
| `ui:select` | 点击 / Enter / Space 某个条目 | `{ value, source }` |

`updateNav(host, content)`：把 `nav(...)` 的新结果 morph 进 host，并保住滚动区（`.dl-nav__scroll`）的 `scrollTop`；页面不查组件内部类。

组件**不**自己切换 `is-active`——页面收到 `ui:select` 后更新状态再 `update()` 重绘（morph 保留焦点）。分区标题上的「+」按钮是页面级命令，用 `section.action.attrs` 带 `data-action`。

## 转义
所有 `label` / `title` / `value` / `count` / `empty` 经 `esc()`；`header` 只接受 `trusted()` / 组件返回值。

快捷键 `kbd`：`.dl-kbd` 的契约归 [kbd](../kbd/README.md)。nav 只赋值 `--ui-kbd-fg: var(--color-text-secondary)`（`.dl-nav__item`），所有状态（默认 / hover / 选中）同一个值，不随状态变化（hover / 选中底色上仍 ≥4.5:1）。
