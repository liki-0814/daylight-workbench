# switch

`switchControl({ name, checked, label, busy, disabled, attrs })` → SafeHtml（`<button role="switch" aria-checked>`）。`label` 必填。`busy` 加 `aria-busy="true"`（代理「启动中」时开关已为开启态）。

## 派发的事件
| 事件 | 时机 | detail |
|---|---|---|
| `ui:change`（可取消） | 用户点击 / Space / Enter 切换（乐观翻转，被取消则回滚） | `{ value: boolean, previousValue: boolean, source }` |

`update()` / 重绘不派发；switch 是受控组件：`aria-checked` 不在 `data-ui-keep` 里，重绘（morph）永远把它写成 props 里的 `checked`；页面在收到 ui:change 并保存后带着真实的 `checked` 重绘即可，**不要**再 `setAttribute('aria-checked')`。动效只用 `transform` + `background-color`，150ms；`prefers-reduced-motion` 下滑块直接切换。

## 转义
`label` / `name` 经 `esc()`。
