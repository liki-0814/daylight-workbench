# data-row（任务行 / 分组头）

`groupHeader({ key, label, dot, count })`、`taskRow({ id, code, title, done, priority, due, selected, action })`、`rowList({ label, children })`、`priorityMark(level)`。分组头高 40，行高 44，水平内边距 32，行间 14。列网格 `16px 56px minmax(0,1fr) 20px 76px 76px`：复选 / 编号（等宽）/ 标题 / 优先级（居中）/ 截止（左对齐，tabular-nums）/ 行内操作（仅悬停、选中、聚焦时显示）。优先级用三根竖条 + `aria-label`，不单靠颜色。

键盘：行本身可聚焦（`tabindex=0`），↑ ↓ Home End 在行之间移动，Enter / Space 选中。

## 派发的事件
| 事件 | 目标 | 时机 | detail |
|---|---|---|---|
| `ui:select` | `.dl-row` | 点击行（非按钮区）或 Enter / Space | `{ value: id, source }` |
| `ui:change`（可取消） | 勾选框（checkbox 组件） | 用户勾选 / 取消 | `{ value: boolean, previousValue, source }`，页面用 `event.target.closest('.dl-row').dataset.id` 找行 |

「专注」等行内操作是页面级命令，`action.attrs` 里带 `data-action`。

## 转义
`title` / `code` / `label` / `due.text` 经 `esc()`；`rowList` 的 `children` 只接受 `trusted()` / 组件返回值。
