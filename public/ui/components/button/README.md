# button

`button({ label, icon, variant, kbd, attrs, disabled, busy, type, children })` → SafeHtml。变体 `default | primary | ghost | danger`；控件高 36（`--control-h`），左右内边距 14（`--control-px`），圆角 9（`--radius-control`）。

## 派发的事件
**无。** 按钮只承载页面级命令：用 `attrs: { 'data-action': '…' }`，由页面监听。组件自己的状态变化（开关、选择、勾选）见 switch / select / checkbox。

## 转义
`label`、`kbd`、`attrs` 的值都经 `esc()`；`children` 只接受 `trusted()` / 组件返回值，裸字符串按文本处理。属性名走白名单（`on*`、`style` 抛错）。

## hover 取值映射（建议 6）
旧别名 → 组件令牌。0.8 改为组件令牌，数值来自主题层：

| 旧别名（legacy-aliases / design-system） | 组件令牌 | 取值 |
|---|---|---|
| `--button-hover-bg` | `--ui-button-hover-bg` | `--color-bg-hover`（primary：`--color-accent-hover`） |
| `--button-active-bg` | `--ui-button-active-bg` | `--color-bg-selected`（primary：`--color-accent-active`） |
| `--button-border` | `--ui-button-border` | `--color-border-default`（primary：透明） |
| `--button-radius` | `--radius-control` | semantic.css 里原 `--button-radius` 已搬走，值 `var(--radius-md)` 留给旧页面 |

快捷键（`.dl-kbd`，定义在 button.css，button / nav / input / composer 共用）只有一个契约令牌 `--ui-kbd-fg`：
- `.dl-kbd` 自己 `color: var(--ui-kbd-fg, var(--color-text-secondary))`，**不用 opacity**（opacity 会把前景色和底色混合，白字在主色底上掉到 3.26:1）；描边用 `currentColor`。
- 宿主组件只做一件事：按变体 / 状态给 `--ui-kbd-fg` 赋值，且取值对自己当前底色 ≥4.5:1。button：默认 / ghost / danger = `--color-text-secondary`，primary = `--color-text-on-accent`，disabled = `--color-text-disabled`；nav：默认 secondary、hover / 选中 = `--color-text-primary`；input：secondary；composer 头部：tertiary。
- 新增变体 / 状态必须同时给出它的 `--ui-kbd-fg`。页面不要覆盖 `.dl-btn > kbd`（lint 规则 7）；不要给 `.dl-kbd` 加 opacity。
