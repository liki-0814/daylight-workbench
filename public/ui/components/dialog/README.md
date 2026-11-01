# dialog

`dialog({ id, label, width, children })` → SafeHtml（原生 `<dialog>`，`showModal()` 提供焦点陷阱与 Esc）；`mountDialog({ id, label, width, children, className })` → `{ el, open(), close(), update(children), destroy() }`，`update()` 用 `morph()` 增量更新，不丢焦点与 IME 状态。宽度 680（新建任务）、圆角 20（`--radius-dialog`）、浅色模糊遮罩（`--scrim-light` + `--scrim-blur`）。`overflow: visible`，下拉菜单可超出弹窗边缘。⌘/Ctrl+↵ 触发内部 `[data-dialog-submit]`。

## 派发的事件（目标是 `<dialog>`，冒泡）
| 事件 | 时机 | detail |
|---|---|---|
| `ui:dismiss`（可取消） | Esc（`source: 'keyboard'`）或点击遮罩（`'user'`）；没被取消才关闭 | `{ value: null, source }` |
| `ui:close` | 用户关闭了弹窗：`ui:dismiss` 没被取消而关闭之后，或点击了 `[data-dialog-close]` 按钮之后 | `{ value: null, source }` |

`update()` / `open()` / `close()` / `destroy()`（程序调用）与原生 `close` 事件都不派发 `ui:dismiss` / `ui:close`（事件契约 E-7）；页面在程序化关闭后自己清理（如 `destroy()`）。

## 怎么关闭弹窗
组件库的弹窗只能通过两种方式由用户关闭：带 `[data-dialog-close]` 的按钮（派发 `ui:close`），或 `ui:dismiss`（Esc / 点击遮罩）。**不要**用 `<form method="dialog">` 的 submit 去关闭库弹窗：它由浏览器原生关闭 `<dialog>`，不会派发任何 `ui:*` 契约事件（页面收不到 `ui:close`，也没有机会取消）。需要「提交并关闭」时，让提交按钮自己处理提交，再在页面里程序化 `close()` / `destroy()`，或用 `[data-dialog-close]` 按钮。

## 转义
`label` / `id` 经 `esc()`；`children` 只接受 `trusted()` / 组件返回值。
