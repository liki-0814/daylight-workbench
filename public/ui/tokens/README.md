# Daylight UI 令牌（0.8）

三层：

1. **主题层** `themes/*.css`：视觉方向 = 一个可替换文件。Sage 的 Mist（晨雾）已选定，文件**逐字拷贝，不改**。
   `theme.css` 只有一行 `@import`；换方向 = 改这一行。`themes/_candidates/` 里的 Paper / Graphite 未选，
   不被任何 `@import` 引用，打包时会被 `trim-runtime` 裁掉。
2. **共享语义层** `semantic.css`：复合令牌（`--shadow-focus`、`--daylight-now*`）、降低透明度适配。只引用主题变量名。
3. **旧名别名** `legacy-aliases.css`：旧 `--bg --text --accent …` → Mist。迁移期存在，PR-Z 删除。

规则：页面/组件 CSS 不写原始 hex / rgb()；颜色一律 `var(--color-*)`（或迁移期的旧别名）。`scripts/lint-ui.mjs` 守护（带下降棘轮）。

0.8 第一阶段：**强制浅色**（`theme-boot.js` 设置 `data-theme="light"`，系统深色也不会触发）；**保留 0.7 尺寸与密度**。

更新 Mist：把 Sage 的新文件拷到 `themes/mist.css`，跑 `npm test`（契约 / 对比度 / 未定义变量测试会指出漂移）。
