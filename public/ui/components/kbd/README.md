# kbd

`<kbd class="dl-kbd">⌘↵</kbd>`：快捷键提示。纯 CSS 组件（没有 `kbd.js`）；标记由宿主组件输出（button / nav / input / composer 的 `kbd` 参数，文字经各自的 `esc()`）。尺寸：高 18、左右内边距 `--space-4`、圆角 `--radius-sm`、`--text-xs` 等宽字；描边用 `currentColor`，所以描边与文字同色。

## 派发的事件
**无。** 纯展示。

## 转义
组件本身不生成标记；宿主输出时对文字调用 `esc()`。

## 令牌契约：`--ui-kbd-fg`（唯一一个）
- `.dl-kbd` 的 `color` 是 `var(--ui-kbd-fg, var(--color-text-secondary))`。没有宿主赋值时回退到 `--color-text-secondary`（对 surface / sunken / app 底均 ≥4.5:1）。
- **宿主负责赋值，且取值对自己当前底色必须 ≥4.5:1**（浅色、深色都要）；每个宿主的每个状态（默认 / hover / 选中 / 禁用…）各自给出自己的值。宿主只写 `--ui-kbd-fg: …`，不写 `.dl-kbd` 的任何其它属性。
- **不要用 `opacity` 把 kbd 变淡**（会把前景色与底色混合，对比度由底色决定、不可控；primary 按钮上曾因此掉到 3.26:1）。需要更淡就换一个更淡但仍达标的文字令牌。
- 页面不要覆盖 `.dl-btn > kbd` 之类的宿主内部选择器（lint 规则 7）。
- 新增宿主 / 新增状态：同时给出 `--ui-kbd-fg`，并在宿主 README 里写明取值。
