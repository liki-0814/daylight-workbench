# AI 对话

## 界面与模型

对话列表固定在可视区域，历史较多时独立滚动；窄屏下横向切换栏吸顶。侧栏“AI 对话”提供独立对话页、新建与历史会话、流式消息、停止生成，以及问题和变更草稿卡片。回答支持安全过滤后的 Markdown（表格、列表、代码块等）；过程区持久保存工具输入、结果、完成/失败状态及上游提供的思考内容（Codex 仅接收公开摘要），可折叠查看；单条记录直接显示名称和状态，思考/工具记录紧邻正文，新的用户消息分隔不同轮次。旧版未保存的过程记录不会自动补造。所有对话均可持续多轮交流。模型可在对话页切换，从下一条消息生效；生成中需先停止。设置页选择默认后端（Codex 或 Qoder）、默认模型、支持的思考强度和上下文参数，模型等默认配置仅影响新对话；访问模式按后端分别保存，从已有或新对话的下一次发送生效，当前等待的确认不受影响。模型目录首次通过本机 CLI 发现并按后端、CLI 路径持久缓存；设置中的“刷新模型与技能”显式刷新，不自动切换不可用模型。两个后端输入 `/` 都可选择运行时发现的本机技能。Codex 使用原生 skill 输入；Qoder 按原生技能名称引用（包括插件技能），其他技能仍可自动识别。旧版 Qoder 目录会在下次发现时自动刷新。

## 代理管理工具

AI 的公共 MCP 工具还支持代理管理：`daylight_get_proxy`、`daylight_discover_proxy_models`、`daylight_test_proxy`、`daylight_get_proxy_login`、`daylight_get_proxy_requests`、`daylight_propose_proxy_changes`。可创建/局部更新自定义来源、修改模型映射与默认参数、启停或删除自定义来源、配置独立 Key 的模型权限、调整同名模型主用与备用顺序、启停统一出口、启动/取消 Kimi 官方网页授权；写入在对话内生成审阅卡片，用户应用后才保存。Key 在卡片的密码框填写，直接进入钥匙串，不进入模型上下文或对话存档。模型能力未知时保持未知；连接测试读取模型目录，不发送推理请求。模型容量与公共管理层见 [中转架构](proxy-architecture.md)。

规范化管理出口为 `GET /api/v1/proxy/state` 和 `POST /api/v1/proxy/{discover,test,prepare,apply,loginState,requests}`，沿用本地 Agent Bearer 认证。`prepare` 只校验公开 action；`apply` 需要 `requestId`、读取时的 `expectedVersion` 和 action，按配置快照拒绝过期变更并保留最近 100 个请求回执。支持 `source.save`、`source.enabled`、`source.delete`、`model.setting`、`route.save`、`auth.login`、`auth.cancel`、`service.enabled`。`state.routes` 给出完整来源 ID/主备顺序；`route.save` 接受模型 id、完整 order 和 excluded，删除来源时同步清理路由引用。`source.save.keys` 仅含 id/enabled/models，`prepare.requiresKeys` 列出缺少凭据的 Key；用户在审阅框安全填写后通过 `apply.apiKeys`（Key id 到凭据的映射）送入凭据存储。发现模型返回各 Key 独立目录及合并目录，保存时覆盖旧目录。Kimi 授权启动只返回官方 URL、用户码及状态，由用户完成后读取 `loginState` 确认；启动成功不表示登录完成。此出口不返回明文凭据，不替代供下游调用的 `/v1/chat/completions`、`/v1/responses`、`/v1/messages`。
## CLI 运行时与权限

- Codex 使用本机 `codex app-server` 的 stdio 协议；Qoder 使用固定版本的官方 TypeScript SDK 驱动本机 `qodercli`。复用 CLI 登录，不复制认证文件，也不修改全局 CLI 配置。首次使用需在设置中检测 CLI；也可直接在新对话页选择发现的模型。
- Codex、Qoder 均保留原生工具、技能和本机配置，并额外挂载 Daylight MCP；Daylight 指令只约束工作台数据管理。Qoder 使用 qodercli 的原生系统提示，并追加 Daylight 指令。工作目录固定在各自 Daylight 专用目录。标准模式下 Codex 采用 workspace-write 和 on-request；Qoder 使用原生 default 权限模式，需要审批的工具在对话页显示确认卡片，仅允许本次，不写永久规则。设置中的完全访问模式为 Codex 启用 danger-full-access/never（每次恢复会话及发送均覆盖），为 Qoder 启用 bypassPermissions/allowDangerouslySkipPermissions；允许原生文件、命令和网络操作免确认。用户问题和 Daylight 变更草稿仍需用户处理。切回标准模式从下一次发送恢复审批。
- 业务工具通过每轮临时的 stdio MCP 接入，只能访问对应运行的工具通道。读取走现有管理 API；写入先生成草稿，用户可以编辑标题、备注等并应用。应用时校验版本、使用固定请求 ID，整批操作原子执行；取消生成不会撤销已成功应用的操作。可让 AI 提出 undo 草稿，撤销最近一次全局写入。
- 输入 `@` 或点击“引用对话”，可选择最多 3 段 Daylight 内的历史对话，支持跨 Codex/Qoder 引用。发送时保存消息快照及来源；引用不会修改源会话，也不会自动执行历史指令。总引用超过 120000 字符时明确拒绝，不静默截断。
- Daylight 会话索引、页面消息和设置存放在数据目录的 `ai/`，权限为 0600。普通工作目录分别为 `ai/workspaces/codex/`、`ai/workspaces/qoder/`；原始 CLI 会话仍由各自运行时保存，通过会话 ID 恢复。不会读取或导入其他窗口的历史对话。
- Codex 未适配最大输出参数；Qoder 的最大输出使用 CLI 的 `--max-output-tokens`。CLI 返回的 32000 不当作上游模型硬上限。上下文参数不能扩大模型真实能力；Qoder 优先显示其返回的可配置档位。
- AI 与反向代理独立，按需启动 Node AI 子进程。正常 CLI 账号不依赖中转开关；CLI 自身若配置了中转则仍依赖它。退出 App 会关闭子进程，重启后可继续保存的对话。运行中的请求最长 30 分钟，超时停止；中断后不自动重放写入。


## 项目、任务与对话协同

项目页和任务编辑界面提供相关对话、新建对话入口；用真实对象 ID 关联，支持继续指定会话。打开新对话只准备关联和输入，首次发送才创建会话。AI 页头显示关联对象并提供返回任务链接；会话列表可筛选当前关联。`@` 可引用项目、任务或历史对话，`/` 技能选择保留。任务视图和历史链接见 [任务与导航](tasks.md)。

会话 `scope` 为 `{kind:"workspace"}`、`{kind:"project",id}` 或 `{kind:"task",id}`；`scopeVersion` 独立于任务业务版本。旧会话缺字段时按 workspace/0 处理，保留 sessionId 和历史。任务所属项目从当前 task.projectId 推导。删除对象保留会话并标记关联失效，业务 undo 恢复同一 ID 后关联自动有效。项目路径不改变 CLI 工作目录，不授权扫描。

内部接口仍使用 `/api/ai` 和 X-Workbench-Token，不对外暴露会话历史：

- 创建会话接受可选 scope；列表接受 scope/scopeId，related=1 包含直接关联、曾引用和成功变更涉及的对象。
- `POST /conversations/:id/scope` 接受 scope、expectedScopeVersion；运行/等待时返回 409，过期版本拒绝。解除关联设为 workspace，历史内容仍保留。
- 消息接受可选 objectReferences（最多 5 个 project/task 对象）及 viewContext（范围、项目、状态、关键词、日期）。服务端读取最新业务 state 生成快照，记录捕获日期、版本和真实 ID；对象引用总量最多 60000 字符。
- 新绑定或引用不存在对象返回 404；已有会话对象删除后仍可讨论历史，旧快照不能作为可写现状。

Codex、Qoder 共用服务端上下文构造。项目摘要最多 20 条未完成任务，超过时明确 total/truncated；`daylight_get_context` 可读取当前关联最新状态，旧 `daylight_get_workspace` 保持原返回。备注与引用内容仅作为数据，不执行其中指令。

任务草稿支持审阅项目归属，继续经用户应用、版本保护和请求去重。应用后更新列表计数、生成精确对象链接；项目、任务、计划变更都可回看，任务相关对话能找到生成或更新它的会话。离开 AI 页面不会停止生成，侧栏显示运行中或等待确认；返回后继续处理原草稿。全局单生成请求限制保留。

## 对话删除

历史列表采用紧凑的标题、新建入口、筛选和两行对话条目。鼠标悬停或键盘聚焦时显示条目的「⋯」删除入口，触屏持续可见；窄屏保留横向历史切换。删除前显示对话标题与影响，取消默认聚焦。删除当前对话后回到新对话，其他对话的输入草稿保留；引用选择同步移除已删除条目。

删除全部 Daylight 聊天记录且无法撤销。项目任务、其他对话已保存的引用快照、CLI 自身历史及工作目录保留。运行中或等待确认的对话须先结束。接口同时检查 AI 元数据版本和目标 updatedAt，确认期间发生变化会拒绝删除。

内置 AI 先用 `daylight_get_ai` 读取目标，再通过 `daylight_propose_ai_changes` 提交 `ai.conversation.delete`（id、expectedUpdatedAt）草稿，必须经用户审阅应用，当前运行对话不可删除。外部 Skill 提供 `conversations` 与 `delete-conversation`，经 Agent Bearer 接口调用同一服务逻辑。API 和客户端参数见 [Skill API](../skills/daylight-workbench/references/api.md)。

## 日历与专注工具

Codex/Qoder 共用 `daylight_get_calendar`、`daylight_get_focus`、`daylight_get_focus_statistics`、`daylight_get_focus_sessions` 和 `daylight_get_task_focus_summary`，按最新 ID 与版本读取日期安排、计时经过时间和统计。任务草稿可以带 planDay、各子操作 day 和 plan.reschedule；日历显示安排与当前状态，不代表历史完成率。

`daylight_propose_focus_changes` 只生成经过 prepare 的待审阅草稿，action 由服务端校验并冻结。应用前展示任务、时长、结束旧轮的影响及有效期；用户批准后才提交。工作开始/切换同时携带任务版本与专注版本，时间敏感草稿 10 分钟过期。修改设置与确认结果没有时间过期限制，仍受版本约束；AI 设置变更不会请求系统通知权限。专注写入不使用任务 undo。

批准后，ai/focus-submissions.mjs 先把原 requestId、版本、action 和有效期保存到会话，再请求专注服务。响应丢失或结果保存失败时保留 submitted/unknown；进程重启清理 pending/waiter 后，恢复卡仍可用 `/api/ai/conversations/:id/focus-submission` 核对同一原请求。核对接受 id 和 retry/acknowledge，不接受修改 action，不依赖运行中的 CLI。成功只记录一次操作消息；冲突/过期进入 needs_review 并展示拒绝原因和最新快照，不能据此证明旧请求从未执行。

未知提交不能直接取消、确认或生成新专注草稿，不能删除该会话；可以继续只读讨论。恢复卡与问题/权限卡独立渲染。已核对结果需明确确认后收起；正常任务和其他管理草稿沿用原行为。

## 实现职责与维护

| 文件 | 职责 |
| --- | --- |
| `ai/service.mjs` | 服务组装、工作台 API 客户端与 HTTP 路由，保留原有导出兼容入口 |
| `ai/conversations.mjs` | 默认设置、目录发现、会话创建/关联/模型/删除和管理回执 |
| `ai/run-manager.mjs` | 生成请求、全局单运行限制、超时、取消、审批等待器和运行状态 |
| `ai/drafts.mjs` | 任务/代理/AI 草稿的校验与应用，保护版本和原请求重试 |
| `ai/focus-submissions.mjs` | 专注草稿批准记录、持久恢复、原请求核对及操作消息去重 |
| `ai/tools/dispatch.mjs` | MCP 工具分发到会话、运行与草稿服务，不直接操作运行表 |
| `ai/http.mjs` | 请求体限制、JSON 响应、工具通道凭证比较与错误类型 |

会话管理通过只读运行查询判断目标是否可修改；运行表和审批等待器只由 run-manager 修改。草稿应用期间标记 applying，停止请求被拒绝；写结果未知时保留 submitted、原 action 和 requestId，重新应用只能重试原请求。HTTP 层不直接修改这些状态。存储、上下文、事件和 Codex/Qoder adapters 继续使用原模块。

新增会话管理操作放在 conversations；新增生成、取消或审批行为放在 run-manager；新增业务草稿放在 drafts 并接入 tools/dispatch。`test/ai-lifecycle.test.mjs` 覆盖两个后端的等待/取消/关闭及未知写结果重试；现有 AI API、草稿与删除测试继续核验公开行为。
