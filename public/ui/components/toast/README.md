# toast

`showToast({ message, tone, actions, persistent, timeout })` → `{ el, dismiss() }`；`toastMarkup({ message, tone, actions })` → SafeHtml（纯函数，便于测试）。右下角固定的 `role="region"` 容器里，错误用 `role="alert"`，其余 `role="status"`。

**错误与警告不会自动消失**（旧的 `notify` 6500ms 自动收起对错误不再适用）；success / info 默认 6.5 秒，悬停 / 聚焦时暂停。

## 派发的事件（目标是 `.dl-toast`，冒泡）
| 事件 | 时机 | detail |
|---|---|---|
| `ui:dismiss`（可取消） | 点击 × | `{ value: null, source }` |
| `ui:select` | 点击某个操作按钮（如「撤销」），随后收起 | `{ value, source }` |

## 转义
`message` / `actions[].label` / `value` 经 `esc()`；`message` 一律按文本。
