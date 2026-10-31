# segmented

`segmented({ name, value, label, options: [{ value, label, count, attrs }], attrs })` → SafeHtml（`role="radiogroup"`，条目 `role="radio"`，roving tabindex）。`label` 必填。← → Home End 移动并选中。

## 派发的事件（目标是 `.dl-seg` 根元素，冒泡）
| 事件 | 时机 | detail |
|---|---|---|
| `ui:change`（可取消） | 用户选了不同的条目（乐观更新，被取消则回滚） | `{ value, previousValue, source }` |

`update()` 不派发。

## 转义
`label` / `value` / `count` 经 `esc()`。
