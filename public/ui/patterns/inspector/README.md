# inspector（右侧详情栏）

`inspector({ label, kicker, title, props: [{ label, value, tone }], primary, sections: [{ key, title, count, body, empty }], note, actions, empty })`。
宽 300（`--inspector-w`），内边距 24，属性行 36 高，标签列 88；与主区之间只有一条细线，底色与全局一致（不用深色块）。

## 版式（顺序固定）
标题 → 属性表 → **操作行（`primary`，紧贴属性表下方，不钉在底部）** → 分区（备注 / 子任务 / 动态；`.dl-insp__body` 内部可滚动）。
操作行只放两个主按钮（任务页：「开始专注」「完成」）和一个「更多」菜单（`select`，`action` 项）；其余操作都进菜单。
任何文字都不裁切：按钮和长文本自动换行，没有 `text-overflow: ellipsis`，固定高度一律用 `min-height`。
`actions` 是 `primary` 的旧名，行为相同（放在同一位置）。

## 派发的事件
**无。** 操作行里的按钮是页面级命令（`data-action`）；「更多」菜单派发 `ui:select`（select 组件的 action 项）。

## 转义
`title` / `kicker` / `props[].label|value` / `note` / `sections[].title|empty` 经 `esc()`；`primary` / `actions` / `sections[].body` 只接受 `trusted()` / 组件返回值。
