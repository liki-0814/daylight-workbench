# switch

`switchControl({ name, checked, label, busy, disabled, attrs })` → SafeHtml（`<button role="switch" aria-checked>`）。`label` 必填。`busy` 加 `aria-busy="true"`（代理「启动中」时开关已为开启态）。

## 派发的事件
| 事件 | 时机 | detail |
|---|---|---|
| `ui:change`（可取消） | 用户点击 / Space / Enter 切换（乐观翻转，被取消则回滚） | `{ value: boolean, previousValue: boolean, source }` |

`update()` / 重绘不派发；`data-ui-keep="aria-checked"` 让 morph 不覆盖用户刚翻的状态（页面在收到 ui:change 并保存成功后再重绘即可）。动效只用 `transform` + `background-color`，150ms；`prefers-reduced-motion` 下滑块直接切换。

## 转义
`label` / `name` 经 `esc()`。
