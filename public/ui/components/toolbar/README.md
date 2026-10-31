# toolbar

`toolbar({ title, count, start, end, attrs })` → SafeHtml（`<header class="dl-toolbar">`）。高 56（`--toolbar-h`），水平内边距 32（`--space-page`），底部一条细线，不用深色块。`start`（标题右侧，如分段控件、搜索）与 `end`（右侧，如主按钮）只接受 `trusted()` / 组件返回值。

## 派发的事件
**无。** 它只是容器；里面的 segmented / button 各自负责事件。

## 转义
`title` / `count` 经 `esc()`；`start` / `end` 走 `slot()`（裸字符串按文本）。
