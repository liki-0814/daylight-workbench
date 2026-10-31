# checkbox

`checkbox({ name, checked, label, disabled, attrs })` → SafeHtml（`<button role="checkbox" aria-checked>`，16px 圆形；点击区 28）。`label` 必填。

## 派发的事件
| 事件 | 时机 | detail |
|---|---|---|
| `ui:change`（可取消） | 用户切换（乐观翻转，被取消则回滚） | `{ value: boolean, previousValue: boolean, source }` |

`update()` / 重绘不派发。checkbox 是受控组件：`aria-checked` 不在 `data-ui-keep` 里，重绘（morph）永远写成 props 里的 `checked`；异步保存失败时页面用**未变的 state** 重绘即可回滚乐观翻转，**不要** `setAttribute('aria-checked')`。页面通过 `event.target.closest('[data-id]')` 等自行找到所属行，**不要**从原生 click 推断状态。

## 转义
`label` / `name` 经 `esc()`。
