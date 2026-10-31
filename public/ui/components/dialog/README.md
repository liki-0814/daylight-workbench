# dialog

`dialog({ id, label, width, children })` → SafeHtml（原生 `<dialog>`，`showModal()` 提供焦点陷阱与 Esc）；`mountDialog({ id, label, width, children, className })` → `{ el, open(), close(), update(children), destroy() }`，`update()` 用 `morph()` 增量更新，不丢焦点与 IME 状态。宽度 680（新建任务）、圆角 20（`--radius-dialog`）、浅色模糊遮罩（`--scrim-light` + `--scrim-blur`）。`overflow: visible`，下拉菜单可超出弹窗边缘。⌘/Ctrl+↵ 触发内部 `[data-dialog-submit]`。

## 派发的事件（目标是 `<dialog>`，冒泡）
| 事件 | 时机 | detail |
|---|---|---|
| `ui:dismiss`（可取消） | Esc（`source: 'keyboard'`）或点击遮罩（`'user'`）；没被取消才关闭 | `{ value: null, source }` |
| `ui:close` | 弹窗已关闭 | `{ value: returnValue \| null, source }` |

`update()` / `open()` / `close()`（程序调用）不派发 `ui:dismiss`。

## 转义
`label` / `id` 经 `esc()`；`children` 只接受 `trusted()` / 组件返回值。
