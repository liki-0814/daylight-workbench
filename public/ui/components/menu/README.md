# menu

`menu({ name, label, trigger, options, placement, variant, attrs, id, disabled })` → SafeHtml：按钮触发的**动作菜单**（「更多」「…」）。触发器 `aria-haspopup="menu"`，面板 `role="menu"`，项 `role="menuitem"`。`options: [{ value, label, icon, meta, danger, disabled, divider }]`；`danger: true` 用错误色文字（删除）。`trigger: { text, icon }` 决定触发按钮上的可见内容（缺省显示 `label` 和向下箭头）。`placement`：`down`（左对齐）、`end`（右对齐，默认）、`up`、`up-end`；下方放不下且上方更宽松时自动翻转。

与 `select` 的分工：`select` 是**值选择器**（`role="listbox"`，保存当前值，选中派发 `ui:change`）；`menu` 是**动作菜单**（选中不保存任何值，只派发 `ui:select`）。页面里的「更多 / 删除 / 编辑…」一律用 `menu`，不要用 `select` 的 `action: true` 凑数，也不要自己写定位的 div 菜单。

键盘：触发器上 ↓ / ↑ / Enter / Space 打开并聚焦第一项；菜单内 ↑ ↓ Home End 移动（循环），Enter / Space 选中，Esc 关闭并回到触发器，Tab 关闭。点击菜单外关闭；同一时间只开一个。菜单向下展开不被弹窗裁切。

## 派发的事件（目标是 `.dl-menubtn` 根元素，冒泡）
| 事件 | 时机 | detail |
|---|---|---|
| `ui:open` | 菜单打开 | `{ value: '', source }` |
| `ui:close` | 菜单关闭 | `{ value: '', source }` |
| `ui:select` | 选中某一项 | `{ value: <项的 value>, source }` |

`update()` / 重绘 / 程序化关闭（`closeMenus(scope)`）从不派发 `ui:open` / `ui:close`，只有用户操作才派发；`setOpen` 不导出。`data-ui-keep` 让 morph 重绘时保留打开状态。

**页面怎么区分是哪个菜单**：给 `menu({ name: 'more' })`，根元素带 `data-name="more"`；页面在 `document` 上监听 `ui:select`，只用 `event.target.dataset.name === 'more'` 判断，**不要**用 class 名（`.dl-menubtn…`）或 `closest('.dl-…')`。（lint-deps 禁止 pages/ 里出现 `querySelector('.dl-…')` / `closest('.dl-…')`。）

## 转义
所有 `label` / `value` / `meta` / `trigger.text` 均经 `esc()`（包括写进 `data-value` 的值）；`attrs` 走属性名白名单；图标是固定路径。
