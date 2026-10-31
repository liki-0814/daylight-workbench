# select

`select({ name, value, label, options, variant, placeholder, search, placement, attrs })` → SafeHtml：触发按钮 + `role="listbox"` 菜单。`options: [{ value, label, dot, icon, meta, divider, action }]`。变体 `field`（36 高）、`chip`（胶囊属性标签）、`ghost`。`search: true` 加搜索框（只做 DOM 过滤）。`action: true` 的选项（如「新建项目…」）不改变值。

键盘：触发器上 ↓ / ↑ / Enter / Space 打开；菜单内 ↑ ↓ Home End 移动焦点，Enter 选中，Esc 关闭并回到触发器，Tab 关闭。点击菜单外关闭。菜单向下展开，不被弹窗裁切（`dialog` 为 `overflow: visible`）。

## 派发的事件（目标是 `.dl-select` 根元素，冒泡）
| 事件 | 时机 | detail |
|---|---|---|
| `ui:open` | 菜单打开 | `{ value, source }` |
| `ui:close` | 菜单关闭 | `{ value, source }` |
| `ui:change`（可取消） | 选中了一个与当前不同的值（乐观更新，被取消则回滚） | `{ value, previousValue, source }` |
| `ui:select` | 选中了 `action: true` 的项 | `{ value, source }` |

`update()` / 重绘从不派发；`data-ui-keep` 让 morph 重绘时保留打开状态与搜索输入。

## hover 取值映射（建议 6）
| 旧别名 | 组件令牌 | 取值 |
|---|---|---|
| `--select-hover-bg`（旧 select.css 里借用 `--button-hover-bg`） | `--ui-select-hover-bg` | `--color-bg-hover` |
| 菜单项 hover | — | `--color-bg-hover`；选中 `--color-bg-selected` |

## 转义
所有 `label` / `value` / `meta` / `placeholder` 均经 `esc()`（包括写进 `data-value` / `data-label` 的值）。
