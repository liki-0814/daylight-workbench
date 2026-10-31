# settings（设置页的分组 / 行）

`settingsLayout({ sections, title, subtitle, children })`、`settingsGroup({ title, rows })`、`settingsRow({ label, hint, hintTone, control })`。左侧二级导航 200 宽；分组卡片 18 圆角 + 细线；行 60 高；`control` 靠右，输入框与选择器固定 200 宽，所有控件共用同一条右边缘。**设置页没有保存按钮**：每个控件的 `ui:change` 立即保存（页面负责调用后端的单项写入接口）。

## 派发的事件
**无**（纯布局）。左栏导航由 nav 组件派发 `ui:select`；行内控件各自派发 `ui:change`。

## 转义
`label` / `hint` / `title` 经 `esc()`；`control` / `rows` / `children` 只接受 `trusted()` / 组件返回值。
