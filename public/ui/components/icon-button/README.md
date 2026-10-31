# icon-button

`iconButton({ label, icon, variant, size, attrs, disabled })` → SafeHtml。圆形，默认 36（`--icon-btn`），`size: 'sm'` 为 28（最小点击目标）。`label` 必填，同时作 `aria-label` 与 `title`。变体 `default | send | ghost`；`send` 为圆形青绿主按钮（新建任务的 ⌘↵）。

## 派发的事件
**无。** 页面级命令用 `attrs: { 'data-action': '…' }`。

## 转义
`label` 经 `esc()`；`attrs` 走属性名白名单。图标由 `core/icons.js` 的固定路径生成（未知名字回落到圆形）。
