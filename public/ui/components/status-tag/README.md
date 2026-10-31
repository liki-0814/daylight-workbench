# status-tag

`statusTag({ tone, label, dashed, spin, dot, attrs })` → SafeHtml。`tone`：`success | neutral | warning | error | info`。`dashed` 虚线边（代理「启动中」），`spin` 左侧换成青绿加载圈（`spinner()` 也单独导出）。颜色之外一律带文字，状态不单靠颜色传达。每个 tone 有 `data-key`，状态切换时 morph 换新节点并淡入（200ms，仅 opacity）。

## 派发的事件
**无。** 纯展示。

## 转义
`label` 经 `esc()`；`tone` 经 `esc()` 后用于 class。

## 颜色对比
success / error / warning / info 的文字与底色组合由 `test/ui-tokens.test.mjs` 断言 ≥ 4.5:1（info 的实测值见 `tokens/README.md`）。
