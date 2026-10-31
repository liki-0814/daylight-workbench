# shell（页面骨架）

`pageLayout({ id, label, toolbar, body, inspector, footer })`：`<main class="dl-page">` = toolbar（56）+ 主体（可选右侧 inspector 300）+ 36 高底部状态条。左边距让出全局侧栏（`--sidebar-width`）；页面与 inspector 之间只有细线。

## 派发的事件
**无。**

## 转义
全部参数只接受 `trusted()` / 组件返回值（经 `slot()`）；`id` / `label` 经 `esc()`。
