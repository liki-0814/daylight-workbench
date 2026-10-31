# input

`input({ name, value, label, placeholder, type, variant, icon, kbd, mono, align, live, invalid, multiline, rows, attrs })` → SafeHtml（`<span class="dl-input">` 包着真正的 `<input>` / `<textarea>`）。`label` 必填（`aria-label`）。变体：`field`（带边框 36 高）、`title`（新建任务标题，无边框）、`bare`、`pill`（搜索胶囊）。

## 派发的事件
| 事件 | 时机 | detail |
|---|---|---|
| `ui:change`（可取消） | 默认：失焦 / 回车后值变了；`live: true`：每次输入（IME 组合期间不派发，`compositionend` 时补一次） | `{ value, previousValue, source }` |

`ui:change` 被 `preventDefault()` 时输入框回滚到 `previousValue`。`update()` / 重新渲染从不派发。`data-ui-keep="value"` 让 `morph()` 重绘时保留用户正在输入的值与光标 / IME 状态。

## 转义
`value`、`placeholder`、`label`、`name` 都经 `esc()`；`<textarea>` 内容也转义。

`kbd` 用 `.dl-kbd` 的令牌 `--ui-kbd-fg`：`.dl-input` 里取 `--color-text-secondary`（契约见 button/README.md）。

快捷键 `kbd`：`.dl-kbd` 的契约归 [kbd](../kbd/README.md)。input 只赋值 `--ui-kbd-fg: var(--color-text-secondary)`（`.dl-input`）。
