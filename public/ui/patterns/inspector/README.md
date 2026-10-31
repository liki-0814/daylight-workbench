# inspector（右侧详情栏）

`inspector({ label, kicker, title, props: [{ label, value, tone }], note, actions, empty })`。宽 300（`--inspector-w`），内边距 24，属性行 36 高，标签列 88；与主区之间只有一条细线，底色与全局一致（不用深色块）。

## 派发的事件
**无。** `actions` 里的按钮是页面级命令（`data-action`）。

## 转义
`title` / `kicker` / `props[].label|value` / `note` 经 `esc()`；`actions` 只接受 `trusted()` / 组件返回值。
