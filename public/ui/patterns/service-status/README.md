# service-status（代理状态卡，四态）

`serviceHero({ state, title, tagLabel, address, addressNote, copyLabel, meta, note, error, cancel, announce, switchLabel, switchAttrs })`，`state`：`running | starting | stopped | error`。

| 状态 | 标签 | 内容 |
|---|---|---|
| running | 绿色 | 可复制的地址、运行时长 / 请求数（`meta`） |
| starting | 灰色虚线 + 青绿旋转圈 | 开关已开启并 `aria-busy="true"`；5 秒后页面传入 `cancel` 显示「取消」 |
| stopped | 灰色 | 「未在监听」+ 启用后将使用的地址预览（`addressNote`） |
| error | 红色 | `error: { what, why, todo, actions }`（`role="alert"`），开关回到关 |

**焦点不动**：组件不移动焦点；`announce` 写进 `role="status"` 的播报区（如「反向代理已启用，地址 127.0.0.1:4319」）。动画只用 opacity / transform / color（150–200ms），错误区用 grid-template-rows 展开；`prefers-reduced-motion` 下位移类动画改直接切换，旋转圈变静态圆点。

## 派发的事件
**无**（纯组合）。开关的 `ui:change` 由 switch 组件派发；复制 / 取消 / 重试 / 改用 4320 / 查看日志是页面级命令（`data-action`）。配置卡片由页面用 settings 的 group / row 放在 hero 下方，任何状态下都保持全对比度、可编辑。

## 与设计的差异
状态标签的「交叉淡入」只做新标签淡入（旧标签随 morph 直接移除）；M8（重试时错误区淡出）为直接收起。

## 转义
所有文字属性经 `esc()`；`error.actions` 只接受 `trusted()` / 组件返回值。
