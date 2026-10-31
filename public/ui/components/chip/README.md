# chip

`chip({ label, icon, dot, empty, selected, interactive, attrs })` → SafeHtml。胶囊（`--radius-full`）属性标签，高 28。`dot` 取 `green | amber | neutral`（项目色，落到 `--dot-*` 令牌）。`empty` 为虚线（未设置）。`select` 的 `variant: 'chip'` 复用同一份 `.dl-chip` 样式。导出 `dot(color)` 供行 / 导航复用。

## 派发的事件
**无。** `interactive: true` 时渲染为 `<button>`，页面级命令用 `attrs: { 'data-action': … }`。需要「选一个值」的场景请用 select。

## 转义
`label` 经 `esc()`；`attrs` 走属性名白名单。
