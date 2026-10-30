# 端到端与视觉回归（Daylight 0.7 · PR-10）

仅桌面宽度，仅浅色。使用 Playwright **库 API**（不引入 `@playwright/test`、axe 或任何新依赖）。

## 运行

```bash
# Playwright 与 Chromium 不在仓库依赖里；本机已有时用环境变量指向
export DAYLIGHT_PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs   # 缺省：import 'playwright'
export DAYLIGHT_CHROME_EXECUTABLE=/path/to/chrome                              # 缺省：Playwright 自带 Chromium
node scripts/e2e.mjs                       # 全部用例，各自规定的宽度（缺省 760/1240/1440）
node scripts/e2e.mjs --grep ext-sk-16      # 只跑某条
node scripts/e2e.mjs --widths 1440         # 指定宽度
node scripts/e2e.mjs --list                # 列出用例
node scripts/e2e.mjs --visual              # 同时做像素基线比对
node scripts/e2e.mjs --update-baseline --reason "为什么变"   # 更新基线（必须写原因）
```

退出码：`0` 与预期一致；`1` 有意外失败，或「已知缺陷」意外通过（需移除 `expectedFail` 标记）；`2` 浏览器不可用（**未验证**，不是通过）。`npm test` 不会启动浏览器；`test/e2e-infrastructure.test.mjs`（PNG 比对、基线策略、L0 扫描、令牌成对、用例目录）在 `npm test` 内运行。

## 隔离与确定性

- **fixture-v1**（`e2e/fixture.mjs`）：每条用例、每个宽度各起一个全新的 Daylight，数据全在 `os.tmpdir()` 下新建的目录里；`home`、Agents 根目录、各软件目录都指向它，**绝不读写真实 HOME**。用后删除。
  15 个 Skills（13 共享 + 2 软件内：含冲突 `api-design`、无效 `broken-skill`、超长名、已接入 `i18n-check`）；6 个 MCP（成功 / 缺凭据 / 命令不存在 / 慢 / 已停用 / HTTP 不可达）；3 个接入软件（Codex、Qoder、Pi）。
- 固定视口 760/1240/1440 × 900，scale 1，浅色，`reducedMotion: reduce`，`zh-CN`，`Asia/Shanghai`，时钟冻结在 2026-10-30 10:00（+08:00），等待 `document.fonts.ready`，截图 `animations: 'disabled'`。应用 CSP 禁止注入样式，所以不靠注入 CSS 冻结动画。
- 除本地服务外的网络请求一律拦截并记录；`ext-shell-01` 断言没有外部请求。
- 凭据哨兵：夹具进程环境里有一个 `E2E_GITHUB_AUTH`，`ext-mcp-07` 断言它的值不出现在 DOM 与 API 响应中。

## 像素比对与基线

`e2e/png.mjs`（零依赖，Node `zlib`）：任一通道差 > 0.1（相对 255）算差异像素；差异占比 > 0.0001 判失败；尺寸不同直接失败。失败时 `e2e/.out/` 里写 `*.actual.png` 与 `*.diff.png`。基线策略见 `e2e/baselines/README.md`：仅 `--update-baseline --reason` 可改，原因追加到 `baselines/CHANGES.md`。**本 PR 不提交基线**——新界面还没落地；同一机器上连续两次渲染 0 像素差已验证。

## 用例与状态

`e2e/cases/extensions-p0.mjs`，ID 与测试计划 §3 一致。`expectedFail` 表示已知缺陷：用例必须失败，修复后它会「意外通过」使运行红灯，提醒移除标记。

| ID | 内容 | 在 0.6.1 UI 上 |
|---|---|---|
| ext-fix-01 | 夹具数量与隔离 | 通过 |
| ext-shell-01 | 三宽度无横向滚动 / 脚本错误 / 外部请求 | 通过 |
| ext-sk-01、ext-sk-03 | 列表、搜索、问题筛选 | 通过 |
| ext-mcp-01、ext-mcp-07 | MCP 列表；凭据值不外泄 | 通过 |
| ext-a11y-01/02 | 图标按钮命名；Tab 焦点可见、不丢 body | 通过（启发式） |
| ext-shell-05 | reduced motion 下无位移/缩放过渡 | 通过 |
| ext-a11y-03 | 目标尺寸 ≥ 24px | 已知缺陷：「只看有问题」复选框 22px |
| ext-sk-16 | 取消预览后复选框恢复、焦点回位（E-26） | **需要 #30（PR-1 前端）**：0.6.1 UI 上失败（复选框仍 disabled），PR-1 前端合入后通过；已去掉 `expectedFail` |
| ext-sk-17 | 归档后焦点不落 body（E-27） | **需要 #30**：0.6.1 UI 上失败（焦点落 body），PR-1 前端合入后通过；已去掉 `expectedFail` |
| ext-sk-09 | 提示不依赖浏览器原生气泡（Iris，`extensions-pr1.mjs`） | **需要 #30**：0.6.1 UI 上失败 |
| ext-mcp-02 | 新建 MCP：字段级错误、非法 URL、http:// 警告（E-16/E-17，Iris，`extensions-pr1.mjs`） | **需要 #30**：0.6.1 UI 上失败 |
| ext-mcp-03 | 新建同 ID：字段下提示、不写盘；服务端 409 兜底（E-01，Iris） | **需要 #30**：0.6.1 UI 上失败（找不到新 UI 元素，30 秒超时），#30 上通过 |
| ext-mcp-09 | 配置损坏：横幅、新建暂停、不覆盖原文件、修复后自动清除（E-07/E-08/E-25，Iris） | **需要 #30**：0.6.1 UI 上失败（找不到新 UI 元素，30 秒超时），#30 上通过 |
| ext-conflict-01 | E-11 接口：compare 只读、不外泄凭据；keepLocal / reopen；adoptShared 后 `operation.restore` 还原（用夹具 Qoder 冲突） | 已知缺陷（0.6.1 无 `skill.resolveConflict`；合入 E-11 后端后自动变为必须通过，到时会提示「意外通过」，无需改标记） |
| ext-sk-07 | E-11 UI 桩：冲突项开关禁用并写明原因；三个冲突动作可达；「对比差异」只读 | 已知缺陷（**需要新 UI**；Iris 前端合入后按真实选择器修正并移除 expectedFail） |

**未实现 / 未验证**：依赖 0.7 新 UI 的用例（ext-shell-02/07/08/09、启用/停用 Skill、导入、批量检测、MCP 交互等）要等 Iris 的前端合入后补；ext-shell-04（深色）不进 0.7。ext-sk-16 只验证了 Esc 路径，点「取消」与点遮罩两条路径待补。a11y 为启发式检查，**未用 axe 验证**，不能当作 WCAG 合规结论。

## L0 静态扫描与令牌成对

`e2e/static-scan.mjs` 扫描 `public/`：P0（红色实心圆、日式意象词）为 0 才通过；P1/P2 只统计（当前 public/：98 个文件，P0=0，P1=4：`outline:none` 3、小于 11px 字号 1）。`tokenPairs()` 检查样式表若有深色块，其令牌必须已在 `:root` 定义（0.7 无深色块，等于空检查）。
