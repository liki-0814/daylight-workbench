# Daylight 日历、番茄钟与专注统计实施设计

- 状态：**功能已实现，原生 GUI 验收仍有未完成项**。2026-10-05 完成审核修订；2026-10-06 按用户授权通过多智能体协同实施；2026-10-07 完成复核偏差修复与源码回归，新版性能已通过，已完成本地 App 替换及读回。各批次与验证状态见第 17 节，原生 GUI 证据单独登记。
- 基线提交：`156250b70ffce8ecb1eec218055bc963e85feb29`。
- 适用范围：网页服务、macOS 原生 App、内置 Codex/Qoder 工具、外部 Daylight Skill。
- 实施授权：2026-10-06 用户要求“多智能体协同开发，完成实施计划”，覆盖仓库实现、测试、打包与说明，当次未替换已安装 App。2026-10-07 用户另行授权修复偏差、重新测试并替换 App；已完成本地替换、签名/文件摘要及实际窗口读回，旧 App 与完整数据备份保留。不提交/push、不改写真实任务/对话/凭据，不同步独立安装的 Skill。
- 文档结构：产品边界 → 前端交互与组件 → 文件职责 → 数据与统计 → 接口与 AI → 双运行时 → 实施、测试与审核。

## 目录

1. [设计依据与现状](#1-设计依据与现状)
2. [目标、非目标及关键决策](#2-目标非目标及关键决策)
3. [日历产品与交互](#3-日历产品与交互)
4. [番茄钟、统计与菜单栏交互](#4-番茄钟统计与菜单栏交互)
5. [公共组件及样式设计](#5-公共组件及样式设计)
6. [文件级改造清单](#6-文件级改造清单)
7. [日历业务模型及写入](#7-日历业务模型及写入)
8. [专注数据存储与状态机](#8-专注数据存储与状态机)
9. [统计口径与查询](#9-统计口径与查询)
10. [HTTP 接口与能力声明](#10-http-接口与能力声明)
11. [内置 AI 和外部 Skill](#11-内置-ai-和外部-skill)
12. [运行时、原生通知及同步](#12-运行时原生通知及同步)
13. [对现有架构的影响和兼容性](#13-对现有架构的影响和兼容性)
14. [分批实施与提交](#14-分批实施与提交)
15. [测试和验收](#15-测试和验收)
16. [审核清单与风险](#16-审核清单与风险)
17. [实施与验证记录](#17-实施与验证记录)

## 1. 设计依据与现状

### 1.1 来源与参考

本设计以当前仓库代码、仓库现行说明和审核结果为依据，不需要竞品调研或处理真实统计数据。审核已读取 Apple 的通知调度和授权说明，用于确认平台 API 语义；资料核对本身不代表实现或真实 GUI 验证，当前结果见第 17 节。其余外部链接供实现阶段核对。

| 来源 | 本文采用的事实 |
| --- | --- |
| [`../../README.md`](../../README.md) | 本地个人工作台；网页和原生运行；任务管理不依赖 Node 侧车 |
| [`../tasks.md`](../tasks.md) | 任务、今天、项目筛选、日期引用、撤销及导航语义 |
| [`../development.md`](../development.md) | `core` 共享契约、原子保存、版本检查、资源允许列表及公共组件 |
| [`../native-app.md`](../native-app.md) | macOS 13+、菜单栏驻留、网页与 App 同端口约束 |
| [`../ai.md`](../ai.md) | 内置 AI 只生成写入草稿，由用户应用；未知结果重试原请求 |
| [`../../skills/daylight-workbench/references/api.md`](../../skills/daylight-workbench/references/api.md) | Agent Bearer、任务操作及客户端契约 |
| `public/app.js:24–50, 99–145, 147–163, 178–258, 260–444` | 页面生命周期、整页重渲染、任务行、弹窗、版本保存和轮询的现有入口 |
| `public/model.js:5–30, 32–102` | schema 1、单 active 任务、`plans[day]` 和任务变更逻辑 |
| `agent-api.mjs`、`core/task-write.js` | 任务 action、batch、回执、撤销和纯写决策 |
| `core/contracts.js`、`native/core-entry.js` | 统一路由、鉴权及 JavaScriptCore 导出 |
| `server.mjs`、`native/Server.swift` | Node 写锁、Swift 串行队列、业务原子保存 |
| `native/main.swift:44–95` | 菜单栏状态、菜单重建和任务操作入口 |
| `public/components/{button,select,section,task-notes,focus}.js` | 可复用组件及键盘焦点机制 |
| `ai/{service,drafts,run-manager}.mjs`、`ai/tools/dispatch.mjs` | AI HTTP、草稿、运行、工具的职责边界 |
| `public/app.js:99–139, 333, 390–411` | 旧任务保存使用整体 PUT 和本地 undoState；新日历动作必须统一接入写结果及撤销状态 |
| `ai/store.mjs:10–14`、`ai/run-manager.mjs:44–46, 69–87` | 重启和 run 清理会移除 pending；已提交专注请求必须独立保存，恢复不能依赖活跃 waiter |
| `native/main.swift:42–44`、`native/Launcher.swift:94, 132` | 主窗口尚无专注授权桥；快速搜索已有受限 WKScriptMessageHandler 接入，可参考其平台边界 |

实现时可核对的官方参考网址：

- 原生通知：https://developer.apple.com/documentation/usernotifications
- 本地通知调度（审核已核对）：https://developer.apple.com/documentation/usernotifications/scheduling-a-notification-locally-from-your-app
- 通知授权（审核已核对）：https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications
- WebView 原生消息处理：https://developer.apple.com/documentation/webkit/wkscriptmessagehandler
- 系统睡眠/唤醒通知：https://developer.apple.com/documentation/appkit/nsworkspace
- 浏览器通知能力：https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API
- 页面可见性：https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
- 原生日期/时区计算：https://developer.apple.com/documentation/foundation/calendar
- JavaScript 日期格式化：https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat
- 日历键盘交互参考：https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/examples/datepicker-dialog/

本文不生成架构图片或统计图片。文字布局示意只是交互说明；真实图表属于之后实现的网页组件。

### 1.2 现有架构需要保留的特点

1. 任务数据仍是 `state.json` 中的 `projects / tasks / plans`，schema 为 1。
2. `plans` 是按日期保存的有序任务 ID 列表，同一任务可以出现在多天。
3. 任务状态只有 `todo / active / done`，最多一个 active；它不是番茄钟状态。
4. 网页与 Swift 通过 `native-core.js` 复用共享 JavaScript 业务规则。
5. `core/web-assets.json` 是静态资源白名单；不能只新增文件却忘了登记和打包。
6. 前端不是 React/Vue 项目；公共组件目前以模板函数、挂载函数和原生控件为主。
7. 原生 `public/components/focus.js` **是输入方式/焦点可见性脚本，不是专注计时模块**。不覆盖、不改名、不把它当番茄钟复用。
8. 现有任务页保存使用 `PUT /api/state`；Agent 任务写入使用 `/api/v1/actions`。本次不强迫所有旧页面一起迁移。
9. 原生主窗口关闭后 App 继续驻留；AI/代理依赖 Node 侧车，但任务和新番茄钟不能因此依赖 Node。

## 2. 目标、非目标及关键决策

### 2.1 本次完整交付范围

- 日历月视图、日期详情、项目/状态/搜索筛选、按日添加任务及原子跨日改期。
- 番茄钟工作/短休息、暂停/继续/提前结束、到期处理、持久化和恢复。
- 今天页反馈、全局专注条、任务详情统计、独立专注统计页。
- 今日、近 7 天、近 30 天、自定义范围统计；按日、项目汇总和分页会话记录。
- macOS 菜单栏控制、到期通知、关闭窗口不停止计时。
- 内置 AI 只读查询及受审核写草稿；外部 Skill 查询和明确授权后的写入。
- Node/Swift 契约一致、资源打包、隔离测试和文档说明。

### 2.2 非目标

- 六种日历视图、周小时排程、时间块、截止日期、重复任务和外部日历同步。
- 习惯打卡、四象限、长期休息自动循环和自动完成任务。
- 工时计费、效率评分、排行榜、人是否实际工作/离开电脑的自动识别。
- 云同步、账号系统、多进程共享写同一数据目录、跨设备协同。
- 清空/删除/编辑历史计时、手工补录时长、全局任务+专注联合事务。
- 引入前端框架、通用状态管理库、数据库或大型图表库。

### 2.3 建议冻结的产品决策

以下是本文为可实施性提出的默认方案，审核时可以调整；实现不能自行换一套语义。

| 编号 | 建议决策 | 原因及影响 |
| --- | --- | --- |
| D1 | 日历是任务范围，侧栏不新增日历平级页面；任务范围增加“日历” | 保留任务主线，项目和搜索是同一套筛选 |
| D2 | 侧栏新增“专注统计”；计时本身不新增全屏独立页面 | 统计需要可访问入口，计时贴近执行 |
| D3 | “开始任务”和“开始专注”分离；开始专注只写 focus 数据，不自动切换 active 或加入今天 | **细化此前讨论**：避免一次操作跨两个文件形成半成功；用户可以专注未加入今天的任务 |
| D4 | 工作默认 25 分钟、短休息 5 分钟；均允许设置；不自动开始下一阶段 | 不产生无人参与的连续多轮记录 |
| D5 | 第一版工作会话必须关联一个真实未完成任务；休息可不关联任务 | 不额外创造临时任务或自由计时分类，工作记录归属明确 |
| D6 | 计时采用墙上时间，睡眠/退出期间继续经过，到期最多计满本轮 | 可恢复、不要求进程一直每秒运行；不等同真实工时 |
| D7 | 项目统计按会话开始时的项目归属；任务累计按 taskId | 迁移任务后历史项目投入不重写 |
| D8 | 专注数据独立 `focus.json`；第一版不裁剪历史、不存权威累计数 | 不干扰任务撤销，统计可以重算 |
| D9 | 专注统计时区在首次初始化时固定，第一版不提供更换；页面说明时区 | 避免旅行/系统时区变动让既有报表日期无提示改变 |
| D10 | 任务完成/删除后自动结束关联工作会话；撤销任务不复活计时会话 | 任务结果优先，不虚构过去的运行过程 |
| D11 | 跨日改期不改变任务执行状态；保留旧 `plan.remove` 默认行为 | 不破坏老 Skill，日历行为明确 |
| D12 | 第一版改期用日期选择确认；拖拽作为后续增量，不是首版验收项 | 保证键盘、触屏和原子失败恢复先可用 |
| D13 | 到期通知只在会话成功归档后投递，不在启动/继续时预排未来系统通知 | 与保存失败不发成功通知一致；退出/睡眠期间仍不保证准时响铃 |
| D14 | 新旧任务写入口共用客户端提交结果及撤销描述；旧页面仍可 PUT，日历使用服务端 action/undo | 不迁移全部旧动作，也不保留两套互不感知的撤销状态 |
| D15 | AI 已批准且提交的专注请求保存在 conversation.focusSubmission，生命周期独立于 pending/run | 重启后只核对或重试原请求，不自动重提草稿或恢复模型生成 |
| D16 | 到期和任务终止统一按可验证的最早结束时刻裁决；未知删除时刻采用保守恢复 | 防止提前完成被误算为完整轮；明确不确定记录的计时边界 |
| D17 | 存储性能门槛前置到批次 C0，通过后才继续 C1 和 D–F | 避免前端、原生和 AI 接入完成后才发现存储方案需返工 |

## 3. 日历产品与交互

### 3.1 页面结构

任务页范围控制改为“全部任务 / 今天 / 日历”。选中日历后，顶部共享标题、搜索和新建任务入口，内容区使用双栏。

文字布局：

```text
任务                          搜索任务…
[全部任务] [今天] [日历]
[全部项目 ▾] [待办] [已完成] [全部]

[上一月] 2026 年 10 月 [下一月] [回到今天]

月历（月～日）                         10 月 4 日 周日
42 个日期格                           2 项待办 · 1 项已完成
日期、项目色点、最多 3 条任务           当日有序任务列表
超过显示“还有 N 项”                    [选择任务] [新建任务]
```

- 第一版固定 6 行 × 7 列，周一为第一列，避免月切换造成大幅跳动。
- 非本月日期降弱显示，仍可选择；选择后 URL month 跟随该日期的月份。
- 今天：使用 `aria-current="date"` 和今天标记；选中日期：独立边框/背景，不能混淆。
- 日期格预览以日期计划顺序为准，不按完成时间重排；已完成条目有状态标识。
- 月历统计遵循当前项目/关键词过滤；待办和已完成计数在状态过滤前计算。
- 0 项任务是正常空日期；搜索零结果显示“当前筛选下没有任务”，不把它误称为无安排。
- 日历是“日期安排及任务当前状态”，不是某一天结束时的状态快照。

### 3.2 交互流程

**查看日期**：选择日期 → 更新详情 → 替换当前路由 date；前后月操作可以 push 导航历史，连续键盘选日采用 replace，避免几十条历史。

**选择已有任务**：日期详情“选择任务” → 共用任务选择器 → 目标日期在标题中明确显示 → `plan.add`。已在该天的任务显示“已加入”；多天引用不阻止添加。

**新建任务**：默认勾选“安排到 YYYY-MM-DD”，使用选中日期，而不是内部“同时加入今天”标签。表单中的任务字段和备注编辑器不重新实现。

**移出当天**：移除该天 ID 引用，任务仍在项目/未归类中；不结束专注、不改变 active（使用新增显式保留执行参数）。

**改期**：选择任务的“改到日期” → 公共日期字段 → 预览“从 A 移到 B，其余安排不变” → 一次原子 action。禁止用两个 HTTP 请求拼接。

**调整当日顺序**：复用上/下移动按钮，只对当日待办可操作；空搜索和无项目筛选时启用，过滤状态下避免把局部列表顺序误写成完整计划。

**已完成任务**：允许查看、编辑、移出历史日期或改期既有安排；不允许新加入一个没有该任务的日期。恢复任务使用现有 todo 操作。

**外部变更**：保存冲突保留弹窗输入，读取最新任务并提示；月份和选中日期保持不变。源日期引用已经被删除时改期返回冲突，不自动变成“添加”。

### 3.3 导航与日期状态

不复用现有全局 `day` 作为选中日期。内部命名改为 `today`（实际本地日期）、`calendar.month`、`calendar.selectedDay`。

路由建议：

```text
#calendar&month=2026-10&date=2026-10-04&status=open
#calendar&month=2026-10&date=2026-10-04&project=PROJECT_ID&q=关键词
#calendar&month=2026-10&date=2026-10-04&unassigned=1&status=all
```

- 不把 `calendar` 作为 project ID；修改当前 `viewProjectId`/视图识别时显式区分范围和项目。
- `parseRoute` 保留旧 `#today / #tasks / #task=ID / #project=ID` 行为。
- 缺少 month/date 时默认当前日期；月份无效、日期无效时纠正并提示一次；date 与 month 不一致时以有效 date 推导 month。
- 从任务详情/AI 返回日历时恢复月份、日期、状态、项目和搜索。
- 项目切换只改变筛选，不离开日历、不清空选中日期。
- 今天页午夜更新 today；日历保持用户选中日期，不突然跳到新一天。
- 新建任务快捷键在日历中默认安排选中日期；在其他页面保留旧行为。

### 3.4 响应式与可访问性

- 可用内容宽度约 960px 以上双栏；以下详情移到月历下方。采用组件容器查询或一致的模块断点，不根据整个窗口宽度错误推断侧栏后的可用空间。
- 650px 以下日期格只显示任务色点/数量，完整标题留给详情。页面不产生横向溢出。
- 月历采用 grid + roving tabindex：方向键 ±1/±7 天，Home/End 到本周两端，PageUp/PageDown 切月，Enter/Space 选择。
- 月份切换时夹紧日期（31 日切到 2 月选择最后一天），保留焦点。
- 日期格内不要嵌套任务按钮；日期格是单个交互目标，任务编辑在右侧列表完成。
- 日期格可访问标签包含日期、今天标记、当前过滤下任务数量。

## 4. 番茄钟、统计与菜单栏交互

### 4.1 今天页卡片

- active 任务仍显示“当前正在做”；计时卡片显示“正在专注”。二者相同可合并标题，相异则明确分别显示，不虚假标记。
- 有会话：任务标题、工作/休息标签、`MM:SS`、进度、暂停/继续、结束本轮、查看任务。
- 没会话：对当前 active 提供“开始专注”；没有 active 提供任务选择入口。
- 固定小汇总：“今日专注计时 / 完整轮数 / 提前结束次数”，标注“所有任务”；点击进入统计。
- 完成任务仍是独立任务 action。操作前说明将结束相关计时；不通过 focus.finish 自动标记任务 done。
- 到期状态展示“本轮已结束”，提供开始休息/再来一轮/查看统计；再来一轮须再次验证任务仍未完成。

### 4.2 全局专注条

在 `#app` 的页面区域之外保留独立节点，初始化一次，不随 `taskRoot.innerHTML` 重建。

```text
● 工作 · 修复登录问题       18:42    [暂停] [展开]
```

- 跨任务、日历、AI、代理、CLI、设置持续显示；无会话且无待查看结果时收起。
- 展开使用公共 dialog 外壳 + 专注内容组件；与任务弹窗互斥，不嵌套 modal。
- 断开服务显示“连接中断，计时状态待核对”，禁用写操作；可以显示估算数字，但不能宣布保存成功或到期已归档。
- 点击停止/暂停后等待服务确认；对数字更新使用独立 DOM patch，不每秒重建标题、按钮和焦点。
- 视觉 ticker 每秒更新，`aria-live` 不播报每一秒；只播报阶段转换。
- 不修改 AI 页面浏览器标题作为权威计时入口；必要时仅在任务页面附带时间，避免频繁 title 变更。

### 4.3 任务详情

在现有 task dialog 中以 `disclosureSection` 增加“专注记录”：累计计时、完整轮数、最近 5 次、开始专注、查看统计。

- 查询与表单保存分离；响应仅 patch 专注区域。
- 关联使用已保存 taskId；未保存的标题/项目不进入会话快照。
- 点击开始前若有未保存编辑，提示“使用已保存任务，先保存或继续”；不能默默丢失输入。
- 关闭弹窗取消该详情的请求和订阅，不停止全局计时服务。
- 删除任务后列表仍保留历史快照；详情链接显示“任务已删除”，不按名称猜测替代对象。

### 4.4 专注统计页

侧栏“专注统计”，路由 `#focus`。默认今天，允许今天/近 7 天/近 30 天/自定义；近 7/30 天含当天。

- 顶部：范围、项目筛选、任务筛选（通过任务详情跳转时带入）、统计时区提示。
- 指标：专注计时、完整轮数、提前结束次数；计时包含当前运行会话时有“含当前计时”标记。
- 每日柱状图：同一范围每日一条，0 值也显示；超过 31 天仍保留每日数据，图可水平滚动，提供表格替代，不偷偷聚合成周导致口径变化。
- 项目汇总：按会话项目快照聚合；已删除项目保留快照；同名不同 ID 分开。
- 会话记录：开始时间、任务、项目、实际计时、结束原因、当前状态；默认每页 20 条。
- 工作记录默认展示；可选择休息记录，但休息不会混入工作指标。
- 筛选后完整轮数/提前结束次数与项目汇总、列表都使用同一过滤条件。
- 不把当前正在运行的轮次算成完整轮数。
- 加载保持原结果并显示 loading；失败保留旧数据、标记“尚未更新”，提供公共刷新按钮；首次失败显示可重试错误。
- 导出第一版提供独立 JSON 下载：全部设置和会话，不包含 token/回执；不改变任务导出。

### 4.5 设置

在设置页增加“专注”分区：

- 默认工作时长：1–180 分钟，整数；默认 25。
- 短休息时长：1–60 分钟，整数；默认 5。
- 到期提醒开关、声音开关、菜单栏时间显示开关。
- 显示已固定的统计时区，第一版只读。
- 当前轮次使用启动时的 duration 快照；改设置只影响新会话。
- 通知授权由用户点击“开启系统提醒”后通过第 12.4 节的原生消息桥请求；普通浏览器按自身能力处理，headless 不提供授权。访问设置页或 AI 修改 settings 都不弹系统授权框。
- 休息手动启动；不提供“自动连续运行”开关。

### 4.6 菜单栏

- 保留现有“今日任务 / 其他待办 / 新建 / 快速搜索 / 工作台 / 数据目录”。
- 顶部新增专注阶段、剩余时间、任务标题、暂停/继续/结束操作。
- 任务子菜单增加“开始专注”，原“开始任务”语义不变。
- 新增“打开日历”“查看专注统计”。
- 有会话时可显示菜单栏时间，没会话恢复原待办数量。
- 菜单展开时不要每秒替换 `NSMenu`。结构更新在 menu open/close 和业务变更点进行，ticker 只更新指定文本；跟踪期间结构变化延迟至关闭后。
- 菜单按钮使用点击时最新 focus version，不使用构建菜单时的旧快照盲写。
- 切换会话需要确认；可以打开主窗口确认，而不是在后台自动结束原会话。

## 5. 公共组件及样式设计

### 5.1 复用现有组件

| 组件/样式 | 本次复用方式 | 不做的事 |
| --- | --- | --- |
| `components/button.js` + `button.css` | 所有新按钮使用 `actionButton`，继承 variants、disabled、focus、尺寸 | 不复制一套日历/番茄按钮颜色和高度 |
| `components/select.js` + `select.css` | 项目、任务、phase 筛选 | 不再写自定义下拉 |
| `components/section.js` | 设置标题、刷新、任务记录折叠区 | 不新造多套卡片标题 |
| `components/task-notes.js` | 新建/编辑任务备注 | 不改变备注格式 |
| `components/icons.js` | 新增 calendar/timer/chart 图标定义，所有入口统一使用 | 不在每个页面粘 SVG |
| `components/focus.js` | 原键盘/指针焦点策略继续工作 | 不用于计时状态 |
| `design-system.css` | 字体、留白、色彩、面板、状态反馈与尺寸 tokens | 不散落固定字号/魔法颜色 |
| `#dialog` 和 toast | 任务弹窗保留；toast 反馈复用 | 不把专注消息伪装成任务撤销 |

### 5.2 新增可复用组件及 API

新增样式必须与新组件绑定，模块 CSS 只做布局和业务组合。第一版不把无关老页面全部迁移到新组件。

| 拟议文件 | 导出/接口 | 职责与复用场景 |
| --- | --- | --- |
| `public/components/segmented-control.js`、`.css` | `segmentedControl({id,label,value,options})`、`mountSegmentedControl(root,{onChange})` → dispose | 任务范围、任务状态、统计时间快捷范围；互斥选择采用 radiogroup 语义，左右键切换，disabled 生效 |
| `public/components/date-field.js`、`.css` | `dateField({name,label,value,min,max,required})` | 基于原生 `input[type=date]` 的统一标签/错误/尺寸；改期、自定义统计范围、新建日期；不重新造弹出日历 |
| `public/components/calendar-grid.js`、`.css` | `createCalendarGrid({onSelect,onMonthChange})` → `{element,update,dispose}` | 42 格、键盘、焦点和选择；只收 days 数据，不知道任务 API；未来可用于日期安排视图 |
| `public/components/metric-card.js`、`.css` | `metricCard({label,value,unit,note,state})` | 今日与统计页数字汇总；`state` 为 ready/loading/error，避免每页一套数字卡 |
| `public/components/progress-meter.js`、`.css` | `createProgressMeter({label})` → `{element,setValue,dispose}` | 通用进度语义及轨道；计时卡和专注条；支持 0–1、文本标签、不负责计时 |
| `public/components/bar-chart.js`、`.css` | `createBarChart({label,onSelect})` → `{element,update,dispose}` | 接收 `{key,label,value,valueText}`；SVG 柱状图、tooltip、键盘、数据表替代；无统计算法 |
| `public/components/pagination.js`、`.css` | `pagination({hasPrevious,hasNext,label})`、`mountPagination` → dispose | 会话记录上一页/下一页，未来可复用其他列表；不自己请求数据 |
| `public/components/dialog-shell.js`、`.css` | `createDialogShell({title,description,onClose})` → `{element,open,close,setContent,dispose}` | 专注展开、会话切换确认共用；原生 dialog、返回触发焦点、Escape/背景关闭、提交中禁用关闭；不强改现有 AI 删除弹窗 |
| `public/components/task-row.js` | `taskRow(task,{project,context,busy,actions})` | 从 app.js 提取现有任务行模板，增加 date 上下文；任务列表/日历详情/选择器共用；样式先复用现有 task-row |
| `public/components/task-picker.js` | `createTaskPicker({getState,onChoose,targetDay,mode})` → `{element,update,dispose}` | 复用 selectTasks、任务行和 select；日期安排/专注启动两种选择模式 |
| `public/components/date-range.js`、`.css` | `createDateRange({value,onChange,maxDays})` → `{element,update,dispose}` | 组合 segmented-control 和两个 date-field，管理合法范围与快捷值；不执行统计查询 |

组件约束：

1. 静态模板沿用 escaping 规则；`content` 等可信 HTML 参数由调用者负责，不插入用户未转义标题。
2. 挂载组件使用 AbortController 管理监听；销毁后不保留 window/document 监听。
3. 所有订阅、ticker、请求有明确 dispose；`setVisible(false)` 暂停页面查询，不销毁全局计时状态。
4. 不使用 `data-action="start"` 等全局旧 action 名称触发专注。专注采用 `data-focus-action`，日历采用 `data-calendar-action`；监听检查拥有该目标的根节点，避免 document 代理误处理。
5. 通用组件 dispatch 自己的 `change` 或回调，业务模块映射成 action；组件不读全局 task state、token 或 fetch。
6. 不新增万能“组件注册器”“事件总线”“通用 dashboard 引擎”。

### 5.3 样式规则和加载顺序

- `design-system.css`：新增真正共享的 tokens，例如 `--font-timer-size / --font-timer-line`、`--metric-grid-gap`、`--chart-accent`、`--progress-track`；避免重复现有 green/line/paper。
- 新组件样式作用域为 `.ui-segmented`、`.ui-calendar-grid`、`.ui-metric-card` 等。
- `public/calendar/calendar.css` 只描述月历与日期详情组合、响应式位置。
- `public/focus/focus.css` 只描述专注卡、全局条和统计页组合，不再次定义按钮、输入、标题基础样式。
- `public/index.html`：基础系统 → 现有页面样式 → 新组件/新页面样式 → `components/button.css` 最后；所有 CSS 使用独立 link，不把 CSS import 当作 JS 的浏览器能力。
- CSP 保持 `script-src 'self' / style-src 'self'`；不引入 CDN、第三方字体或动态内联脚本。
- SVG 图表几何用 SVG 属性更新；进度条动态样式在现有 CSP 下实测，若受限改用 SVG/原生 progress 属性，不放宽 CSP。
- 高频动画不使用环形旋转/跳动；进度最多线性短更新，reduced-motion 关闭空间动画。

## 6. 文件级改造清单

以下是实施时的拟议文件，不表示本次已经创建。文件命名按项目 ES modules 约定。

### 6.1 新增共享核心

| 文件 | 作用 | 依赖和边界 |
| --- | --- | --- |
| `core/date.js` | 严格 date/month 校验、民用日期加减、月格数据、范围长度校验 | 纯 JS；无 DOM、文件、Node；不用 `new Date('YYYY-MM-DD')` 当本地日零点 |
| `core/task-selection.js` | 任务/项目索引、项目/关键词/状态筛选和状态过滤前计数 | 从现有 task-view 提取纯辅助；不 import public；public/task-view 保留旧导出和范围包装 |
| `core/calendar-query.js` | 日期范围安排、每日期过滤计数、预览及项目标签快照 | 依赖 date/task-selection；一轮构建 task/project Map，避免每日重复遍历全量 |
| `core/focus-model.js` | 初始记录、schema 校验、状态转换、统一终止裁决、时钟冻结与通知意图转换 | now/UUID/任务快照/时钟检查结果显式注入；不发通知、不保存文件 |
| `core/focus-write.js` | 请求校验、原请求指纹、独立版本、回执去重、写决策 | 模仿 task-write；SHA-256 由各运行时提供，不在共享层 import hash |
| `core/focus-statistics.js` | 区间裁剪、每日/项目/任务汇总、记录过滤与 cursor | 传入统计日窗口；不假定 JavaScriptCore 支持完整 Intl 时区功能 |
| `core/focus-contracts.js` | focus actions/limits/capabilities/query 参数定义 | 无平台代码；contracts 和工具定义复用声明 |

### 6.2 新增前端业务模块

| 文件 | 作用 |
| --- | --- |
| `public/task-client.js` | 共用任务写客户端：旧 PUT、新 actions、单一撤销描述、busy、409 和原请求重试；提交结果通过 onCommitted 接入 app |
| `public/calendar/page.js` | 日历生命周期、路由输入、月格数据、日期详情、选择/改期操作 |
| `public/calendar/calendar.css` | 日历业务布局 |
| `public/focus/client.js` | focus GET/POST/export，请求超时、错误结构；无 UI |
| `public/focus/controller.js` | 全局快照、单一轮询、ticker、订阅、断连、用户操作；维护 active sessionId 和版本 |
| `public/focus/panel.js` | 计时内容组件；今天页和全局展开共用；不拥有独立计时器 |
| `public/focus/widget.js` | 全局专注条、公共 dialog 的展开/确认；挂载一次 |
| `public/focus/today-summary.js` | 今日汇总订阅/轻量查询，不跟随每秒写状态 |
| `public/focus/statistics-page.js` | 范围、筛选、查询取消、指标/图表/分页组合 |
| `public/focus/task-summary.js` | 任务弹窗中异步统计区域和最近 5 条 |
| `public/focus/settings.js` | 设置分区挂载和独立版本保存；用户点击通知授权 |
| `public/focus/platform.js` | 原生通知桥能力检测、请求 ID 与回复关联、授权/权限刷新/系统设置调用；无计时状态机或文件写入 |
| `public/focus/draft-card.js` | focusChanges 审阅和 focusSubmission 恢复卡；不依赖模型 run 存活 |
| `public/focus/focus.css` | 上述业务布局和响应式样式 |

公共组件新增文件见第 5 节。模块不得直接从 app.js import，避免循环；通过回调传入 getState、openTask、openPicker、navigate 和 notify。

### 6.3 新增 Node/Swift 平台适配

| 文件 | 作用 |
| --- | --- |
| `focus/store.mjs` | focus.json/previous 原子读写、初始化、权限、损坏处理；不调用任务 persist |
| `focus/service.mjs` | 串行专注事务、到期调度、恢复、任务变更核对、接口分发；工作台主服务内运行，不是新侧车 |
| `focus/time-zone.mjs` | Node Intl 统计时区日边界计算，向共享算法提供 `{day,startAt,endAt}` |
| `native/Focus.swift` | 专注文件、串行执行、调用共享 JS、调度和恢复；在 headless 模式也工作 |
| `native/FocusTimeZone.swift` | Foundation Calendar 时区窗口，和 Node 日边界契约对照 |
| `native/FocusNotifications.swift` | 受限 WKScriptMessageHandler、UserNotifications 授权/权限读取、成功归档后的通知意图消费及投递、点击定位；GUI 层限定 |
| `native/FocusTray.swift` | 专注菜单区和文本更新，避免把 main.swift 扩展成所有专注业务 |
| `ai/focus-submissions.mjs` | 已批准专注请求的保存、原请求重试和结果核对；复用 conversation 文件，通过注入 api/save 工作，不新增操作数据库 |
| `scripts/benchmark-focus.mjs` | 批次 C0 的 Node/实际 headless 原生性能基准，自动创建隔离数据，输出环境及预算结果 |

### 6.4 修改现有文件

| 文件 | 具体修改 | 架构影响 |
| --- | --- | --- |
| `public/app.js` | today/selectedDay 分离；接入新页面和 widget；save/mutate/undo 接入 task-client；统一接收 state/version/warnings；提取 taskRow/picker；全局事件按 owning root 分流 | 仍为页面编排器，不写专注状态机或保留第二份 undoState；旧任务编辑、项目、搜索行为保留 |
| `public/routes.js` | calendarRoute/focusRoute、解析和规范化；日历范围与项目分开 | 不迁移业务数据，旧 Hash 兼容 |
| `public/task-view.js` | 索引/过滤委托 core/task-selection，保留 selectTasks/taskQuery、localDate 默认值和旧响应 | calendar 直接复用 core，不反向 import 此包装；不把 range 硬塞进旧 today 查询 |
| `public/model.js` | date 校验复用；新增 reschedule；plan remove 保留执行参数；task create planDay | schema 1 不变，新 action 不改变旧默认 |
| `agent-api.mjs` | actions 声明、字段校验、batch 子项日期、reschedule 调用 | 旧 requestId 指纹不能重新规范化 |
| `core/task-write.js` | 严格复用日期校验；新 action 验证；保留新业务错误的 status/code（当前 catch 固定返回 400，不能直接承诺 reschedule 会返回 409） | 原版本/receipt/undo 不变，旧动作默认错误文案和状态保持兼容 |
| `core/contracts.js` | calendar/focus/Web actions、AI 提交恢复 POST 的方法及鉴权声明、capabilities | 新写入和恢复 POST 使用 webOrigin；先鉴权后 handler，不按模糊 prefix 暴露权限 |
| `core/web-assets.json` | 新 JS/CSS 路由，浏览器用到的 `/core/date.js` 等显式映射 | Node/Swift 静态文件都仍相对 public 读取；见第 13 节 |
| `native/core-entry.js` | 导出 calendar query、date 与 focus 纯函数 | neutral bundle 不新增 Node-only import |
| `server.mjs` | 主服务创建 focus；任务提交后通知 reconcile；web action handler；focus/cal query handler；close 清理 | 不放到 proxy/AI 中；focus 故障隔离 |
| `native/Server.swift` | 服务持有 Focus；新增 handlers；任务保存后 reconcile；串行传入任务快照；通知意图消费与动态能力回调 | JSContext 只在 server.queue 访问；focus 小快照不反复跨桥传入全量历史 |
| `native/main.swift` | 主窗口注册/移除通知消息桥；连接 FocusTray/通知；菜单新增日历/统计；生命周期注册与解除 | 业务调度不靠 main 的 UI timer；主线程不同步等待全量统计 |
| `public/components/sidebar.js` | focus 页面识别、统计入口；calendar 仍高亮任务 | 不出现统计页仍高亮任务的问题 |
| `public/components/settings-page.js` | 提供专注设置挂载区、更新描述 | AI 设置继续独立挂载 |
| `public/components/icons.js` | calendar/timer/chart 图标 | 统一视觉资源 |
| `public/components/action-links.js` | 日历改期、专注操作后的对象链接 | 删除对象标注，不拼错误 Hash |
| `public/design-system.css`、`public/index.html` | tokens 与新组件 CSS 链接 | 不修改全局 UI 基础尺寸作为隐式改版 |
| `public/style.css` | 仅调整任务范围/提取行的接入样式、旧 focus-card 兼容 | 不把新增所有样式追加到此 2000+ 行文件 |
| `ai/tools/definitions.mjs` | 查询工具、focus 草稿工具、task date 字段说明 | 工具 schema 严格，不允许模型指定统计结果/时间戳 |
| `ai/tools/dispatch.mjs` | calendar/focus 查询与 pending focusChanges | 不直接写文件、不控制 native |
| `ai/drafts.mjs` | focusChanges 独立应用分支，委托 focus-submissions；calendar impact | 普通草稿取消无副作用；已经提交的未知请求不能当作未执行草稿删除 |
| `ai/store.mjs` | 保留 conversation.focusSubmission；重启清 pending 时将未终结提交标为待核对 | 未批准 pending 仍按现有规则清理；不自动重试或恢复 CLI waiter |
| `ai/run-manager.mjs` | 清理 run 时保留已提交记录；应用中取消限制覆盖 submission；仅在现存匹配 waiter 上回送结果 | 恢复核对不需要创建 run；不扩大旧 permission/question 的确认权限 |
| `ai/conversations.mjs` | detail 返回提交恢复状态；未核对提交不能被对话删除；operation 消息按 requestId 去重 | submission 与已有会话删除回执不是同一存储或版本 |
| `ai/service.mjs` | 组装 submissions，增加专用恢复路由；只读查询显式序列化 URL 参数 | 保持组装/路由职责，不把计时或恢复业务塞回 service |
| `ai/http.mjs` | API 错误保留 status/code/version/details 供恢复卡核对 | 不吞掉结构化冲突；旧 error 文案和调用方式保持兼容 |
| `public/ai.js` | focus 草稿/提交恢复卡、任务日期字段、结果刷新通知 | 无 pending 或无活跃 run 仍能核对；不能进入普通 taskChanges 默认分支 |
| `ai/context.mjs` | 可选显式日期视图上下文说明；不默认注入全部专注历史 | 避免 token 膨胀和历史隐私扩大 |
| `skills/daylight-workbench/{SKILL.md,references/api.md,scripts/workbench.py}` | capabilities 检查、新查询与 focus-apply | 不自动同步独立安装的 Skill |
| `scripts/build-native.py` | 编译新 Swift 文件和通知 framework，检查资源 | 原生 focus 不打包 Node service 为运行依赖 |
| `scripts/check-proxy.mjs` / `scripts/check-focus.mjs` / `package.json` | 增加 focus 与前端新模块检查；专注检查独立脚本 | 不把所有新验证塞入 proxy 专属脚本 |
| `scripts/trim-runtime.mjs`、`test/runtime-trim.test.mjs` | 保留浏览器 core 依赖和新 CSS；按图裁剪 focus 非原生运行代码 | 不复制无关目录进产物 |
| `README.md`、`docs/{tasks,development,native-app,ai}.md` | 当前功能和边界说明；新增 `docs/focus.md` | 实施验收后更新现行文档，本文仍保留计划身份 |

### 6.5 关键模块导出约定

以下函数签名作为实现契约，参数可以增加可选项，但不能把 IO 偷偷塞进纯核心。

```js
// core/date.js
isCivilDate(value);                        // 严格校验，不归一化 2 月 30 日
addCivilDays(day, delta);                  // 输出 YYYY-MM-DD
monthGrid(month, { weekStartsOn: 1 });     // 42 个 {day,inMonth}
validateDateRange({ from, to, maxDays });

// core/calendar-query.js
calendarQuery(taskState, taskVersion, selection);

// core/task-selection.js；public/task-view.js 只包装旧范围/默认日期。
buildTaskIndex(taskState);
selectIndexedTasks(index, orderedTasks, selection); // 返回 counts 和状态过滤后的 tasks

// core/focus-model.js
initialFocusRecord({ timeZone });
validateFocusRecord(record);
focusSnapshot(record, { now, taskVersion, runtime });
applyFocusAction(record, action, { now, sessionId, taskState });
resolveFocusTermination(current, { now, taskState, taskCommittedAt, recovering });
reconcileFocus(record, { now, taskState, taskCommittedAt, recovering, clockCheck });
consumeFocusNotification(record, outcomeId, { now }); // 生成 attempted 决策，IO 层保存后才投递
// 变更返回 {nextRecord, changed, actionResult, events}，events 不发平台通知。

// core/focus-write.js
prepareFocusWrite(record, request, fingerprint, context);
// 返回 {code,value,nextRecord?}；不持久化，不先更改 record。

// core/focus-statistics.js
focusStatistics(record, selection, { now, dayWindows });
focusTaskSummary(record, taskId, { now, recentLimit });
focusSessionQuery(record, selection, { now, dayWindows });

// focus/service.mjs
createFocusService({ dataDir, getTaskSnapshot, isTaskWriting, clock, timeZoneAdapter });
// 返回 {handle, snapshot, reconcileTasks, subscribe, consumeNotification, close}。
// getTaskSnapshot 返回已提交的 {version,state}，不通过调用本机 HTTP 自己套自己。

// public/task-client.js；持有唯一 taskUndo，不拥有页面渲染。
createTaskClient({ getSnapshot, getToken, onBusy, onCommitted, onConflict });
// 返回 {saveState, act, undo, invalidateUndo, getUndo, dispose}；详见第 7.5 节。

// public/focus/controller.js
createFocusController({ client, getToken });
// 返回 {getSnapshot, subscribe, refresh, act, dispose}。
// subscriber 收到 {snapshot, reason}；reason 为 sync/action/terminal/degraded。

// public/calendar/page.js
createCalendarPage({ getTaskSnapshot, taskClient, openTask, openPicker, onRoute, notify });
// 返回 {element, updateRoute, updateState, setVisible, dispose}。
```

平台回调只承担 now/UUID/任务快照/时区窗口/文件写入；纯核心返回事件，例如 `session-ended`，由运行时解释成通知和页面刷新。UUID 由服务生成，一次 prepare/action重试不能重新生成目标 session ID：首次成功请求的 ID 在回执内返回，receipt 命中时不重新执行状态转换。

### 6.6 依赖方向及初始化顺序

- `public/app.js` → 前端 page/controller → client；公共组件不反向 import app/page。
- `public/task-view.js` 与 `core/calendar-query.js` → `core/task-selection.js`；本次新增纯核心不得 import public/DOM/Node。已有 task-write/contracts 的旧包装依赖保留，不在本次扩大迁移。
- `server.mjs` → focus/service → store + shared core；focus 不 import server.mjs，避免循环初始化。
- `native/Server.swift` → Focus → 已注入 shared JS 函数；FocusNotifications/FocusTray 只订阅，不直接操作文件。
- `ai/tools/dispatch.mjs` → 已有 api 客户端 → HTTP focus handlers；不 import focus/store。
- `ai/drafts.mjs` → focus-submissions → 注入的 api/save；store/run 清理保留持久提交，恢复路由只调用此模块，不启动 AI 后端。
- 初始化顺序：任务记录/凭证 → focus 记录（失败可降级）→ HTTP handlers → runtime 调度 → GUI/controller/AI 按需使用。
- Node 的 task persist 在已提交事件中调用 reconcileTasks；close 必须同时清理 focus timer 和订阅，不能只沿用目前 `closeProxy` 清理代理/AI。
- headless Swift 不初始化 AppKit 提醒 UI；仍初始化 Focus 与时区 adapter。

## 7. 日历业务模型及写入

### 7.1 数据仍沿用 schema 1

```json
{
  "schema": 1,
  "projects": [],
  "tasks": [],
  "plans": {
    "2026-10-04": ["task-a", "task-b"],
    "2026-10-06": ["task-a"]
  }
}
```

不新增 task.calendarDate/events，安排日期不是截止日期，也不是完成时间。

### 7.2 新增和扩展的 action

| action | 字段 | 语义 |
| --- | --- | --- |
| `task.create` 扩展 | `planDay?: YYYY-MM-DD` | 创建任务时原子加入该日期；`today` 旧字段保留；同时指定 `today:true` 和 planDay 拒绝，避免优先级歧义 |
| `plan.add` 保留 | `id`，请求 day | 加入指定日期，重复引用不重复添加；仍拒绝已完成任务新安排 |
| `plan.remove` 扩展 | `id, preserveExecution?: boolean` | 默认 false 保留旧暂停 active 行为；日历传 true，仅删引用，done 也可移出 |
| `plan.reschedule` 新增 | `id, fromDay, toDay` | 原子移动一条已存在日期引用，目标有引用则合并；任务状态完全不变 |
| `plan.move` 保留 | `id,direction`，请求 day | 当日待办顺序，不是跨日改期 |
| `batch` 扩展 | 子 action 可带 `day` | 子 day 覆盖请求 day；只允许 plan.add/remove/move/set；嵌套 batch/undo 仍拒绝 |

子项 day 统一在 applyAction 入口严格校验；非计划 action 带 day 拒绝，task.create 使用 planDay。reschedule 自带 from/to，不接受额外子 day。未知字段拒绝范围只覆盖新增/扩展契约，不顺便收紧全部历史 action 造成兼容破坏。

### 7.3 改期细则

- ID 不存在 404；fromDay 不含此 ID 409 `PLAN_REFERENCE_CHANGED`。
- 日期非法 400；源/目标相同返回 400 `SAME_DAY`，UI 在确认前禁用同日提交，不产生任务版本、不挤掉 undo。
- task.done 可以移动既有安排（相当于移动历史引用），但不能把改期接口当创建新安排使用。
- 目标已有同 ID：移除源引用，保持目标现有位置；目标没有：追加末尾。
- 同任务在第三天的引用不变；其他任务顺序不变。
- 可以清理空 plans key，读取仍按缺失 = []；不要借此重排全部日期对象。
- 状态保存、requestId 回执放在同一任务 record 中；整次改期一个版本，整次可 undo。
- 不新增任务回执-only 的 no-op 保存路径。同日请求直接拒绝；成功改期必须实际改变日期引用。现有 plan.add 的重复添加行为不在本次顺便重构。
- 业务错误使用携带 status/code 的 Error；`prepareTaskWrite` 仅对新增错误保留状态，Node 与 Swift 都消费同一 decision.code，不在某个运行时另判断源日期。

### 7.4 批量日期安排

```json
{
  "requestId": "calendar-batch-001",
  "expectedVersion": 17,
  "action": {
    "type": "batch",
    "actions": [
      {"type": "plan.add", "id": "task-a", "day": "2026-10-04"},
      {"type": "plan.add", "id": "task-b", "day": "2026-10-05"},
      {"type": "plan.reschedule", "id": "task-c", "fromDay": "2026-10-03", "toDay": "2026-10-06"}
    ]
  }
}
```

1–100 个子操作，整体原子、一个版本和一个回执；一项失败整批不保存。已完成日期引用可通过 reschedule 移动，不能用 plan.set 覆盖含 done 的完整日期以绕过现有 unfinished 限制。

### 7.5 新旧写入的结果接入与撤销

现有 app.js 的 `undoState` 是整体 PUT 的本地快照；新增 actions 不能绕过它独立更新 version。`public/task-client.js` 持有唯一 `taskUndo`，app.js 的 save/mutate/撤销入口只调用该客户端，不另保存 undoState。

| 最近一次任务写入 | taskUndo | 撤销请求 |
| --- | --- | --- |
| 旧页面 PUT 成功、允许撤销 | `{kind:'snapshot',version,state:before}` | PUT before，If-Match 必须等于该 version |
| 日历 action 成功、允许撤销 | `{kind:'server',version:appliedVersion}` | POST task-actions 的 undo；新 requestId，expectedVersion=该 version |
| 已撤销、不允许撤销的写入、同步到外部新版本 | null | 清除旧 toast 的撤销入口，不发送旧快照 |

- PUT/actions/undo 共用任务 busy 和 `onCommitted({state,version,warnings}, {source,undo})`。回调更新当前任务快照、视图、撤销按钮和 warning；专注写入不改变任务 version，也不清 taskUndo。
- 每次已确认的任务写入替换前一次撤销描述；GET 同步发现 version 改变则失效。点击撤销再次检查客户端版本，服务仍做最终版本检查；409 保留编辑输入并清除撤销权限，不重基准后自动执行。
- action 的 receipt replay 返回当前 state/version。只有 `version===appliedVersion` 且没有随后任务写入时可建立本次 server 撤销描述；不能把旧动作回执变成对最新任务写入的撤销。
- action 结果未知时保留原 requestId 和原 body，仅允许原请求核对/重试；确认前不显示成功或建立撤销描述。旧 PUT 的未知结果读取任务 state 核对，不假装拥有 action 去重能力。
- 必测序列：旧 PUT 改标题 → 日历改期 → 撤销，只恢复日期，标题保持；改期 → 旧 PUT → 撤销，只恢复最后一次 PUT；外部写入后旧 toast 不得覆盖；同一改期重试不得产生第二次写入或错误撤销目标。

## 8. 专注数据存储与状态机

### 8.1 位置和初始化

```text
~/Library/Application Support/Daylight/
  state.json
  state.previous.json
  focus.json
  focus.previous.json
  agent-token
```

- 遵循 WORKBENCH_DATA_DIR；开发/测试一律用临时目录。
- 首次确实 ENOENT 才创建空 focus；文件损坏、未知 schema、权限失败不能覆盖。
- focus 故障只禁用专注功能，任务/日历/AI/代理仍可用。API 返回 503 `FOCUS_UNAVAILABLE`，主页面显示错误，不初始化假空统计。
- 首版完整会话存储一个 JSON 文件，无云上传、无 localStorage 权威数据。
- 不自动截断历史；10 MiB 以上显示性能诊断提示，不自动拒绝结束当前会话。用基准测试决定迁移时间，不设“删旧记录保性能”的隐式策略。
- SQLite/分月存储是以后独立迁移，统计 API 不依赖当前文件组织。

### 8.2 完整 record 示意

以下是 schema 草案；时间均为 UTC epoch 毫秒，统计时区单独保存。duration 不以格式化分钟字符串保存。

```json
{
  "schema": 1,
  "version": 12,
  "settings": {
    "workSeconds": 1500,
    "shortBreakSeconds": 300,
    "notificationsEnabled": true,
    "soundEnabled": true,
    "showTrayTimer": true,
    "statisticsTimeZone": "Asia/Shanghai"
  },
  "current": {
    "id": "session-001",
    "phase": "work",
    "status": "running",
    "clockIssue": null,
    "timeQuality": "wall_clock",
    "taskId": "task-a",
    "taskTitleSnapshot": "修复登录问题",
    "projectIdSnapshot": "project-a",
    "projectNameSnapshot": "Daylight",
    "targetMs": 1500000,
    "startedAt": 1790000000000,
    "deadlineAt": 1790001500000,
    "remainingMs": null,
    "segments": [{"startAt": 1790000000000, "endAt": null}],
    "pauseCount": 0
  },
  "sessions": [],
  "lastOutcome": null,
  "receipts": []
}
```

历史 session = current 的归档快照，`status:ended`，补充 `endedAt / observedAt / endReason`，deadline/remaining/clockIssue 置 null，保留 timeQuality，所有 segments 闭合；归档后不可变。

- `endedAt`：计时逻辑结束点；到期为 deadline，而不是发现到期的时间。
- `observedAt`：服务真正处理并归档的时间；可用于显示“恢复后确认到期”。
- `endReason`：`completed / stopped / task_completed / task_deleted / recovery_task_invalid`。
- `timeQuality`：`wall_clock / clock_changed / recovery_uncertain`。提示计时可信边界，不改变 endReason 或创造额外累计数字；历史会话保留该标记。
- `clockIssue`：正常为 null；冻结时为 `{code:'CLOCK_CHANGED',detectedAt,frozenAt}`。仅冻结状态允许非 null；frozenAt 是最后可验证区间截点，详见第 8.4.2 节。
- `lastOutcome`：最近一次结果 ID、摘要、acknowledged 和 `notification:{requestId,state,attemptedAt?}`；state 为 `none / pending / attempted / scheduled / failed`。成功到期且提醒开启才生成 pending，其余为 none；不是第二份权威 session，不参与统计。attempted/scheduled 表示投递意图已消费/OS 已接受请求，不表示用户一定收到。
- 工作必须 taskId；短休息允许 null，快照可以保留上轮上下文但不计入工作统计。
- receipts 最后 100 项：requestId、原请求指纹、appliedVersion、actionResult；和 session 同一文件原子保存。
- 不保存 token、模型对话、任务备注、文件路径或通知权限作为长期业务统计。

### 8.3 纯状态机及转换

| 当前 | 动作/事件 | 结果 |
| --- | --- | --- |
| idle（current=null） | `focus.start` | running；新 UUID、任务/项目快照、第一段 open segment |
| running | `focus.pause` | 先统一核对终止；仍可运行时关闭本段、保存 remaining、置 paused/deadline=null |
| paused、无时钟冻结 | `focus.resume` | 验证任务和时间边界；新开 segment，deadline=now+remaining，running |
| running/paused | `focus.finish` | 先统一核对终止；否则归档 stopped；时钟冻结的结束走第 8.4.2 节合法截点 |
| running 且 now≥deadline | 到期候选 | 和任务终止一起裁决；确为最早结束点才归档 completed；不自动下一轮 |
| 当前存在且开始新轮 | `focus.start` | 409 `FOCUS_ALREADY_ACTIVE`，无隐式覆盖 |
| current 任意 | `focus.switch` | 明确给旧 sessionId，原子结束旧轮 + 开始新轮；一个 focus 文件事务 |
| 工作关联 task done/缺失 | reconcile | 提前结束并保留快照；不动任务状态 |
| running 或恢复时间早于已保存区间 | 时钟回拨 | 闭合可验证区间，保存 paused + clockIssue，不产生负区间 |
| paused + clockIssue | `focus.resume` | now 未达到 frozenAt 时 409 CLOCK_CHANGED；达到后允许显式继续，清冻结但保留 timeQuality |
| current=null | `focus.acknowledge` | 仅确认指定 lastOutcome，收起结果条，不删历史 |
| 任意 | `focus.settings` | 修改允许设置，不影响已启动轮次的 targetMs |

暂停、继续、结束、切换必须给 sessionId；不接受“对当前任意会话”模糊操作。重复请求用原 requestId 去重；同动作新 requestId 对已结束会话按状态返回 409，不伪造新记录。

开始/切换 durationSeconds 可省略用设置值；工作范围 60–10800，休息 60–3600，整数秒。前端只提供整分钟输入。客户端不能提供 startedAt、deadlineAt、endReason、elapsedMs、历史 segments 或统计数字。

### 8.4 时间计算与异常

- running 剩余 `max(0, deadlineAt - serverNow)`；paused 使用 stored remainingMs。
- 所有读取核对、动作、timer、任务联动和恢复使用同一终止裁决。任务仍有效且截止为最早终止点时，暂停/结束先归档 completed；不能在 00:00 继续暂停增加时间。
- 累计采用非重叠 running 区间；正常 completed 总计=targetMs；提前结束总计≤targetMs。
- Sleep/关闭窗口/退出 App 期间按墙上时间继续；重开后最多归档一个当前轮次。
- 服务用墙上时间和单调时间观察回拨：相对最后可信观察回拨超过 5 秒，或 now 早于已保存段的时间边界，执行第 8.4.2 节冻结。正向时间差不能可靠区别睡眠和改钟时仍按 D6 的墙上时间封顶；不能将正常睡眠误判成必须人工恢复的时钟故障。
- 进程关闭期间无法重建改钟过程；恢复时 now 早于 open segment.startAt 或最后闭合段 endAt，则按第 8.4.2 节冻结。其他恢复按统一终止裁决，报表不宣称真实工时。
- 要测试“暂停很久后继续”不会包含暂停时间。

#### 8.4.1 统一终止裁决

`resolveFocusTermination` 一次收集当前可验证的终止候选，选择最早时刻；调用者不能各自以“先检查到期”或“先检查任务”决定 endReason。

| 候选 | 合法截点及原因 |
| --- | --- |
| running 到期 | deadlineAt≤now，截点 deadlineAt，原因 completed |
| work 的任务 done | completedAt 可解析且≤now 时取该值，原因 task_completed；早于 startedAt 则截到 startedAt，计时为 0 并标注时间异常 |
| 正常任务删除，或完成时间非法/在未来 | 使用已捕获且合法的 taskCommittedAt，原因 task_deleted/task_completed；不能使用未来 completedAt 增加工时 |
| 恢复时任务缺失，或 done 没有可用的完成/提交时刻 | 仅保留已闭合段，截点为最后闭合段 endAt，无闭合段则为 startedAt；原因 recovery_task_invalid，timeQuality=recovery_uncertain，不推测 open 段贡献 |

- paused 没有到期候选。任务终止早于截止则计中断；任务完成/删除晚于截止则计 completed；同刻并列时 completed 优先，completed 不成立的任务并列以可验证任务原因优先于恢复不确定原因。
- 对选中截点裁剪**所有** current.segments，删除截点之后的段、闭合跨截点的段，保证非负、非重叠及实际计时≤targetMs。无候选时保持会话。人工 finish/switch 只在统一核对后仍有合法 current 时执行。
- 崩溃恢复不知道删除时刻是明确能力边界；不能因为恢复时已过 deadline 就把这种会话包装成完整轮。界面说明只保留可验证段。
- 时钟已冻结时，当次完成/删除使用 frozenAt 结束并保留已验证闭合段，原因仍为 task_completed/task_deleted；不能用回拨后的任务时间戳将已验证计时反向清零。回拨前已经捕获的可信任务终止事件仍按其原截点裁剪。
- 自动 reconcile 与用户请求分两步：先保存必要的系统转换，再按当前版本/会话校验请求。用户动作可能返回 409，但已经保存的合法归档不得因该错误被丢弃；原 requestId 命中回执仍先返回回执，不重执行动作。
- 契约例：10:00 启动，10:05 任务完成，focus 保存失败后进程退出，10:30 恢复；结果是 task_completed、5 分钟、0 完整轮。完成于 10:30、截止于 10:25 时结果是 completed、25 分钟、1 完整轮。两种情况 Node/Swift 相同。

#### 8.4.2 时钟冻结与退出

冻结沿用 paused 状态，不引入第三套计时状态；冻结转换、clockIssue 和区间闭合在同次 focus 保存中提交。

1. 正常运行中用最后可信服务时刻闭合 open 段，截点夹在段 startAt 与 deadlineAt 之间；重启时没有可信运行观察，open 段只闭合在自己的 startAt，新增计时为 0。既有闭合段保留。
2. frozenAt 取闭合后最后段 endAt，无段则取 startedAt；remainingMs=targetMs−已闭合区间总时长，deadlineAt=null，status=paused，clockIssue 保存检测时刻和 frozenAt，timeQuality=clock_changed。服务内存中的最后可信观察不是每秒落盘字段。
3. state GET 返回 200 及 clockIssue；页面停止 ticker 并显示“系统时间回拨，计时已冻结”。冻结写失败保持原权威 record，禁用继续操作，显示待保存，不先宣布已暂停。
4. `focus.finish` 始终可结束匹配的冻结会话：endedAt=frozenAt，observedAt=now，原因 stopped；不重新按 now 闭合区间。因回拨，observedAt 可以早于 endedAt，只有 clock_changed 记录允许此例外，统计使用合法 segments/endedAt。
5. `focus.resume` 在 now≥frozenAt 且 remainingMs>0、任务有效时才允许；清 clockIssue、保留 timeQuality，新段从 now 开始。剩余为 0 时只允许结束，不能继续造出新的时间。
6. finish 后若 now 仍早于最近已归档段的末端，start/switch 返回 409 CLOCK_CHANGED 并提供可恢复时间；调整系统时间后可重新开始，不能用新会话绕过非重叠约束。

冻结、冻结后结束、时间恢复后继续、冻结后重启、保存失败均有纯模型与两运行时测试。设置保存、读取历史和任务管理不因 clockIssue 被禁用。

### 8.5 原子保存与写失败

Node store 在内部 serial executor 中：校验 → 保存上一版 → 同目录临时文件写入（0600）→ 原子 rename → 更新内存 → 发布变更。首次创建使用独占创建策略，异常不覆盖已有文件。

Swift 用 `server.queue` 串行调用共享决策，原子写数据并设 0600。JSContext 不得跨线程；Focus 持有的回调仅在该队列访问 engine。

- 读写均保留文件损坏证据；不要 catch 后返回 initialState。
- 模型层先生成 next，不先修改内存中的权威 record。
- current→sessions、lastOutcome 和 receipt 在同次保存完成，防止重复记账。
- 每秒不写文件；只在用户动作、到期、任务联动和通知/结果确认状态变化时保存。
- 到期写失败：current 保留但派生剩余为 0，显示“到期结果待保存”；不发成功通知；服务重试有限退避并允许手动刷新恢复。
- 进程清理临时文件不删除权威/previous；恢复上一版必须显式操作，不自动偷偷回退数据。

### 8.6 与任务写入的联动及一致性

开始专注不修改 task.status 和 plans，避免 focus.start 的跨文件事务。

任务完成/删除仍只提交任务文件；成功后通知 focus service reconcile：

1. 按最新已提交任务 snapshot 核对 current.taskId。
2. done/deleted：调用第 8.4.1 节统一裁决，和 deadline 一起比较；不得只在“尚未到期”分支核对任务。异常时间与未知删除时刻沿用该节规则。
3. 任务提交事件携带已提交 snapshot/version/committedAt；正常运行中的 hook 不能等入队后只查一个已被后续修改覆盖的任务状态。reconcile 重试保留这次终止上下文，归档成功后才清除；它不是跨文件崩溃事务，进程崩溃后使用持久任务状态恢复。
4. focus 保存失败不把已成功任务写返回为“未保存”；任务响应可携带 `warnings:[{code:FOCUS_RECONCILE_PENDING}]`，GUI 显示任务已保存、计时状态待恢复。
5. 所有任务写入口（Web PUT/Web actions/Agent actions/undo）、启动恢复、focus 读取前核对覆盖同一规则。
6. Node 不能仅靠一个 fire-and-forget 事件声称强一致：focus 队列内执行 start/switch 前读取最新任务快照；任务提交持有 task 写锁期间 focus 写返回 409 `TASK_WRITE_IN_PROGRESS`，任务成功提交后再 reconcile。旧 Web PUT 也执行 hook。
7. 新 start 带 taskVersion，用于保护任务名称/归属快照；focus-only pause/resume 不要求 taskVersion。
8. Swift 使用已有同一串行队列完成任务提交与 focus 核对；仍是两个文件，不宣称跨文件崩溃原子。
9. undo 恢复任务不恢复已结束专注；task active 切换、移出日期、项目迁移不结束当前专注，历史归属不变。

## 9. 统计口径与查询

### 9.1 指标定义

| 指标 | 定义 |
| --- | --- |
| workElapsedMs | work 的 running segments 与查询时间窗口的交集之和；包含当前 running 到 serverNow（截止处封顶） |
| completedRounds | endReason=completed 的 work 会话数，按 endedAt 所属统计日计数 |
| stoppedSessions | endReason=stopped 的 work 会话数；按 endedAt 所属日计数 |
| interruptedSessions | task_completed/task_deleted/recovery_task_invalid；单独返回，不塞进用户提前结束次数 |
| breakElapsedMs | 休息计时，默认不展示为主指标，不计入 workElapsedMs |
| task cumulative | 当前 taskId 的所有历史 work 区间及当前会话；不按任务当前项目重分配 |

- 今日累计标签为“专注计时”，不是“有效工作时长”。
- 成功轮次不等于完成任务数；25 分钟和自定义 60 分钟均是一轮，时长可同时看。
- 统计量不永久累加进另一个 total 字段；全量原始记录可重算。
- 进行中会话只贡献时间，不贡献完整/提前结束次数。
- 休息段不产生工作轮数。
- 结束点正好午夜归入下一天的结束计数；前一天时间按半开区间计入前一天。
- 列表和指标不一定相同条数：某轮跨两天会在有计时交集的日期出现，但完整轮数仅出现在结束日。界面说明此规则。

### 9.2 日期/时区

- API `from/to` 为含首含尾的 YYYY-MM-DD；内部转换成 `[from 00:00, to+1 00:00)`。
- 使用 focus.settings.statisticsTimeZone，首次固定为服务操作系统可识别的 IANA 时区；无法确定时明确使用 UTC 并提示，不能把一个未知缩写当 IANA。
- 日历是当前运行环境本地的民用日期安排，不附带时区；统计时区可能与 today 系统日期不同，界面明确显示“统计今天：日期 · 时区”。
- Node time-zone adapter 和 Swift Calendar 生成每日日窗口；共享统计算法只处理毫秒区间和日窗口。
- 不假定一天固定 86400000 ms，DST 日可能 23/25 小时。不可存在的民用日期返回合法空日标记或拒绝并统一两运行时规则；第一版日窗口以能存在的日期为准，跳过不存在日并显示 0。
- JavaScriptCore 不强制依赖 Intl timezone；其测试输入为相同窗口，平台窗口另做对照。
- 上层传入 windows 不来自用户任意请求 body，防止伪造统计口径。

### 9.3 查询限制与性能

- calendar 范围最多 62 天；focus 报表最多 366 天；超出 400，不悄悄截断。
- task-summary 全历史累计使用单独 summary query，不让 366 天报表参数承载“全部累计”。
- sessions limit 1–100，默认 20；排序 startedAt DESC + id DESC。
- cursor 包含筛选摘要、offset/key 和查询时 focus version；历史改变则 409 `CURSOR_STALE`，前端回到第一页提示。当前 elapsed 数字随 now 变，不必每秒改变持久 version。
- 对正在计时的报告返回 asOf/serverNow，每 15 秒更新合计；结束、暂停、切换和恢复时立即刷新。
- controller 仅轮询小 state，不每 3 秒下载全部 history。
- 同一个报告响应同时生成汇总/日/项目，减少页面重复查询造成不同 asOf。
- 单次复杂度目标 O(session segments + 日期数 + 输出排序)，避免“每个日×所有记录”扫描。
- 10,000/50,000 条会话的真实 Node/headless Swift 基准是批次 C0 的退出门槛；通过后才能冻结单 JSON 和桥接实现并继续 C1/D–F。G 只回归这组门槛，不是第一次测量。

#### 9.3.1 C0 性能预算与证据

这些数值是实施验收预算，当前实测结果见第 17 节。每个运行时、两种规模都必须实测；若要调整预算，先修改本文及记录理由，不以“本地感觉流畅”代替。

- `scripts/benchmark-focus.mjs` 自动创建临时任务/focus 目录，启动真实 Node 服务和打包的 headless 原生二进制。记录 CPU、内存、OS、Node/Swift/JSCore 环境、提交、样本文件大小、会话/segment 数、冷启动和基线 RSS。
- 数据包含 50 个项目、1,000 个任务、10k/50k 条合法会话，至少 20% 会话有暂停段，覆盖多日期及删除对象快照；另有一个当前工作会话。不通过重叠或非法段缩小统计工作量。
- 预热 5 次，稳定查询和动作各采样至少 30 次；报告 p50/p95/max。动作覆盖 pause/resume、finish/start、settings 和通知意图消费；所有写入均实际落盘。区分服务处理时间、主线程/串行队列占用和客户端端到端时间。
- G 延长同条件报表查询，在计时样本后追加 10×30 次读取；记录初始/末端 RSS 中位数及自然回收。≤64MiB 初始增长、≤16MiB 末端增长仅为补充诊断阈值，原峰值预算保持不变；有持续增长迹象时继续长查询定位，不能仅凭 30 次样本宣称没有泄漏。

| 项目 | 两种规模均需达到的预算 |
| --- | --- |
| 小 state GET | 空闲时端到端 p95≤200 ms；响应≤32 KiB，不包含 history/receipts |
| 单次持久动作 | 端到端 p95≤1,500 ms；记录全文件编码、previous、原子替换分别耗时 |
| 366 天报表与全历史 task-summary | 端到端 p95≤2,000 ms；汇总/日/项目不重复扫描各自的全历史 |
| 并发一次大报表或持久动作时的任务 state GET | 端到端 p95≤500 ms，不能被专注统计长期饿死 |
| Node 主线程/Swift server.queue | 单次连续占用≤500 ms；deadline 到期处理在上述负载下延迟≤2 秒 |
| 进程峰值 RSS | 相对空服务基线增加≤768 MiB；30 轮查询后不得持续无界增长 |

- 小响应不等于小内部开销：Swift 将 focus record 在同一 server.queue 所属 JSContext 中加载一次，快照读取只序列化结果，不每 3 秒将全部历史转成字符串再传回 JS。不在 Swift 和 JS 各维护一份可独立变更的权威 record；保存成功才替换 JS 中的权威记录。
- 主线程菜单读取用异步快照回调，不能在 UI ticker 上 `queue.sync` 等待大报表；保持既定 JSContext 队列约束。Node 查询和写决策只对需要的结果编码，避免为小 state 深拷贝全历史。
- C0 可先完成足以测量的模型/存储/原生桥适配，不必实现全部 API。任一门槛失败则 C0 不通过：先定位及优化该层，若仍需改变单 JSON、存储格式或线程方案，则修订对应设计和测试后重测；不得进入 D–F，也不得自动裁剪历史或悄悄引入 SQLite。

### 9.4 示例口径

会话 A：23:50–00:00、00:05–00:20，暂停 5 分钟，正常结束。

- 前一天 workElapsed=10 分钟；后一天=15 分钟。
- completedRounds 归后一天 1；暂停不计时。
- 查询跨两天合计 25 分钟。
- 若 00:15 提前结束，合计 20 分钟，completedRounds=0，后一天 stoppedSessions=1。

会话 B：10:00 开始 25 分钟，电脑睡眠，14:00 恢复。

- 逻辑 endedAt=10:25，observedAt=14:00；最多统计 25 分钟。
- 标注恢复后确认到期，不声称 25 分钟均实际工作。
- 不自动记录额外休息和第二轮。

## 10. HTTP 接口与能力声明

### 10.1 鉴权、版本和错误通则

- Web：`X-Workbench-Token`；同源 Origin 检查沿用当前 web 规则；写入严格本机 Origin。
- Agent：`Authorization: Bearer <agent-token>`，只允许本机 Host；Origin 无/本机合法；未知 Agent 路径先鉴权。
- 不新增公开无鉴权的专注历史接口。
- 所有写入 requestId 8–100 个合法字符、expectedVersion 非负整数；focus 和 task 版本分开。
- 原请求指纹保留原 JSON 语义，不用重排字段/填默认值后计算；receipt replay 先于版本和草稿过期判断。
- 查询参数未知/重复参数拒绝；避免 Object.fromEntries 静默吞重复字段。
- 错误结构 `{error,code,version?,details?}`；400 非法输入、401/403 鉴权、404 目标/路由缺失、409 冲突、503 专注不可用。旧任务错误响应保持兼容，新 action 可增加 code。

### 10.2 日历与 Web 任务动作

| 方法与 Web 路径 | Agent 路径 | 用途 |
| --- | --- | --- |
| `GET /api/calendar` | `GET /api/v1/calendar` | 范围安排与计数 |
| `POST /api/task-actions` | 现有 `POST /api/v1/actions` | 日历 action，复用 prepareTaskWrite/undo/receipt |

calendar 参数：`from,to,status=all|open|done,projectId?,unassigned=1?,query?,previewLimit=0..5`；默认 status=all，previewLimit=3。projectId 与 unassigned 互斥。query ≤300 字符。

响应示意：

```json
{
  "version": 17,
  "localDate": "2026-10-04",
  "selection": {"from": "2026-09-28", "to": "2026-11-08", "status": "all"},
  "days": [
    {
      "day": "2026-10-04",
      "counts": {"open": 2, "done": 1, "total": 3},
      "matchedCount": 3,
      "preview": [{"id": "task-a", "title": "修复登录问题", "status": "todo", "projectId": "project-a", "projectName": "Daylight", "projectColor": "green"}],
      "hasMore": true
    }
  ]
}
```

日期详情在网页直接对已加载任务 snapshot 调用 selectTasks(scope=today,day=selectedDay)，API 用于 AI/Skill/契约；前端月格调用同一 calendarQuery，可避免首次加载双请求。前端与服务版本一致，不混用旧详情和新月格。

### 10.3 专注接口清单

| Web | Agent | 方法 | 作用 |
| --- | --- | --- | --- |
| `/api/focus/state` | `/api/v1/focus/state` | GET | 小型状态、设置、lastOutcome、运行时能力、serverNow |
| `/api/focus/prepare` | `/api/v1/focus/prepare` | POST | 校验和预览 action，不产生计时或文件写入 |
| `/api/focus/actions` | `/api/v1/focus/actions` | POST | 执行独立版本保护的动作 |
| `/api/focus/statistics` | `/api/v1/focus/statistics` | GET | 范围汇总、每日和项目统计 |
| `/api/focus/task-summary` | `/api/v1/focus/task-summary` | GET | 指定 taskId 全历史合计 + recentLimit 0–10 |
| `/api/focus/sessions` | `/api/v1/focus/sessions` | GET | 分页记录、phase/filter/cursor |
| `/api/focus/export` | `/api/v1/focus/export` | GET | 专注独立 JSON 导出，排除 receipts/token |

运行时 state 响应不能返回整个 sessions/receipts：

```json
{
  "version": 12,
  "taskVersion": 17,
  "serverNow": 1790000300000,
  "settings": {"workSeconds": 1500, "shortBreakSeconds": 300, "statisticsTimeZone": "Asia/Shanghai"},
  "current": {"id": "session-001", "phase": "work", "status": "running", "taskId": "task-a", "remainingMs": 1200000, "deadlineAt": 1790001500000, "targetMs": 1500000},
  "lastOutcome": null,
  "runtime": {"mode": "node", "notifications": "page-only", "notificationPermission": "unknown"}
}
```

响应 current 还有标题/项目快照、clockIssue/timeQuality，示意中省略；不向前端发送所有历史 segments。clockIssue 作为可恢复业务状态返回，不将它误报成整个专注存储不可用。

### 10.4 专注 action schema

| type | 字段 | 约束 |
| --- | --- | --- |
| `focus.start` | `phase,taskId?,durationSeconds?` | work 必须 taskId，shortBreak 可 null；current 必须 null |
| `focus.pause` | `sessionId` | 当前 running 且 ID 匹配 |
| `focus.resume` | `sessionId` | 当前 paused、关联任务有效 |
| `focus.finish` | `sessionId` | 结束计时，保留历史，不完成任务 |
| `focus.switch` | `sessionId,phase,taskId?,durationSeconds?` | 结束旧并启动新；必须审阅影响 |
| `focus.settings` | `settings` | 允许字段完整值或严格 patch，本文推荐 patch；禁止 statisticsTimeZone，未知字段拒绝 |
| `focus.acknowledge` | `outcomeId` | 对目标结果确认；不影响历史指标 |

POST 例子：

```json
{
  "requestId": "focus-start-001",
  "expectedVersion": 12,
  "expectedTaskVersion": 17,
  "action": {"type": "focus.start", "phase": "work", "taskId": "task-a", "durationSeconds": 1500}
}
```

- start/switch 必须 expectedTaskVersion；pause/resume/finish 不要求该字段，但 resume 仍检查最新任务是否可用。
- API 支持 `expiresAt` 顶层字段，用于经过 AI prepare 的时效性动作；prepare 生成最多 10 分钟有效期，服务检查其与服务时间的关系，不接受无限未来值；直接 GUI/Skill 点击不必传。这不是签名授权令牌，不替代 token、版本和用户确认。
- focus不接受 batch/undo。历史不可通过任务 undo 恢复。
- 成功返回 `{ok:true,version,appliedVersion,replayed,serverNow,current,lastOutcome,actionResult}`。
- CLOCK_CHANGED 返回 409、当前 version 和可恢复时间；冻结 state 可正常读取。receipt replay 先于该检查，已经成功的原请求不能因后来改钟被否认。
- receipt replay 回执结果和当前 state 明确分开；不能把过去开始成功的 current 快照当目前仍在运行。
- prepare 返回 `{focusVersion,taskVersion,normalizedAction,impact,preparedAt,expiresAt?}`；预览的真实时长受准备时状态决定，不产生 pause/finish。
- 同一请求 ID 换动作/版本/taskVersion/expiry 返回 409；收到未知结果只重试原请求。
- 异常到期可能在 prepare 前被 runtime 调度归档；prepare 自身为只读，不为了通过版本检查篡改会话。

### 10.5 报表响应

参数：`from,to,projectId?,unassigned=1?,taskId?`。projectId 是会话快照归属；taskId 可指向已删除任务的历史，不要求任务现在存在。

```json
{
  "version": 15,
  "asOf": 1790000300000,
  "timeZone": "Asia/Shanghai",
  "selection": {"from": "2026-10-01", "to": "2026-10-07"},
  "summary": {"workElapsedMs": 30900000, "completedRounds": 18, "stoppedSessions": 5, "interruptedSessions": 1, "includesCurrent": true},
  "daily": [{"day": "2026-10-01", "workElapsedMs": 3600000, "completedRounds": 2, "stoppedSessions": 0}],
  "projects": [{"projectId": "project-a", "name": "Daylight", "workElapsedMs": 15000000}]
}
```

列表与统计请求使用相同筛选；sessions 的区间选择是“有 work 区间交集或结束点落入范围”，响应说明 selectionRule，不把只有结束计数的会话藏掉。

### 10.6 capabilities

`GET /api/v1/capabilities` 在既有字段外追加：

```json
{
  "calendarQuery": {"path": "/api/v1/calendar", "maxDays": 62, "weekStartsOn": 1},
  "taskPlanning": {"reschedule": true, "perActionDay": true, "preserveExecution": true, "createPlanDay": true},
  "focus": {
    "apiVersion": 1,
    "state": "/api/v1/focus/state",
    "prepare": "/api/v1/focus/prepare",
    "writes": "/api/v1/focus/actions",
    "statistics": "/api/v1/focus/statistics",
    "sessions": "/api/v1/focus/sessions",
    "taskSummary": "/api/v1/focus/task-summary",
    "export": "/api/v1/focus/export",
    "operations": ["focus.start", "focus.pause", "focus.resume", "focus.finish", "focus.switch", "focus.settings", "focus.acknowledge"],
    "retention": "all sessions; last 100 successful request IDs",
    "maxReportDays": 366,
    "taskStateMutation": false
  }
}
```

notificationPermission 等动态平台信息放 state.runtime，不把它永久写入 capabilities 静态契约。能力声明是支持接口，不是已验证真实通知成功的证据。

## 11. 内置 AI 和外部 Skill

### 11.1 内置 AI 只读工具

| 工具名 | 参数 | 返回与限制 |
| --- | --- | --- |
| `daylight_get_calendar` | `from,to,projectId?,unassigned?,status?,query?` | calendar API；preview 限制 3；不读取所有任务备注 |
| `daylight_get_focus` | 无 | 小型 state，真实 sessionId、两个版本、serverNow |
| `daylight_get_focus_statistics` | `from,to,projectId?,unassigned?,taskId?` | 明确统计时区和是否含当前计时；不返回未经请求的全部历史 |
| `daylight_get_focus_sessions` | `from?,to?,taskId?,projectId?,phase?,limit?,cursor?` | 默认 20，最多 100，删除对象仍以快照表示 |
| `daylight_get_task_focus_summary` | `taskId,recentLimit?` | 全历史任务累计，最多 10 条最近记录 |

AI 可以解释统计，但必须说是计时记录，不能自行宣布效率提升、实际工时或任务完成率。

### 11.2 内置 AI 写入

- 日历写入复用 `daylight_propose_changes`：task.create.planDay、plan.add/remove、reschedule、batch 子 day；**不新增重复的日历写工具**。
- 新增 `daylight_propose_focus_changes({summary,action})`：先读取 state → prepare → pending `focusChanges` → 用户审阅 → POST focus/actions。
- 模型只能提交 action/summary，requestId/version/taskVersion/expiry 由可信工具分发生成，不接受模型覆盖。
- start/switch/pause/resume/finish 的草稿有 10 分钟有效期；settings/acknowledge 不设置时间过期但仍版本保护。
- 审阅卡展示：对象真实标题、阶段、时长、旧会话将提前结束的影响、不会自动标记任务完成、独立专注统计不可用任务 undo 撤销。
- 用户编辑草稿后必须重新 prepare、生成新 requestId/版本/expiry；首版 focus 草稿只读详情，取消后重新生成，不开放随意 JSON 编辑。
- 未提交草稿取消没有副作用；已经提交的未知请求保留恢复记录，不能宣称取消使其未执行。停止 AI 生成不能结束实际计时。
- applying 时停止 AI 请求被拒绝，沿用现有生命周期限制。
- 在第一次 HTTP 提交前将原 payload 和用户批准记录保存到 `conversation.focusSubmission`，p.submitted 只作当前 pending 的兼容标记；恢复规则见第 11.2.1 节。未知结果只重试原 requestId/expectedVersion/action/expiry，即使过期也先检查 receipt，不生成新请求重复 start。
- focusChanges 必须在 ai/drafts 的独立分支，不落入普通任务动作 fallback。
- 应用成功消息可返回 current/sessionId 和 actionResult，不返回全部历史或凭证。
- 草稿审阅期间任务被删除或完成、focus 被另一个窗口操作或自动到期，返回 409，用户读取后重新决定，不自动重基准执行。

#### 11.2.1 已提交请求的持久恢复

当前 `AIStore` 重启会把 waiting/running 变成 interrupted 并清 pending；run 的 finally/cancel 也清 pending，answer 则要求活跃 waiter。因此仅持久化 p.submitted 不能提供跨重启核对入口。

复用现有 conversation 原子文件，增加独立字段，不新增第二套 AI 操作数据库：

```json
{
  "focusSubmission": {
    "id": "original-draft-id",
    "status": "unknown",
    "approvedAt": "2026-10-05T02:00:00.000Z",
    "summary": "开始专注",
    "request": {
      "requestId": "original-focus-request",
      "expectedVersion": 12,
      "expectedTaskVersion": 17,
      "expiresAt": 1791166200000,
      "action": {"type": "focus.start", "phase": "work", "taskId": "task-a"}
    },
    "result": null
  }
}
```

1. 未批准草稿仍只在 pending；用户应用后，`ai/focus-submissions.mjs` 冻结由可信分发层生成的完整 request，status=submitted，并与批准记录同次 save。保存失败则不发 HTTP；模型不得创建或修改该字段。
2. HTTP 成功后保存 status=applied、回执和操作消息，再清 pending。操作消息用 requestId 去重。网络/超时/无法解析响应/5xx 保存 unknown；保存 AI 结果失败也保留原 request，不把后台已提交动作当作未执行。
3. store 重载时保留 focusSubmission，把遗留 submitted 视为 unknown，清理运行中临时锁；finally/cancel/close 可以清 run 和临时 pending，但始终保留独立 focusSubmission。重启不自动发请求、恢复 CLI 或生成新草稿。
4. 已批准请求通过专用 `POST /api/ai/conversations/:id/focus-submission` 核对，body 为 `{id,action:'retry'|'acknowledge'}`，不接受 action/request/version 覆盖。core/contracts 为此 POST 声明 Web token + 严格本机 Origin；原生转发也遵守该规则，不开放 Agent 授权或原生权限确认的旁路。
5. retry 无需活跃 run/waiter，只向 focus/actions 发送持久原 body。服务按 receipt→版本/expiry 顺序处理；成功则记录 applied。确定的 4xx 进入 needs_review，展示最新 state 与拒绝原因，不自动换 ID；超过回执保留窗口时不得声称旧请求一定未执行。
6. 如原 run 仍存在且 pending ID 匹配，run-manager 在持久结果保存后只结算该 waiter 一次；若无 run，只保存核对结果和消息，不启动模型。重复点击/重试共用 submission 应用锁；应用中停止、删除会话或再次重试返回 409。
7. unknown/submitted 阻止该会话生成新的专注写草稿或删除会话，允许只读讨论。acknowledge 仅对已 applied 或已由用户核对的 needs_review 解除恢复卡；不能用“取消草稿”声称已批准的未知请求没有副作用。终结结果仍保留在操作消息中。

GET conversation detail 返回上述恢复状态；未批准 pending 继续沿用原有中断清理。保存、重载、HTTP 应用分别仍由 store、submissions、drafts/run-manager 负责，service 只组装和分发。

### 11.3 AI 页面前端

新增 `public/focus/draft-card.js`：渲染 focus 草稿及独立 focusSubmission 恢复卡，复用 button/section/date 等组件；样式使用现有 ai-card 框架和少量 focus 组合样式。`public/ai.js` 在无 pending、无活跃 run 时仍展示“上次提交待核对”，提供原请求重试和确定结果确认。卡片不能编辑原 payload，不能把未知提交渲染成新的“应用”草稿。

同一提交有 pending 和 focusSubmission 时只显示提交恢复卡，避免重复应用按钮；与旧权限/question 卡片的处理分支分开。

普通 task 草稿：显示每个计划 action 的有效日期；reschedule 显示 from→to；task.create.planDay 显示具体日，不一律展示 p.day。actionLinks 加入日历定位和专注统计定位。

应用 focus 后，onChanged 回调提供 `{kind:'focus'}`，只刷新 focus controller/统计；task 操作仍刷新任务。旧无参数 onChanged 调用保留兼容。

### 11.4 外部 Skill/CLI

拟议命令：

```sh
python3 skills/daylight-workbench/scripts/workbench.py calendar --from 2026-10-01 --to 2026-10-31
python3 skills/daylight-workbench/scripts/workbench.py focus-state
python3 skills/daylight-workbench/scripts/workbench.py focus-stats --from 2026-10-01 --to 2026-10-07
python3 skills/daylight-workbench/scripts/workbench.py focus-sessions --limit 20
python3 skills/daylight-workbench/scripts/workbench.py task-focus --id TASK_ID
python3 skills/daylight-workbench/scripts/workbench.py focus-prepare --file action.json
python3 skills/daylight-workbench/scripts/workbench.py focus-apply --expected-version 12 --expected-task-version 17 --request-id UUID --file action.json
python3 skills/daylight-workbench/scripts/workbench.py focus-export --out /tmp/daylight-focus-export.json
```

- 写接口凭证仍读 data-dir/agent-token，不进入 stdout、参数或文档。
- 外部 Agent 与内置 AI 授权模型不同：明确用户授权后可以直接执行 focus-apply；不是强行要求外部请求都经过内置对话确认。
- Skill 指令要求先 capabilities、再 state/prepare；模糊“专注一下”先核对任务，多同名不按标题猜 ID。
- 没有当前能力时提示服务需升级，不使用 localStorage、自行写 focus.json 或调用系统脚本绕过 API。
- switch/finish 有明确副作用，用户只问建议时不执行。
- --file - 支持标准输入；时间范围/版本校验在服务端仍执行，不相信客户端。
- 导出独占创建文件，不覆盖已有输出；任务 export 不变。
- 本次只修改仓库 Skill；独立安装路径的同步单独授权。

## 12. 运行时、原生通知及同步

### 12.1 调度和恢复

Node：focus service 在主进程，单个 deadline timer + 启动/每次动作/读取状态前的核对。timer 只是触发器，共享状态机以服务 now 判定。server close/SIGTERM 清理调度，不自动写 stopped。

Swift：Focus 在已有串行队列上调度，到期进入共享决策；GUI 与 headless 都支持。App 主窗口关闭不影响，完全退出只停止调度，当前记录保留。

启动恢复必须先读 task record，再读 focus record，核对时钟后调用统一终止裁决；不能先归档到期再检查任务。仍合法运行则恢复调度，paused/时钟冻结则保持暂停，任务无效按可验证终止时刻归档。计时恢复与 AI focusSubmission 核对相互独立。

### 12.2 前端同步

- 全局 controller 可见时每 3 秒小 state GET；隐藏时停止浏览器轮询，focus/visibilitychange 立即刷新。服务调度独立运行。
- 页面 ticker 1 秒，基于 response.serverNow 加 `performance.now()` 差值计算本地显示，不直接依赖客户端时钟与服务完全一致。
- 服务新快照校正显示；ticker 到 0 触发一次 refresh，不调用 finish 代替服务自动归档。
- current 已结束/发生切换时，发布订阅事件；统计页立即刷新，非可见页下次显示再加载。
- 统计页 15 秒 refresh 只在可见且存在当前 work 时启用；task summary 查询不频繁全量更新。
- 3 秒以上暂时失联不清空 current；连续失败明确 degraded，动作禁用；恢复重新读取 token/state，禁止重放未知新动作。
- 不引入 SSE：现有 Node/Swift HTTP 不必为两功能扩建流式协议。

### 12.3 通知能力和现实边界

| 环境 | 承诺 |
| --- | --- |
| 网页当前打开 | 页内到期结果；Notification API 支持且用户允许时可提供浏览器通知 |
| 普通网页完全关闭 | Node 可归档，但第一版不保证弹系统通知 |
| App 驻留、主窗口关闭 | 原生系统通知，须权限允许；不靠 WKWebView |
| App 完全退出/系统睡眠 | 不保证准时响铃；重开/唤醒核对到期，显示恢复结果 |
| headless 原生测试 | 不请求系统通知权限、不打开用户窗口；逻辑调度仍有效 |

- 首版不在 start/resume 时向 OS 预排未来 deadline 通知。到期归档和 lastOutcome.notification=pending 保存成功后，GUI 订阅者才可消费投递意图，向 OS 提交非重复、立即投递的通知；通知文案对应已经保存的工作/休息结果。
- `consumeNotification(outcomeId)` 在 focus 串行队列核对目标与 pending 状态，生成并保存 attempted 后才交给 UserNotifications；该内部入口不属于 Web/Agent actions。保存意图失败不发通知，重试仍消费相同 outcomeId，不重新归档 session。
- 暂停/提前结束/切换不产生新的成功到期提醒；设置关闭提醒后，未消费 pending 置 none。恢复时也不对 attempted/scheduled 再投递。headless 不初始化 GUI 通知消费者，Node 不冒充原生投递者。
- OS 接受请求后可记录 scheduled；拒绝则 failed 并反馈平台错误。scheduled 不是用户收到通知的证据，设置页授权另按第 12.4 节处理。
- 通知点击定位 `#focus` 或关联任务，不能执行完成任务等写操作。
- 不能保证“持久文件 + OS 通知”跨系统事务 exactly-once：requestId 取 sessionId，先持久消费意图再投递。消费成功后、OS 提交前崩溃可能漏提示；首版不自动重发以降低重复提醒。lastOutcome 页内结果仍可恢复，文档不承诺绝对不漏且不重。
- 浏览器多窗口通知第一版只提供页内提示，系统提醒默认由原生负责；如支持浏览器通知，只让当前有焦点页面投递并标注 best-effort，避免引入跨窗口通知权威协调。
- 休眠/唤醒通过 NSWorkspace 通知核对；不能通过 Timer 继续逐秒运行来声称覆盖休眠。
- App 签名/权限实际行为要在打包产物手工验证；编译通过不等于系统通知已投递。

### 12.4 设置页到原生的通知消息桥

授权采用主窗口专用 `WKScriptMessageHandler`，不新增可由 Agent 调用的授权 action 或 HTTP 授权接口。`FocusNotifications` 不因观察到 notificationsEnabled=true 自动请求权限。

| 消息 op | 用户入口与结果 |
| --- | --- |
| `getStatus` | 设置页打开/恢复可见时读取实时授权、alert/sound 能力；不弹框 |
| `authorize` | 设置页真实点击“开启系统提醒”调用 requestAuthorization；返回最新权限，拒绝仍可继续计时 |
| `openSettings` | 用户点击系统设置入口；由 GUI adapter 打开通知设置，失败给出手工定位说明 |

- `native/main.swift` 为主 WKWebView 注册名为 `focusNotifications` 的处理器，退出/销毁时移除并取消待回复；只有 GUI 初始化它。主框架及 securityOrigin 必须是当前 `http://127.0.0.1:PORT`，拒绝子框架、未知 op、未知字段和不合法 requestId；不是通用系统命令桥。
- `public/focus/platform.js` 检测 `window.webkit.messageHandlers.focusNotifications`，使用 `{requestId,op}` 发送。原生通过固定事件 `daylight-focus-notification-reply` 传回转义后的 JSON 数据 `{requestId,ok,permission,alertEnabled,soundEnabled,error?}`。permission 统一为 default/granted/denied/unavailable，无法判断的 alert/sound 字段为 null；客户端只结算对应未完成请求，不接收可执行脚本或任意回调名。
- getStatus/openSettings 超时 5 秒，authorize 超时 120 秒；超时/dispose 解除该请求和监听。授权超时表示“结果待核对”，下次只读 getStatus，不自动重复弹框。
- authorize/openSettings 只绑定受信任的用户点击，getStatus 可只读调用；AI 修改 settings 不经过消息桥。headless 报 runtime.notifications=unavailable，普通浏览器显示页内/best-effort 能力，不等待不存在的 native 回复。
- UserNotifications 回调在 GUI 层处理；能力快照通过 server.queue 更新 state.runtime。JSContext 仍只在该队列访问，权限不是 focus.json 的持久业务字段。页面恢复可见时重新读权限，因为用户可以在系统设置中改变授权。
- 测试同时覆盖：真实点击允许/拒绝、AI settings 不弹框、headless 无授权、非本机/子框架拒绝、超时和卸载清理；GUI 授权与系统投递分别留证。

## 13. 对现有架构的影响和兼容性

### 13.1 责任划分

- `core`：共享规则、写决策和统计；无 IO、平台通知、DOM。
- `focus` Node：存储与调度；不是 proxy 子模块，不调用模型。
- `native`：同规则的 Swift IO、统计时区日窗口和通知，不另写一套状态机。
- `public/components`：可复用表现；`public/calendar`/`public/focus`：业务组合。
- `app.js`：导航与挂载；AI：通过 HTTP 工具访问，不读 focus 文件。

### 13.2 浏览器共享核心资源

当前 Node 和 Swift 静态读取都将白名单 file 相对 `public/` 解析。新增浏览器共享模块需要明确设计：

- `core/web-assets.json` 为 `/core/date.js` 映射 `../core/date.js` 等**固定受审核条目**，前端相对 import 路径指向 `/core/...`。
- 请求 pathname 必须精确命中 allowlist，不能用用户路径拼接任意 `../`；现有 traversal/prototype 测试保留。
- calendar page 直接 import core/calendar-query，其传递依赖只使用 core/date 和 core/task-selection；public/task-view 依赖 core/task-selection 作兼容包装。不得为新增核心反向 import public 再增加 `/public/task-view.js`、`/public/model.js` URL 别名。
- 静态读取路径固定白名单，不表示允许用户查询任意 core/source 文件。
- 如果不愿白名单值使用 `../`，替代方案是新增显式 resourceRoot 字段；**推荐沿用固定映射的小改**，不在本次顺便重构所有静态服务。
- build-native 已复制 core，trim 需要保留浏览器依赖图的 core 文件；共享 native-core 编译并不自动保证裸浏览器模块存在。

### 13.3 数据与接口兼容

- 任务 schema 1、projects/tasks/plans、已安装 Skill 的旧 action 和 response 保留。
- 任务 export 仍仅业务 state；新增 focus export 独立。
- 任务 undo 不被专注写入覆盖；focus 不支持任务 undo。
- 不默认扫描项目目录、不上传用户计时、不把任务路径当权限。
- `plan.remove` 旧默认仍可能暂停 active；新日历显式 preserveExecution，文档描述两种行为。
- 单 active 与单 current 是两个约束，当前任务与专注任务可以不一致，这是 D3 的显式产品决策。
- focus API 的 runtimeError 不导致主工作台无法启动；损坏数据只读提示，不假装 0 统计。
- 跨进程并发：沿用同目录只启动一个工作台实例的使用约束；端口相同提供常规冲突保护，但改端口同目录没有文件锁保障，明确禁止且不宣称支持。若审核要求支持，应另增加跨 Node/Swift 的目录锁协议和测试，本次不隐式扩展。

### 13.4 旧版本回退

- 旧 App 忽略独立 focus.json，但不能再操作新 focus actions。
- 旧任务 schema 可读取本次任务数据；新 action 不写不可读字段。
- 回退期间的任务完成/删除不会调用新 focus hook；升级回来必须 reconcile，不能把旧 current 当作仍然准确运行。
- 不自动恢复旧 focus 文件覆盖新数据。人工恢复 previous 需停止服务并明确接受损失范围。

## 14. 分批实施与提交

每批包含实现、必要测试和该批范围说明。依赖为 A→B→C0→C1→D→E→F→G，先本地验证，不默认每批立即 push；实施授权不等同发布/替换授权。各批次实现与验收状态见第 17 节，建议提交信息保留作审阅拆分参考，本次没有创建提交。

新增浏览器资源、共享原生导出和打包依赖在使用它的同一批次登记 contracts/assets/native entry/trim 并检查，不延后到总验收。C0 是存储和桥接方案的实测门槛，未通过不得启动 D–F。

### 批次 A：日期契约和公共组件基础

- Scope：core/date/task-selection、public/task-view 包装、model/agent-api/task-write 新动作、task-client、app 旧保存/撤销接入、公共 segmented/date/dialog/task-row/task-picker、对应资源登记。
- 交付：严格日期、原子 reschedule、batch per-day、创建 planDay、preserveExecution；唯一 taskUndo 与统一提交回调；公共组件可独立挂载。
- 旧任务行和选择器提取时行为不变，不提前重写整个任务页。
- 验证：model/Agent/undo/receipt、混合 PUT/action 撤销与外部版本失效、旧响应兼容、日期边界、无新增 core→public 反向依赖、组件键盘与焦点、npm check/test。
- 建议提交：`Add date planning contracts and reusable task controls`。

### 批次 B：日历页面与双运行时查询

- Scope：calendar-query/page/CSS、routes/sidebar/app、contracts/assets/native entry、server/Swift calendar 查询和 Web task-actions/undo。
- 交付：42 格月历、日期详情、筛选、选择/新建/移出/改期、URL 返回、窄屏。
- 验证：范围 API、Web/Agent auth、Node/Swift 一致、旧 Hash、真实界面流程。
- 建议提交：`Add calendar planning view and shared range query`。

### 批次 C0：专注存储与桥接性能门槛

- Scope：用于实测的 focus-model/write/statistics、Node store/service、native Focus/JS 桥、小 state 和必要查询/动作、benchmark 脚本；全部使用隔离数据。
- 交付：10k/50k 的真实 Node/原生报告，包含第 9.3.1 节所有预算及 PASS/FAIL。未完成的 API 不出现在正式 capabilities，不因基准可运行宣称专注已交付。
- 顺序：实现最小可测数据路径 → 两运行时测编码/落盘/桥接/查询/负载 → 优化并重测 → 通过后冻结当前存储适配。失败时先修订影响范围，不并行推进依赖它的前端、原生提醒或 AI。
- 建议提交：`Establish focus storage and native bridge performance budgets`。

### 批次 C1：专注核心、存储、接口和统计闭环

- Scope：focus-model/write/contracts/statistics、focus Node store/service/time-zone、native Focus/FocusTimeZone、contracts/server/build。
- 交付：统一终止裁决和时钟冻结/退出、独立原子文件、恢复、task reconcile、版本/receipt、报表/summary/list/export；接口齐备后才声明完整 focus capability。
- 首先支持 headless API，不依赖 UI 通知。
- 验证：C0 预算仍通过、纯核心假时钟、早完成/晚完成/同刻裁决、未知删除恢复、持久化故障、多请求/到期竞争、冻结结束/继续/重启、双运行时 focus 契约、DST windows。
- 建议提交：`Add durable focus sessions and shared statistics APIs`。

### 批次 D：番茄钟与统计前端

- Scope：metric/progress/bar/pagination/date-range 组件、focus 前端模块、app/settings/sidebar/task dialog/style/index/assets。
- 交付：今日卡、全局条、统计页、任务合计、设置和独立导出。
- 验证：只有一个全局 ticker/poller、页面切换/弹窗/刷新/断连、图表键盘及 mobile、表单输入保留。
- 建议提交：`Add focus controls and reusable statistics UI`。

### 批次 E：原生菜单栏和提醒

- Scope：FocusTray/FocusNotifications/main/build、public/focus/platform/settings、通知意图内部消费入口和 runtime 测试。
- 交付：主窗口受限授权桥、关闭主窗口仍计时、菜单开着不重建、成功归档后的提醒、权限状态与系统设置入口、唤醒恢复。
- 验证：打包产物、GUI 授权允许/拒绝、AI settings 不弹框、headless 无授权、主框架/Origin 约束；到期保存失败不投递、意图消费崩溃窗口、暂停/提前结束/切换无未来提醒、休眠/完全退出恢复。
- 建议提交：`Integrate native focus tray controls and notifications`。

### 批次 F：内置 AI、外部 Skill 和文档

- Scope：definitions/dispatch/drafts/focus-submissions/store/run-manager/conversations/service/http、恢复 POST 的 contracts 鉴权、ai.js/action-links/context、focus draft/recovery card、Skill CLI/docs、测试。
- 交付：AI 只读能力、日历多日期草稿、focusChanges 审核、独立持久提交记录、无活跃 run 的原请求核对、外部能力发现。
- 验证：模拟两个 AI 后端，拒绝/过期/409/未知结果；提交前保存失败、提交后丢响应并重启、run 终结/停止/删除约束、操作消息去重、恢复路由不依赖 waiter 且不能修改 payload、CLI 与鉴权。
- 建议提交：`Expose calendar and focus tools through reviewed AI actions`。

### 批次 G：总验收与现行说明

- 全量 check/test/native/contracts；计时/时区/资源契约、新旧导航和 task schema 回归。
- 回归 C0 已建立的性能门槛，补真实 GUI 和原生通知证据；只在临时目录中测试。不得在此才首次检查存储可行性。
- 补 README/docs/focus 等现行说明、明确已验证与未验证能力。
- 本文审核项逐项对照，未完成项不能标为已交付。

## 15. 测试和验收

### 15.1 新增测试文件

| 文件 | 覆盖 |
| --- | --- |
| `test/date.test.mjs` | 闰年、无效日期、年/月切换、42 格、日期算术 |
| `test/calendar.test.mjs` | 筛选、counts before status、preview、日范围与空日 |
| `test/calendar-api.test.mjs` | Web/Agent auth、range 限制、计划动作、版本、重试、原子改期 |
| `test/task-client.test.mjs` | 旧 PUT/新 action 接入、唯一 taskUndo、版本失效、receipt replay 与未知结果 |
| `test/focus-model.test.mjs` | 注入 now/UUID 的纯状态机、最早终止裁决、冻结区间、异常退出和恢复 |
| `test/focus-store.test.mjs` | 初始化、坏 schema、原子失败、previous、0600、重启 |
| `test/focus-api.test.mjs` | actions/prepare/报告/列表/export、版本去重、taskVersion、故障隔离 |
| `test/focus-statistics.test.mjs` | segments、跨日、task/project snapshots、结束计数、current、过滤 |
| `test/focus-time-zone.test.mjs` | Node windows、DST/UTC/跨年/非整点 offset |
| `test/focus-ai.test.mjs` | query/propose、拒绝、超时、版本冲突、提交记录重载、无 run 原请求重试、4xx/5xx 区别及消息去重 |
| `test/focus-platform.test.mjs` | 前端桥能力检测、回复关联、超时/dispose；不把模拟回复称作真实授权通过 |
| `test/focus-skill.test.mjs` | CLI capabilities/focus/calendar/导出，不泄露 token |
| `test/focus-contract-test.py` + `test/focus-contract.json` | 同场景 Node/原生 start/pause/resume/finish/restart/reconcile/失败/统计一致 |
| `test/calendar-focus-ui.md` | 可执行手工/浏览器验收清单和截图证据位置，不假称单元测试覆盖布局 |

`scripts/benchmark-focus.mjs` 为独立基准入口，不加入每次 npm test 的计时断言；C0 和 G 显式执行。原生消息桥和通知意图模型加入两运行时/隔离 GUI 验收，真正弹框和投递仍需手工证据。

现有 `test/{agent-api,core,runtime-trim,sidebar,task-view,ai,ai-lifecycle}.test.mjs` 与原生测试新增回归断言，不删除旧用例。

### 15.2 日历验收场景

1. 2 月闰年/平年、12 月到 1 月、周一/周日首日均 42 格正确。
2. 选中未来日期创建任务，只进入该日期，不被“今天”覆盖。
3. 同一任务在 A、B、C；A 改到 B 后 B 不重复，C 保留，undo 一次完整恢复。
4. fromDay 已被外部删除，409 后不创建新安排。
5. done 历史任务可移出/改期既有引用，新添加 done 日期拒绝。
6. 项目/搜索/status counts 与日期详情一致；过滤顺序操作不丢隐藏任务。
7. 切 AI 再返回/刷新/前进后退/月末夹紧，视图和日期正确。
8. 午夜 today 更新，选中历史日期不跳；多窗口编辑保护不变。
9. 日历 preserveExecution 不暂停 active，不结束专注；旧 Skill plan.remove 默认行为保留。
10. 旧 PUT 改标题→改期→撤销只恢复日期；改期→旧 PUT→撤销只恢复最后一次修改；外部写入后旧撤销失效；专注写入保留任务撤销。

### 15.3 专注与存储验收场景

1. 两窗口同时 start：只能一次有效；不同 requestId 冲突，原 requestId replay 不新增记录。
2. pause 10 分钟/休息不贡献 work 时间；resume 截止重新计算正确。
3. 到期 timer、GET 核对、finish 同时触发，只归档一个 session。
4. 先暂停/结束再收到旧 ticker/旧响应，不复活旧会话；late response 以版本/sessionId 校验。
5. 关网页/关主窗口/退出 App/重启服务/睡眠恢复，按照墙上时间及权限承诺处理。
6. 到期已过 3 小时才恢复，最多计满目标时长，无下一轮。
7. 文件保存失败，内存不先宣布成功，原文件不坏；损坏 focus 不影响任务启动。
8. 任务完成/删除经所有入口触发 reconcile；失败 warning；undo 不复活 session。
9. focus.start 不改变 task active/plans/version；settings 不改变当前 targetMs。
10. 切换会话一个 focus 事务；旧轮和新轮不产生重叠区间。
11. 重启请求去重保留最近 100；超过保留窗口明确不保证旧 request replay。
12. 完全退出不自动 stopped；恢复读取坏数据不静默初始化。
13. 任务在截止前/后/同刻完成，归档失败后恢复，分别按统一裁决记录中断/完成；未知删除时刻只保留已闭合段。
14. 回拨冻结后 finish 不生成负段，结束后尚未修正的系统时间不能启动重叠轮次；达到 frozenAt 后 resume 保留异常标记；冻结重启不复活 ticker。
15. 自动归档已成功但用户动作返回 409 时，session 仍只保存一次；到期保存或通知意图消费失败时没有系统成功提醒。

### 15.4 统计验收场景

- 前一天 10 分钟、后一天 15 分钟、暂停 5 分钟，跨日时长正确。
- 午夜结束计数落后一天，前一天仍有区间时长。
- 25/60 分钟轮次均算一完整轮，提前结束只贡献实计时。
- task_completed 与用户 stopped 分开。
- rename/project move/delete 不重写项目历史；同名不同 ID 不合并。
- task summary 真正全历史累计，不被默认 30 天限制。
- 当前会话只计一次，历史归档后汇总连续不翻倍。
- DST 23/25 小时、Asia/Kathmandu 非整点偏移、UTC 和时区固定均一致。
- 统计范围和列表选择口径说明一致；cursor version 变化提示刷新。
- 10k/50k 数据读写、汇总耗时和内存有记录；发现明显卡顿不跳过。
- clock_changed/recovery_uncertain 有可见标记，结束日按合法 endedAt 计数；恢复时不可验证的 open 段不进入累计。

### 15.5 AI/安全验收场景

- 只读请求不创建会话/改设置；prepare 不暂停计时。
- 模型不能指定版本/requestId/server 时间/历史统计数字。
- focus 写草稿未点应用，没有副作用；拒绝后不重提执行。
- 应用中 stop 被拒绝；未知结果保留原 payload，过期后先 receipt replay。
- 内置 AI 与外部 Skill 的权限区别有测试和文档。
- 所有新 Web/Agent 路由鉴权、错 Origin、错 Host、未知路径、重复参数测试。
- 不因专注 API 开放任意静态路径；所有新增 assets 都 Node/原生可访问。
- export 不包含回执、token、消息、任务备注和路径。
- 用户已批准、focus 实际写入、响应丢失后重启：pending 清空，但 focusSubmission 存在；不用启动 Codex/Qoder 即可重试原 payload，过期但回执仍在时仍核对成功。
- submitted/unknown 在 run finally、stop、close、对话删除入口不被丢弃；恢复 POST 拒绝 action/version/requestId 覆盖、错误 Origin、错误会话/提交 ID和并发重复点击。
- 未批准 pending 重启仍清理；AI settings 不触发系统授权；主窗口授权桥拒绝子框架和非本机来源。
- 通知归档后才消费意图；消费保存失败不投递；消费成功后投递前崩溃不自动重发，页内结果可恢复。

### 15.6 运行命令和证据

实施后以仓库验证入口为准，拟议命令：

```sh
npm run check
npm test
npm run pack:mac
npm run test:native
npm run test:contracts
python3 test/focus-contract-test.py
npm run test:native-focus-notifications
python3 test/native-conversations-test.py
node scripts/benchmark-focus.mjs --records 10000,50000 --runtimes node,native --out /tmp/daylight-focus-benchmark.json
```

专注合同入口为 `npm run test:focus-contracts`。`npm run test:native-focus-notifications` 用系统 Swift 解释器执行生产 Focus 存储代码和从生产文件精确抽取的 consumer，用真实临时存储及注入 delivery 检查持久消费边界，不调用系统通知；当前稳定运行状态见第 17.3 节。UI 验收必须使用 WORKBENCH_DATA_DIR 临时数据，不操作真实任务或发布安装目录。系统通知需要 GUI 手工证据，不能由 headless 成功代替。

Done 条件：C0 的两规模/两运行时预算、代码检查、单元/集成/双运行时契约、混合写入撤销、异常终止恢复、AI 提交重启核对、关键 UI、真实原生通知（授权允许与拒绝、实际投递）完成；剩余环境限制明示；文档反映实际实现，不把设计建议写成已验证事实。

## 16. 审核清单与风险

### 16.1 实施采用的产品选项

- [x] 采用“开始专注不自动开始任务/加入今天”（D3），避免双文件联合写。如果要自动联动，需另设计可恢复的事务协调。
- [x] 采用工作必须关联任务，暂不支持自由专注（D5）。
- [x] 采用墙上时间包含睡眠/退出经过时间，页面只称计时，不称工时（D6）。
- [x] 采用历史项目按启动快照；任务累计按 taskId（D7）。
- [x] 采用统计时区首版固定、设置只读（D9）。
- [x] 采用日历移出/改期不暂停 active，而旧 plan.remove 默认保留（D11）。
- [x] 采用侧栏“专注统计”，日历留在任务范围；首版不做拖拽（D1/D2/D12）。
- [x] 采用默认 25/5、工作 1–180 分钟、休息 1–60 分钟、无自动下一轮。
- [x] 采用 task 完成/删除结束计时，undo 不复活。
- [x] 采用全历史保留和独立 JSON 导出；首版不删历史。
- [x] 采用普通网页关闭后不保证通知；原生实际权限以产物验证为准。
- [x] 采用跨日改期同日请求返回 400 SAME_DAY，不新增回执-only no-op 保存。
- [x] 采用成功归档后再投递提醒、不预排未来通知（D13），以及未知删除时刻仅保留可验证闭合段（D16）。

### 16.2 技术风险及处理

| 风险 | 应对 |
| --- | --- |
| app.js 全局事件代理误触新组件 | owning root + 独立 data 属性；组件测试和真实输入流程 |
| 动态 tick 整页刷新丢焦点/表单 | 专注节点稳定挂载，数字 patch；表单/统计订阅隔离 |
| PUT/action 两套撤销覆盖无关修改 | task-client 持有唯一撤销描述；统一提交结果和外部版本失效；混合序列测试 |
| task/focus 两文件半成功 | start 不改 task；任务成功优先、reconcile warning、启动恢复，不宣称全局事务 |
| 恢复时已到期掩盖更早任务完成 | 统一最早终止裁决；未知时刻保守处理；早/晚/同刻契约 |
| Node/Swift 时区/统计分歧 | 日窗口 adapter 对照；共享区间算法；DST 契约 |
| 历史文件长期变大 | C0 前置预算；避免全量快照跨桥；失败先修订存储适配，不静默裁剪/迁移 |
| 系统通知签名/权限不可用 | 显式受限授权桥；GUI 验证；归档后投递、保存失败不提醒；页内结果降级 |
| 计时期间时钟回拨 | 持久 paused + clockIssue、合法截点、明确 finish/resume/新轮条件，不生成负段 |
| AI 草稿过期/未知结果重启 | focusSubmission 独立于 pending/run；receipt 优先，专用原请求恢复入口，无 waiter 也可核对 |
| 新共享核心反向依赖前端目录 | task-selection 纯辅助和 task-view 兼容包装，不增加 /public URL 别名 |
| 浏览器 import core 资源被 trim 删除 | allowlist + 构建依赖图 + 打包后全部 asset 契约检查 |
| 同目录不同端口多进程写 | 首版明确不支持；如果需要，追加跨运行时文件锁设计，不误称已防护 |

### 16.3 本轮修订覆盖与实施门槛

下列勾选仅表示设计、文件职责和验收条件已补入本文，**不表示代码实现、性能预算或运行验收已经通过**。

| 审核项 | 本轮计划修订 | 实施位置与验收 |
| --- | --- | --- |
| [x] AI 提交跨重启核对 | conversation.focusSubmission、独立恢复路由和应用锁；补 store/run/service/conversations 职责 | 第 11.2.1 节；F 的重启/原 payload/waiter/消息去重测试 |
| [x] 新旧任务撤销交接 | 唯一 taskUndo、统一提交回调、外部版本失效和 replay 约束 | 第 7.5 节；A/B 的混合写入与撤销序列 |
| [x] 到期与任务终止优先级 | 最早合法截点、同刻裁决、未知时刻保守恢复 | 第 8.4.1 节；C1 两运行时契约 |
| [x] 通知与保存失败一致 | 不预排，归档后持久消费投递意图 | 第 12.3 节；E 的保存失败和崩溃窗口验证 |
| [x] 设置页原生授权通道 | 主窗口受限消息桥、回复协议、实时能力、headless 边界 | 第 12.4 节；E 的 GUI 授权和来源校验 |
| [x] 时钟冻结后的退出 | 持久标记、合法段闭合、finish/resume/start 条件 | 第 8.4.2 节；C1 的异常/重启/写失败测试 |
| [x] 共享核心依赖方向 | core/task-selection 与 public/task-view 兼容包装，取消新增别名方案 | 第 6/13 节；A/B 的依赖图和打包资源检查 |
| [x] 性能验证前置 | C0 门槛、明确预算、两规模/两运行时实测、失败停止后续批次 | 第 9.3.1/14 节；C0 和 G 的基准报告 |

本次实施采用第 16.1 节默认产品选项，按修订后的 A→B→C0→C1→D→E→F→G 门槛推进。任何改变统计口径、任务联动、性能预算或数据存储格式的决定，都先同步本文与相关契约，不能只改代码留下过期计划。

2026-10-05 的审核交付只修订设计文件；第 17.1、17.2 节保留 2026-10-06 的实施交付与验证结果，2026-10-07 的增量修复和最新边界见第 17.3 节。

## 17. 实施与验证记录

### 17.1 2026-10-06 批次交付

| 批次 | 当次实现 |
| --- | --- |
| A | 纯日期/任务选择规则、planDay/per-action day/reschedule/preserveExecution、唯一任务保存与撤销客户端、公共组件 |
| B | 42 格月历、日期详情/筛选/未来创建/改期、Hash、双运行时查询、资源允许列表 |
| C0 | 真实 Node/原生 10k/50k 基准初验通过后继续 D–F；G 收紧同步占用、实际落盘和长查询 RSS 口径，修复原生动态脚本编译增长后重跑通过 |
| C1 | 独立原子专注存储、单会话状态机、可信时间冻结/恢复、任务终止核对、统计/分页/导出及完整 API |
| D | 今天反馈、稳定全局条、计时面板、统计页、全历史任务累计、设置；单 controller 生命周期与 15 秒刷新 |
| E | 原生计时/菜单、显式受限授权桥、归档后持久通知消费、系统权限状态与错误反馈；实测修复菜单关闭时回调被提前清理，关闭窗口及暂停/继续/结束通过；通知等缺口见验证记录 |
| F | AI 只读工具/冻结草稿、批准原请求持久恢复、无 CLI run 核对、操作消息去重、Python CLI 与 API 说明 |
| G | check/test、原生/资源/任务/专注/时区契约、真实 Chrome 与性能回归；GUI 通知授权/展示验收单独记状态 |

实际维护选择：plan.move 原本就保留执行状态，不新增无效 preserveExecution 参数；只有 plan.remove 显式提供该兼容选项。Node 页面提醒采用页内结果，没有额外浏览器 Notification 权限或多窗口协调。这些选择符合首版范围。

### 17.2 2026-10-06 证据与边界

详细记录与可复核报告位于 [日历与专注验证记录](../verification/calendar-focus.md)。所有实例使用临时合成数据、独立端口与浏览器配置；没有运行真实模型推理或改写用户账号/任务。

- 全量静态检查通过，自动化测试 279/279 项通过，无跳过；包含旧任务/AI/代理回归、新旧撤销、未知写重试、跨重启 AI 提交核对、通知桥清理与同步占用计量。
- 实际打包二进制：Node/Swift HTTP 契约、全部静态允许列表资源、Foundation 日期窗口；headless 不请求通知权限。
- 真实 Chrome 六份报告 45 条断言通过：日历/撤销/未来创建、专注暂停继续结束、统计、宽窄布局、设置编辑保护和报表刷新生命周期；独立 AI 恢复卡实际点击核对并确认，回执 replay 且只记录一次消息。设置报告模拟原生返回，仅验证展示。
- 性能：每运行时每规模预热 5 次、采样至少 30 次，所有预算通过。到期延迟从首次读到原子保存后的 focus.json 计算，分别观测无 focus 请求的 timer 与报表负载场景；Node 连续同步块累加到事件循环边界，Swift 测完整 queue 操作和通知消费。
- RSS 记录 330 次查询的批次和峰值；长查询对原生每规模 1,500 次、Node 50k 共 3,000 次观察到自然回收，修复前的失败报告保留。有限样本不能证明无限运行没有泄漏。第一版仍保留单 JSON、不裁剪历史。
- 原生工作区构建已实测关闭主窗口继续计时和到期保存；最终构建再次核对闭窗驻留、菜单跨 ticker 保持、外部版本变化后的暂停/继续/结束及任务子菜单“开始任务/开始专注”的状态边界。授权允许/拒绝、实际通知展示和真实睡眠唤醒仍需补验。scheduled 只代表 OS 接受请求，不能替代展示；当前记录单独说明环境结果。

### 17.3 2026-10-07 复核修复与回归

只读复核发现的偏差已修复：合法首末年份的日历导航不再无界循环或读取越界日期，普通日期选择替换浏览器历史；冻结后的继续条件由全局条与面板共用，并能随显示时间恢复更新；到期结果与设置页展示通知投递失败，独立保留权限状态和未保存设置。AI 专注审阅使用 prepare 返回的可信标题快照、阶段、目标/累计/剩余时长，恢复卡持久保留同一 impact；批准原请求与恢复请求结构不变。普通计划操作消息保留 envelope day，批量子 action 的有效日期优先，旧消息不猜测日期。Node 保存错误统一映射为 503/FOCUS_SAVE_FAILED，保留旧权威与原请求重试；原生通知 consumer 将持久消费与 delivery 边界拆开验证。

| 层级 | 本轮确认状态 |
| --- | --- |
| 源码/Node | `npm run check` 与 `npm test` 通过，292/292 项，无跳过 |
| 实际原生 | Swift 任务回归、24 项任务 HTTP 合同、专注合同、Foundation 时区、native AI/proxy、CLI conversations 回归通过；最终二进制 SHA256 为 `2f4bac81c44f40920d6e6ac968e2c05820c60986ef18fa677d9fdcffecad8f15` |
| 浏览器 | [独立 Chrome 报告](../verification/calendar-focus/review-fix-browser/report.json) 19 条断言通过：6 条临时 Node 服务上的真实日历流程、12 条真实组件加受控快照/模拟原生回复、1 条异常守卫；模拟部分不证明真实时钟回拨、恢复落盘或 OS 投递 |
| Codex/Qoder AI | `test/focus-ai.test.mjs` 同一矩阵通过草稿→批准→持久保存、重启 unknown、无活跃 run 原请求回执恢复、单次 waiter/操作消息去重及只读问题并存；使用 mock 模型适配器，没有真实模型推理 |
| 通知 consumer | `test:native-focus-notifications` 改用系统 Swift（macOS 13 目标）执行精确生产源及最终 native-core，两次独立临时目录全部断言通过。[报告](../verification/calendar-focus/review-fix-native/notification-consumer-report.json) 保留先前签名辅助程序 SIGKILL 证据；真实存储与注入 delivery 不替代 OS 验收 |
| 新版性能 | [最终四组合报告](../verification/calendar-focus/review-fix-performance.json) Node/Swift × 10k/50k 全部预算通过；idle、报表、持久写负载的到期落盘最大 350ms，连续同步占用最大 333.9ms、RSS 增量最大 417.2MiB；已纳入重启/consumer RSS 和 JavaScriptCore 环境 |
| App/系统实操 | [本地安装读回](../verification/calendar-focus/review-fix-install.json) 通过：实际进程/签名/全包一致、日历/专注/设置入口可见，项目/任务/对话保留，代理恢复；通知允许/拒绝、实际展示、点击定位与真实睡眠唤醒仍缺证据，组合项不补勾选 |

完整分层证据与待验项见[验证记录](../verification/calendar-focus.md)和 [UI 清单](../../test/calendar-focus-ui.md)。本轮记录不把源码及模拟通过合并为总验收完成。
