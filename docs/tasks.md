# 任务与导航

本文记录当前任务视图和兼容规则。原任务导航与 AI 协同方案已实施；会话协同契约归入 [AI 说明](ai.md)，管理操作与查询参数归入 [API 说明](../skills/daylight-workbench/references/api.md)。

## 页面与数据

侧栏提供任务、专注统计、AI 对话、反向代理、CLI 配置、设置六个页面。任务页内切换全部任务、今天与日历，按项目筛选或查看未归类，再切换任务状态。专注计时独立于任务执行状态，详见 [专注说明](focus.md)。

项目保存名称和关联目录，任务通过 projectId 归属项目，日期计划通过任务 ID 引用任务。未归类使用 projectId:null，不创建特殊项目；项目目录用于记录和打开路径，不自动授权 AI 扫描。

全部任务按项目分组，空项目保留便于新增。项目筛选后展示项目名称、目录、编辑/操作与相关对话，不重复显示每行项目标签。关键词匹配任务标题、备注及项目名称，搜索不改变归属。

今天保留日期、当前正在做、此前未完成安排提示和今日顺序。待办含 todo/active；今日已完成是当前日期计划内的 done 任务，不按 completedAt 重定义。选择任务可按项目/关键词查找未完成项；加入不复制任务。今天新建默认加入今天，项目仍可留空。跨天刷新当天安排并提示日期变化。

日历采用周一开始的固定 42 格月视图，日期详情保留计划顺序。月份、选中日期、项目/未归类、搜索和 open/done/all 状态保存在 URL；跨午夜只更新今天标记，不改变选中日期。月格预览与详情使用同一任务快照，计数在状态过滤前计算；方向键、Home/End、PageUp/PageDown 可选择日期，换月时夹紧月末。窄内容区把详情置于月历下方，日期格显示项目色点和数量。

在选中日期选择已有任务或新建任务，默认安排该日期。改期使用日期字段确认并提交一个 `plan.reschedule`：只移动源日期引用，目标已有引用时合并，第三天安排和任务状态保持不变。日历移出当天显式使用 `preserveExecution:true`，不暂停 active；已完成任务允许移动/移除既有安排，不能新加入一个没有该任务的日期。仅在没有项目/搜索筛选时提供待办顺序操作，避免覆盖隐藏任务。

今天页、全局专注条和任务详情提供开始专注入口；工作轮次关联真实未完成任务，开始计时不修改 active 或日期安排。任务完成/删除会结束关联工作会话，任务 undo 不复活已结束会话。详情中的记录查询只更新专注区域，不覆盖标题、项目和备注输入；存在未保存编辑时明确确认使用已保存内容。

## 视图与路由

`core/task-selection.js` 提供纯索引、筛选和计数，`public/task-view.js` 保留旧范围和默认日期包装，供网页、Node、原生 JavaScriptCore 使用；日历查询复用同一核心。`public/routes.js` 解析新旧 Hash。导航条件不写入业务 state。

| Hash | 行为 |
| --- | --- |
| `#tasks&status=open` | 全部待办 |
| `#tasks&project=ID&status=done` | 指定项目已完成 |
| `#tasks&unassigned=1&status=open` | 未归类待办 |
| `#today&status=open` | 当天安排的待办 |
| `#calendar&month=2026-10&date=2026-10-06&status=open` | 月历和指定日期详情；可带 project/unassigned/q |
| `#focus&task=ID` | 指定任务的专注统计，不打开任务编辑弹窗 |
| `#tasks&task=ID` 或 `#task=ID` | 按任务当前归属与状态定位并打开任务 |
| `#ai&conversation=ID` | 指定会话 |
| `#ai&scope=task&scopeId=ID` | 准备关联任务的新对话，首次发送才创建 |

关键词使用编码后的 q。旧 #all → 全部待办，#done → 全部已完成，#inbox → 未归类待办，#project=ID → 项目待办；#today、#ai、#proxy、#cli、#settings、#new、#new-project 继续兼容。

主动选择任务/今天/项目入口默认待办并清空关键词；任务入口还清除项目筛选。切换状态保留范围/归属/关键词；往返 AI、设置恢复任务视图与滚动位置；刷新和前进/后退以 URL 为准。任务/项目不存在时提示已删除或不存在，不按名称匹配其他对象。

多窗口和外部 API 写入通过版本同步刷新；正在编辑时保留输入并延迟列表更新，提交仍校验版本。AI 草稿应用成功后刷新计数、列表和对象链接，空筛选结果不跳到别的范围。

日历 URL 的非法日期/月会纠正并提示，有效 date 与 month 不一致时以 date 推导月份；从日历进入 AI 后的返回链接保留原条件。项目切换只改变日历筛选，不清空日期。专注状态使用独立版本与单一全局轮询，不因页面切换或任务表单编辑重建每秒计时节点。

## 业务与查询兼容

state schema 仍为 1；projects/tasks/plans、ID、日期顺序、action、expectedVersion/requestId、batch、undo 和导出语义保持原契约。开始任务暂停其他 active，完成/恢复、移出日期等行为不由导航改变。

新增 `task.create.planDay`、`plan.reschedule` 和 batch 子计划动作的 day。旧 `plan.remove` 默认仍可暂停 active，日历显式保留执行状态。Web 日历通过 `/api/task-actions` 复用服务端 action/receipt/undo；旧任务编辑仍可 `PUT /api/state`。`public/task-client.js` 持有唯一任务撤销描述：PUT 保存上一份本地快照，action 使用服务端上一版；后续任务写入或外部版本变化使旧撤销失效，专注写入不覆盖任务撤销。结果未知的 action 只核对或重试原请求；旧 PUT 使用读取核对，不伪造回执。

`GET /api/v1/tasks` 沿用 Agent Bearer 认证，capabilities.taskQuery 声明支持。scope=all|today、status=all|open|done，默认 all/all；可按 projectId、unassigned、query、day 筛选。

返回 `{version,localDate,selection,counts:{open,done,total},tasks}`。counts 在相同范围/归属/关键词下按所有状态统计，tasks 再按 status 筛选。today 保留计划顺序；读取不修改数据、版本或返回会话历史。非法筛选/日期为 400，不存在项目为 404，合法零结果为 200；完整参数见 API 说明。

Skill 旧 `state --view all|today|inbox|done` 保留：all 含全部状态，today 含计划内已完成项且保持顺序，inbox 为未归类待办。新增 tasks 命令使用统一查询；旧服务未声明支持时明确提示，不伪造结果。仓库 Skill 更新不等于独立安装的 Skill 已更新。

## AI 协同与删除恢复

项目与任务可以新建或继续指定相关会话；会话主关联、对象引用和历史引用分别保存，相关列表按真实 ID 推导。任务迁移后跟随当前项目，历史快照不重写；生成草稿仍需用户审阅应用，不因关联绕过写入确认。

删除项目级联删除全部任务及日期引用，保留本地目录。删除任务清除所有日期引用。关联会话保留并显示对象已删除，同 ID undo 后关联恢复；最新一次任务写入可撤销，后续任务写入后不把 undo 当回收站。专注保存和导出独立于任务；任务导出只含业务 state，不混入 AI 正文、专注历史或凭据。

## 维护与验证

导航/查询回归见 `test/task-view.test.mjs`、`test/sidebar.test.mjs`、Agent API 与 Skill 测试；AI 关联与草稿见 `test/ai.test.mjs`，原生查询见 `test/native-test.py`。修改共享选择器或路由时同时核验 Node、原生资源和旧链接。

日历与混合任务撤销回归见 `test/calendar-routes.test.mjs`、`test/task-client.test.mjs` 及日历 API/双运行时测试。2026-10-06 的独立临时 Chrome 已完成 13 项基础交互检查，以及编辑保护/暂停切换、390px 布局、设置错误显示和报表请求生命周期的补充检查，均通过且无运行异常。1440/620/390px 日历、统计与全局条布局，原子改期/撤销、未来日期创建、专注状态与任务执行状态独立均有实际浏览器证据；详情打开期间的累计记录实际等待 15 秒刷新，隐藏标签页和暂停后实际等待 16.5 秒确认报表停止查询。

今日汇总、统计页与任务详情复用 `public/focus/report-refresh.js`，只有入口可见、文档可见且工作会话运行时才启用额外 15 秒刷新，隐藏/离开时取消请求，恢复可见立即读取。专注设置复用共享设置行和表单样式；系统权限失败保留“上次读取”状态，显示中文操作建议并折叠系统原文，普通网页不显示原生动作。前端专项回归 29 项通过，覆盖未知写入、过期响应、隐藏停止、凭证轮换、并发 PUT/action 与设置权限生命周期。详细报告、截图及尚未验证的原生 GUI 项目见 [界面验收清单](../test/calendar-focus-ui.md)；模拟原生错误展示与真实 WKWebView 桥接分开记录，不能据此声称 OS 已允许通知或实际投递成功。

原方案的隔离浏览器与 Codex/Qoder 运行时协同验收已记录完成。该历史记录不代表未来版本自动通过；新变更以相应自动化、隔离交互与必要真实运行结果分别记录。构建和测试不会自动安装 App 或同步个人 Skill。
