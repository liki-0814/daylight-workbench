# AI 对话

侧栏“AI 对话”提供独立对话页、新建与历史会话、流式消息、停止生成，以及问题和变更草稿卡片。回答支持安全过滤后的 Markdown（表格、列表、代码块等）；过程区持久保存工具输入、结果、完成/失败状态及上游提供的思考内容（Codex 仅接收公开摘要），可折叠查看。旧版未保存的过程记录不会自动补造。所有对话均可持续多轮交流。模型可在对话页切换，从下一条消息生效；生成中需先停止。设置页选择默认后端（Codex 或 Qoder）、默认模型、支持的思考强度和上下文参数，仅影响新对话。模型目录首次通过本机 CLI 发现并按后端、CLI 路径持久缓存；设置中的“刷新模型与技能”显式刷新，不自动切换不可用模型。Codex 对话输入 `/` 可选择已启用的本机技能，通过原生 skill 输入引用；Qoder 当前不支持显式技能引用。

AI 的公共 MCP 工具还支持代理管理：`daylight_get_proxy`、`daylight_discover_proxy_models`、`daylight_test_proxy`、`daylight_propose_proxy_changes`。可创建/局部更新自定义来源、修改模型映射与默认参数、启停来源和统一出口；写入在对话内生成审阅卡片，用户应用后才保存。Key 在卡片的密码框填写，直接进入钥匙串，不进入模型上下文或对话存档。模型能力未知时保持未知；连接测试读取模型目录，不发送推理请求。

规范化管理出口为 `GET /api/v1/proxy/state` 和 `POST /api/v1/proxy/{discover,test,prepare,apply}`，沿用本地 Agent Bearer 认证。`prepare` 只校验公开 action；`apply` 需要 `requestId`、读取时的 `expectedVersion` 和 action，按配置快照拒绝过期变更并保留最近 100 个请求回执。支持 `source.save`、`source.enabled`、`model.setting`、`service.enabled`。此出口不返回明文凭据，不替代供下游调用的 `/v1/chat/completions`、`/v1/responses`、`/v1/messages`。


- Codex 使用本机 `codex app-server` 的 stdio 协议；Qoder 使用固定版本的官方 TypeScript SDK 驱动本机 `qodercli`。复用 CLI 登录，不复制认证文件，也不修改全局 CLI 配置。首次使用需在设置中检测 CLI；也可直接在新对话页选择发现的模型。
- Codex 保留本机技能和原生工具，工作目录固定在 Daylight 专用目录，采用 workspace-write 和 on-request；CLI 的命令/文件审批显示在对话页，仅允许本次，不写永久规则。Qoder 当前提供 Daylight 工具及提问能力，不开放通用文件和命令工具。
- 业务工具通过每轮临时的 stdio MCP 接入，只能访问对应运行的工具通道。读取走现有管理 API；写入先生成草稿，用户可以编辑标题、备注等并应用。应用时校验版本、使用固定请求 ID，整批操作原子执行；取消生成不会撤销已成功应用的操作。可让 AI 提出 undo 草稿，撤销最近一次全局写入。
- 输入 `@` 或点击“引用对话”，可选择最多 3 段 Daylight 内的历史对话，支持跨 Codex/Qoder 引用。发送时保存消息快照及来源；引用不会修改源会话，也不会自动执行历史指令。总引用超过 120000 字符时明确拒绝，不静默截断。
- Daylight 会话索引、页面消息和设置存放在数据目录的 `ai/`，权限为 0600。普通工作目录分别为 `ai/workspaces/codex/`、`ai/workspaces/qoder/`；原始 CLI 会话仍由各自运行时保存，通过会话 ID 恢复。不会读取或导入其他窗口的历史对话。
- Codex 未适配最大输出参数；Qoder 的最大输出使用 CLI 的 `--max-output-tokens`。CLI 返回的 32000 不当作上游模型硬上限。上下文参数不能扩大模型真实能力；Qoder 优先显示其返回的可配置档位。
- AI 与反向代理独立，按需启动 Node AI 子进程。正常 CLI 账号不依赖中转开关；CLI 自身若配置了中转则仍依赖它。退出 App 会关闭子进程，重启后可继续保存的对话。运行中的请求最长 30 分钟，超时停止；中断后不自动重放写入。
