# Daylight UI 令牌（0.8）

三层：

1. **主题层** `themes/*.css`：视觉方向 = 一个可替换文件。liki 2026-10-31 14:23 定稿的是 **Mist · A 青绿**（主色 #0D847C），文件**逐字拷贝，不改**。
   `theme.css` 只有一行 `@import`；换方向 = 改这一行。`themes/_candidates/` 里的 Paper / Graphite / Mist 靛蓝（`mist-indigo.css`）未选，
   不被任何 `@import` 引用，打包时会被 `trim-runtime` 裁掉。
2. **共享语义层** `semantic.css`：复合令牌（`--shadow-focus`、`--daylight-now*`）、降低透明度适配，以及**全部尺寸 / 密度令牌**
   （0.7 的数值从 `design-system.css` 原样迁入，外加 0.8 的 `--group-h --toolbar-h --nav-item-h --space-page --space-section` 等；`--button-radius` 也在这里）。
   `design-system.css` 不再新增令牌。
3. **旧名别名** `legacy-aliases.css`：旧 `--bg --text --accent …` → Mist。迁移期存在，PR-Z 删除。

规则：页面/组件 CSS 不写原始 hex / rgb()；颜色一律 `var(--color-*)`（或迁移期的旧别名）。`scripts/lint-ui.mjs` 守护（带下降棘轮）。

0.8 第一阶段：**强制浅色**（`theme-boot.js` 设置 `data-theme="light"`，系统深色也不会触发）；**保留 0.7 尺寸与密度**。

## 层序（@layer，与 `<link>` 顺序无关）
`ui.css` 先声明 `@layer legacy, tokens, ui, page;`：`design-system.css` → legacy；`theme.css` / `semantic.css` / `legacy-aliases.css` → tokens；
组件库 → ui；页面布局 → page。`--color-accent-graphic` 这类设计稿里的临时别名**不使用**，只用官方令牌 `--color-accent-border`。

## 主题来源与 md5（单一来源，防漂移）
- 来源：`/workspace/sage/daylight-design-refs/visual-direction/tokens/daylight-tokens-mist-cyan.css`
- md5：`82ca9af6c6c08e97f98fbe4d9b00ed5e`（`ui-tokens.test.mjs` 校验仓库里的 `themes/mist-cyan.css` 与此一致）
- Sage 改了文件：重新拷贝到 `themes/mist-cyan.css`，同步改上面的 md5，并重跑对比度测试——必须走这一次显式更新。

## info 浅天蓝（Sage，对比度实测见 `test/ui-tokens.test.mjs` 的 info 用例）
Light：图标 / 边框 `#2A9BD3`，文字 `#0B6896`，底 `rgba(71,180,235,.12)`；Dark：图标 `#7CCBF2`，文字 `#A8DDF7`。

### info 浅天蓝：实测对比度（WCAG 2.x，`UI_CONTRAST_REPORT=1 node --test test/ui-tokens.test.mjs` 可重打）
| 底（light） | info 文字 `#0B6896` | info 图形 `#2A9BD3` |
|---|---|---|
| app `#FCFCFD` | 5.96 | 3.04 |
| surface `#FFFFFF` | 6.11 | 3.12 |
| sunken `#F5F6F8` | 5.65 | 2.89 |
| sidebar `#F1F2F5` | 5.46 | 2.79 |
| hover / 选中（压在 surface 上） | 5.60 / 5.22 | 2.86 / 2.66 |
| info 底（12% 天蓝压在 surface / app 上，亮度 0.903 / 0.881，仍然很浅） | 5.55 / 5.41 | 2.83 / 2.76 |

Dark：文字 `#A8DDF7` 在 app / surface / raised / sunken 上 12.91 / 12.13 / 11.25 / 13.20；图形 `#7CCBF2` 为 10.51 / 9.88 / 9.16 / 10.74。

**使用规则（来自实测）**：`--color-info`（#2A9BD3）作图形（边框、圆点）只在 app / surface 上 ≥ 3:1，在 sunken / 选中 / info 底上略低于 3；
所以**承载含义的 info 图标和所有 info 文字一律用 `--color-info-text`**（≥ 5.2:1），`--color-info` 只用于 info 色边框或总伴随文字的小圆点。
