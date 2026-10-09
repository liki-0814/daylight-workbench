# 日历与专注界面验收

所有写入仅针对独立 `WORKBENCH_DATA_DIR` 临时数据。`node:test` 中的桥接、控制器和客户端测试验证逻辑，不替代本清单的实际界面证据。Node 与 headless 原生的契约/性能报告也不替代 GUI 通知授权或投递。

## 浏览器流程

- [ ] 日历 42 格、今天与选中日期分别显示；方向键 ±1/±7、Home/End、PageUp/PageDown、Enter/Space 可用；31 日换到 2 月夹紧且焦点仍在日期格。
- [ ] 选择未来日期 → 创建任务 → 只在所选日期安排；项目筛选中的新建表单默认该项目，取消日期勾选则不安排。
- [ ] 同任务在 A/B/C：A 改到 B 合并目标，C 不变；一次撤销恢复全部；done 既有引用可移出/改期，新加入 done 拒绝。
- [ ] 搜索、项目、未归类、状态条件与月格/详情一致；状态切换前计数；筛选下不提供局部顺序写入。
- [ ] 新旧撤销：旧 PUT 修改标题 → 日历改期 → 撤销只还原日期；日历改期 → PUT → 撤销只还原 PUT；外部版本变化清除撤销按钮。
- [ ] 从日历切到 AI 再返回、刷新与前后退保留日期/项目/搜索；跨午夜仅 today 更新，calendar.selectedDay 不跳。
- [ ] 开始专注不更改 task active/plans/version；今日 active 与专注对象不同，两个标签明确显示；未完成任务才能开始工作轮次。
- [ ] 全局条跨任务/日历/AI/代理/CLI/设置保持同一节点；一秒更新只 patch 数字，不重建按钮；没有每秒 aria-live 播报。
- [ ] 暂停 → 继续 → 提前结束 → 再来一轮/短休息；切换明确确认旧轮结束；00:00 显示结果待保存，等待服务归档。
- [ ] 开任务详情期间编辑标题/项目/备注，专注统计异步返回不覆盖输入；“开始专注”提示使用已保存内容；关闭详情取消查询，不停止全局计时。
- [ ] 专注设置只影响新会话；表单编辑期间外部 settings 变化保留输入并要求核对；读取设置和 AI 修改不会弹通知授权。
- [ ] 今天/近 7/近 30/自定义范围，项目与任务筛选，工作/休息列表；指标/日图/项目汇总同范围；0 值日保留；图表键盘可用且数据表替代可展开。
- [ ] 列表分页后外部 focus version 改变回到第一页；已删除任务/项目使用快照并标记删除，不猜测同名对象。
- [ ] 停止服务 → 明确断连、保留原计时和统计、禁用写入；恢复服务后重新核对；未知写入只重试原 body，不创造新请求。
- [ ] 独立 focus JSON 下载不包含 token/receipt/备注/路径，原任务导出保持原范围。
- [ ] 可用内容 960/650px 边界以及 390px 页面截图：日历详情下移、格子只显示数量、无横向页面溢出；全局条不遮挡底部操作；统计表可在自身容器横向滚动。

## 原生 GUI（单独留证）

- [ ] 临时 GUI 首次显式点击“开启系统提醒”：允许/拒绝分别截屏；关闭主窗口仍计时；完全退出后恢复最多归档当前一轮。
- [ ] 点击系统通知设置可跳转；用户改变权限后页面读取实时能力；不把 scheduled 状态称为用户已收到。
- [ ] 已保存到期结果后实际通知出现；暂停、提前结束、切换无未来排定通知；focus 保存或通知消费保存失败时不投递成功提醒。
- [ ] 主框架 exact local origin、子框架拒绝、未知字段/请求 ID 拒绝；headless 从不授权或打开窗口。
- [x] 菜单保持展开时不重建结构；暂停/继续/结束使用点击时最新版本；任务“开始任务”和“开始专注”语义分别验证。

## 2026-10-06 证据登记

| 验收 | 证据与状态 |
| --- | --- |
| 客户端混合撤销、原请求重试 | `test/task-client.test.mjs`，自动测试通过；浏览器行为仍须记录 |
| 日期路由、月末夹紧 | `test/calendar-routes.test.mjs`，自动测试通过；键盘/布局仍须记录 |
| controller 单次未知操作及 late response | `test/focus-controller.test.mjs`，自动测试通过；真实页面 ticker 仍须记录 |
| 报表及任务详情刷新生命周期 | `test/focus-report-refresh.test.mjs`、`test/focus-task-summary.test.mjs`，自动测试通过；三个报表入口共用 `public/focus/report-refresh.js` |
| 设置权限生命周期与错误文案 | `test/focus-settings.test.mjs`，自动测试通过；恢复可见只读取权限，不自动授权 |
| 原生桥相关性/超时/卸载 | `test/focus-platform.test.mjs`，模拟测试通过；真实授权与通知尚需 GUI 证据 |
| 实际浏览器基础流程 | 2026-10-06 独立临时 Chrome profile 完成 13 项，1440×1000 与 620×1000，[报告](../docs/verification/calendar-focus/browser/report.json) 全通过，errors 为空 |
| AI 专注提交恢复卡 | [AI 报告](../docs/verification/calendar-focus/browser/ai/report.json) 6 条断言通过；unknown→原请求 replay→applied→acknowledge，操作消息只记一次 |
| 编辑保护与暂停切换 | [补充报告](../docs/verification/calendar-focus/browser/extended/report.json) 9 项全通过：设置 dirty、重置最新值、未保存任务编辑确认、保存快照与输入保留、实际 15 秒累计刷新、暂停切换取消/确认、390px 设置布局、无异常 |
| 390px 日历、统计与全局条 | [窄屏报告](../docs/verification/calendar-focus/browser/narrow390/report.json) 4 项全通过；三个页面/节点无页面横向溢出，全局条在视口内；项目表和记录表在自身容器滚动 |
| 设置布局与错误显示 | [设置报告](../docs/verification/calendar-focus/browser/settings-polish/report.json) 7 项全通过；1440/390px 三个设置行与右侧复选框对齐，普通网页隐藏原生动作。原生回复在浏览器中模拟，仅验证中文错误、上次读取状态和默认折叠原文，不代表 OS 授权通过 |
| 实际浏览器报表请求生命周期 | [生命周期报告](../docs/verification/calendar-focus/browser/report-lifecycle/report.json) 6 项全通过；真实后台标签页、暂停统计/今日汇总、离开报表页各等待 16.5 秒没有额外报表查询，返回可见立即读取，无异常 |
| 临时原生 GUI 桥接 | [GUI 报告](../docs/verification/calendar-focus/native/gui-report.json) 已验证真实 WKWebView getStatus、用户点击调用 requestAuthorization、OS 错误返回页面；允许/拒绝弹窗、实际投递仍未通过验收 |
| 原生关闭主窗口计时 | [闭窗报告](../docs/verification/calendar-focus/native/closed-window-report.json) 通过；精确 PID 关闭窗口后驻留、倒计时继续，60 秒到期由 timer 保存 completed、通知 none。该样本来自菜单回调修复前构建，最终构建再次核对闭窗驻留；使用独立数据/端口，没有请求或投递通知 |
| 最终原生菜单实操 | [菜单报告](../docs/verification/calendar-focus/native/tray-report.json) 通过；展开期间跨 ticker 保留结构、外部 settings 升版本后实际点击暂停/继续/结束均成功，task v0/todo 保持、通知 none；[任务子菜单报告](../docs/verification/calendar-focus/native/task-submenu-report.json) 通过开始任务→暂停任务→开始专注→结束本轮，分别只改变对应 Task/Focus 版本与状态。真实睡眠唤醒及通知点击仍未验收 |

已通过的基础浏览器范围包括：42 格及日期详情、方向键选择、宽/窄无页面横向溢出、原子改期合并目标引用、undo 恢复源/目标、未来日期新建、任务专注区域、开始专注不改变任务执行状态、暂停/继续/结束及统计历史。截图与报告统一保存于 [验证目录](../docs/verification/calendar-focus/browser/)，补充截图分别位于 `extended/`、`narrow390/`、`settings-polish/`。设置最终截图使用临时 fixture 的默认 25/5 分钟；失败后的权限明确标为“上次读取”，技术原文默认折叠。

六份浏览器报告共 45 条断言通过，其中含 6 条重复的无运行异常守卫，其余为 39 条功能/布局/生命周期断言；这不是 45 个独立端到端场景。证据来自临时数据与隔离浏览器，前端专项回归 29 项通过。上面的清单包含多个细项，未逐项执行的整条仍保留未勾选；模拟原生返回和真实 GUI 桥接分别登记，均不替代允许/拒绝弹窗或通知实际投递证据。

## 2026-10-07 复核修复证据

| 验收 | 本轮证据与状态 |
| --- | --- |
| 合法日期边界与历史 | [独立 Chrome 报告](../docs/verification/calendar-focus/review-fix-browser/report.json) 前 6 条真实页面断言通过：0001-01/9999-12 渲染，边界键盘/月导航不越界，普通日期选择 replace history、换月 push history；临时 Node 服务与合成任务 |
| 冻结后继续与节点稳定 | 同报告第 7–10 条为真实全局条/面板组件加受控 snapshot；验证可信截点前不可继续、时间恢复后不替换按钮节点即可继续、精确 resume action 和零剩余拒绝。不是实际 OS 回拨或恢复落盘证据 |
| 到期投递错误反馈 | 同报告第 11–18 条为受控状态/模拟原生回复；结果面板与设置可见，权限状态和 dirty 设置独立保留，原文转义、同一结果错误更新、390px 无溢出、scheduled 不称已收到、旧错误不污染新结果、旧 snapshot 可降级展示 |
| 浏览器异常守卫 | 同报告第 19 条通过，errors 为空；19 条总计为 6 真实 + 12 模拟 + 1 异常守卫，不能记为 19 条真实端到端流程 |
| AI 审阅和日期定位 | `test/focus-draft-card.test.mjs`、`test/action-links.test.mjs` 自动回归通过：可信标题/阶段/目标/累计/剩余时长及已删除对象恢复，操作 envelope day 与批量子 day 优先，旧消息兼容；本轮未新增真实 AI 卡片点击证据 |
| Codex/Qoder 持久恢复 | `test/focus-ai.test.mjs` 两后端相同本地 HTTP/mock 模型矩阵通过 draft→approve→save→restart→原请求 retry；验证无活跃 run、unknown 原 body 不变、单 waiter 与操作消息去重、只读问题并存；不宣称真实模型推理 |
| 最终源码和原生 | check 与 Node 292/292 无跳过；实际 Swift 任务/24 项任务合同、专注合同、时区及 native AI/proxy/CLI conversations 回归通过。最终 binary SHA256 为 `2f4bac81c44f40920d6e6ac968e2c05820c60986ef18fa677d9fdcffecad8f15` |
| 原生持久通知消费 | `npm run test:native-focus-notifications` 用系统 Swift 执行精确生产源、最终 native-core，两个独立临时目录的真实存储/注入 delivery 断言通过；[报告](../docs/verification/calendar-focus/review-fix-native/notification-consumer-report.json) 保留先前自签名辅助程序启动失败，未请求或投递 OS 通知 |
| 新版性能与安装 | review-fix-performance.json 最终四组合全部预算通过，包含持续持久写负载到期与 consumer RSS；[新版 App 安装读回](../docs/verification/calendar-focus/review-fix-install.json) 通过，实际精确 PID 窗口展示日历/专注/设置入口；旧构建 GUI 记录不自动升级为本轮证据 |

本轮 [390px 错误反馈截图](../docs/verification/calendar-focus/review-fix-browser/delivery-error-settings-390.png) 使用模拟通知状态；[隔离 GUI 允许路径尝试](../docs/verification/calendar-focus/review-fix-native/workspace-gui-allow-report.json) 初始化超时，未产生授权允许证据。系统 allow/deny/display/click、真实 sleep/wake 仍需实操，上方组合清单不因这些局部回归补勾选。
