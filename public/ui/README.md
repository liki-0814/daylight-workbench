# Daylight UI 组件库（public/ui）

无打包器的 ES module + CSS。页面只组合这里的组件，不写一次性组件 CSS / 标记。

## 目录与依赖方向

```
ui/
  tokens/   theme.css → themes/mist-cyan.css（Sage 原文件，只读）→ semantic.css → legacy-aliases.css
  core/     html / events / morph / icons / behave（不依赖 components、patterns）
  components/<n>/<n>.js|.css|README.md   （只依赖 core）
  patterns/<n>/<n>.js|.css|README.md     （可依赖 components 入口和 core）
pages 只 import  ui/components/<n>/<n>.js、ui/patterns/<n>/<n>.js、ui/core/*。
```

`npm run check` 里的 `lint-deps`（`scripts/lint-deps.mjs`，复用 `scripts/lib/ui-scan.mjs`）强制：
ui/ 不得 import ui/ 之外；core → components → patterns 单向；页面只能 import 入口文件；
组件只能经 `emit()` 派发事件；不得出现内联 style；旧 `public/components/*` 的「非垫片」文件数有棘轮（基线 `scripts/lint-deps-baseline.json`，PR-Z 前清零）。

## 样式层

`ui.css` 第一行声明 `@layer legacy, tokens, ui, page;`，之后的优先级与 `<link>` 顺序无关：

| 层 | 内容 |
| --- | --- |
| legacy | `design-system.css` 与 `legacy.css` / `legacy-quick.css` 导入的所有旧样式表 |
| tokens | 主题 → `semantic.css`（尺寸 / 密度 / 间距 / 动效 / 遮罩，含 `--button-radius`）→ `legacy-aliases.css`（只放旧名→新名） |
| ui | 组件、pattern |
| page | 页面级摆放（只写位置，不写组件外观） |

`index.html` / `quick.html` 只链接 `ui/ui.css` 和 `legacy*.css`。旧样式表整体进入 legacy 层，
否则未分层的旧元素级选择器（`button {}`、`dialog {}`）会压过 ui 层。页面迁完后逐个从 `legacy.css` 删除。
主题只有一处 `@import`（`tokens/theme.css` → `themes/mist-cyan.css`），md5 记在 `tokens/README.md`，`ui-tokens.test` 校验。
强调色描边只用官方令牌 `--color-accent-border`，没有别名。

## 事件契约（core/events.js）

- 名称 `ui:<verb>`，verb ∈ `change | select | open | close | dismiss`；`bubbles: true`；可取消的事件 `cancelable: true`。
- `detail = { value, previousValue?, source: 'user' | 'keyboard' }`，`detailErrors(detail)` 校验。
- 只在用户操作时派发；`update(props)` 不派发。
- 组件只能通过 `emit(target, verb, detail, { cancelable })` 派发（lint 守卫）。
- `data-action` 只用于页面级命令；组件状态变化只走 `ui:*`，页面不得从原生 click 推断组件状态。
- 开关 / 复选 / 分段 / 选择先乐观更新 DOM，再派发可取消的 `ui:change`；页面 `preventDefault()` 即回滚。
- 每个组件 README 的「派发的事件」列出它的事件。

## 转义契约（core/html.js）

- 所有文本 prop 经 `esc()`；`html` 模板里裸字符串一律按文本。
- 子内容只接受 `trusted(str)`（`SafeHtml`）或组件 / `html` 的返回值。
- 属性名经 `attrs()` 白名单（`/^[a-z][a-z0-9:-]*$/`，拒绝 `on*` 与 `style`）。
- 模板里的布尔值放进属性会渲染成空串，一律写 `'true' : 'false'`。
- 每个组件有注入单测（`test/ui-components.test.mjs`：`<img onerror>` 文本不得产生可执行标签）。

## CSP

`style-src 'self'`：不写内联 style 属性；确需动态样式用 CSSOM（`el.style.x = …`）。

## hover 别名 → 组件令牌 映射表

旧代码用全局别名表达 hover 底色；组件内改为组件令牌，取值仍来自主题令牌，后续不再读旧别名。

| 位置 | 旧别名（legacy） | 现在 | 计划的组件令牌 |
| --- | --- | --- | --- |
| `components/button/button.css` 默认 | `--fill-hover` | `--ui-button-hover-bg: var(--color-bg-hover)` | 已落地 |
| `components/button/button.css` primary | `filter: brightness(.96)` | `--ui-button-hover-bg: var(--color-accent-hover)` | 已落地 |
| `components/select/select.css` 触发器 | `--fill-hover` | `--ui-select-hover-bg: var(--color-bg-hover)` | 已落地 |
| `select.css` 菜单项 / 内嵌 chip | `--row-hover` | `var(--color-bg-hover)` 直引 | 待收敛为 `--ui-menu-item-hover-bg`、`--ui-chip-hover-bg` |
| `chip.css`、`nav.css`、`toast.css` | `--fill-hover` | `var(--color-bg-hover)` 直引 | 待收敛为 `--ui-chip-hover-bg` 等 |
| `icon-button.css` | `--fill-hover` | `var(--color-bg-selected)` | 待收敛为 `--ui-icon-button-hover-bg` |

`legacy-aliases.css`：`--fill-hover`、`--row-hover` → `--color-bg-hover`（只做旧名映射，不新增值）。
