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

快捷键（`kbd`）：文字色来自组件令牌 `--ui-button-kbd-fg`，每个变体自己声明（默认 / ghost / danger 用 `--color-text-secondary`，primary 用 `--color-text-on-accent`，disabled 用 `--color-text-disabled`），都按「对该变体底色 ≥4.5:1」取值，不再用 opacity 冲淡；新增变体必须同时声明它。页面不要覆盖 `.dl-btn > kbd`。
