# 反向代理

侧栏“反向代理”包含 Qoder、AGY、Grok、Codex、Kimi、自定义来源及模型路由标签，分别管理账号、模型与额度，共用一个服务开关、接入地址和 API Key；模型、用量、运行设置默认折叠。默认手动开启，可在停止状态下设置“随 Daylight 启动”。关闭窗口后继续运行，退出 App 时停止代理；有请求进行时，停止前需要确认中断。

- 默认监听 `127.0.0.1:4319`，端口可配置。OpenAI Base URL 为 `http://127.0.0.1:4319/v1`，Anthropic Base URL 为 `http://127.0.0.1:4319`。
- 提供 `/v1/models`、`/v1/chat/completions`、`/v1/responses`、`/v1/messages`，支持流式响应。客户端必须发送页面中的 API Key（Bearer 或 `x-api-key`）。
- Qoder 使用 PKCE 浏览器授权，登录成功后自动保存并刷新令牌。AGY 使用本机 macOS 钥匙串中的 agy 登录，要求已安装并登录 `~/.local/bin/agy`；凭证过期时调用 `agy models` 让官方 CLI 刷新，推理直接请求上游，不启动 Agent 对话。页面的连接测试检查鉴权和模型目录，不发送推理请求。
- 模型名不加来源前缀，后台按名称分发。同名模型对外只显示一次，在“模型路由”设置主用和备用顺序；可重试故障仅在输出开始前尝试备用。显式会话标识可绑定成功来源，没有会话标识时固定优先级。AGY 模型目录以实时 `agy models` 为准，缓存 5 分钟，点击刷新可立即重新发现；额度直接读取上游共享额度汇总，展示 Claude/GPT、Gemini 的 5 小时和 7 天周期。
- AGY 支持文本、base64 图片、工具调用/结果回传、`tool_choice`、`temperature`、`top_p`、`top_k`、停止序列与输出长度。Claude 与 Gemini tiered 模型支持 `low/medium/high`：Chat 使用 `reasoning_effort`，Responses 使用 `reasoning.effort`，Messages 使用 `output_config.effort`；页面可保存默认强度，请求参数优先。Gemini 按通用规则合并：同一基础 ID 仅末尾 `low/medium/high/xhigh/max` 档位不同，且本机发现至少两档时，自动合为一个模型，无需逐版本配置。可选强度以实际发现档位为准；请求参数优先于页面默认值，自动默认取 medium（若无则 high）。Flash 使用 tiered 模型加思考档位；Pro 按档位选择各自的上游模型和上游提供的思考预算。3.1 Pro 仅 low/high，不提供 medium。
- Claude 支持 `thinking: {type: "adaptive"}`、`{type: "enabled", budget_tokens: 1024}`（预算至少 1024 且小于 `max_tokens`）和 `{type: "disabled"}`；OpenAI 协议可使用 `reasoning_effort: "none"` / `reasoning.effort: "none"` 关闭。手动预算不与 effort 混用。Messages 流式/非流式保留思考块签名，可用于下一轮。工具签名仍在当前进程内保存，重启后应开启新工具会话。
- AGY 不把 `max/xhigh` 降级为 `high`；上游不接受的档位明确报错。显式 `cache_control`、缓存 TTL、上下文长度覆盖、结构化输出、服务端会话续接等未适配参数返回错误；不承诺完整 Anthropic/OpenAI API 等价。
- 三种协议共用 token/cache usage 转换与请求记录。AGY 仅映射上游实际返回的缓存读取量，缺失计数不记为零；自动缓存由上游决定，显式缓存写入/TTL 未适配。不估算金额或 Credits，也不把账户共享配额当作单次请求费用。
- 模型目录保留通用模型和企业模型，跳过团队自定义目录及名称标注“专属”的模型。Credits 用量图直接读取 Qoder 的个人额度和团队资源包，显示已用、剩余及总额度，包含其他客户端的使用；不以 Tokens 估算，也不将额度快照当作每日消费历史。
- App 自动检测 PATH、Homebrew、nvm、mise、fnm 和 Volta 中的 Node，也可手动指定绝对路径。使用标准 Node API，无额外 npm 运行依赖，不打包 Node。
- 共用服务配置和请求用量沿用 Daylight 数据目录的 `qoder/`，AGY 模型设置单独存放在 `agy/`；文件权限为 0600。用量只记录来源、模型、结果、耗时、重试和 token 数，保留最近 1,000 次请求，不记录 prompt 或工具参数。AGY 凭证不另存到数据目录。
- 原生任务服务保持独立；代理与 AI 分别使用按需启动的 Node 子进程。Node 不可用或代理配置损坏时，任务管理继续工作。退出父进程后子进程自动停止。


# Grok 中转

Grok 标签，与 Qoder、AGY 共用地址、Key 和运行开关。使用本机官方 `~/.grok/bin/grok` 的 OAuth 登录；首次运行 `grok login --oauth`。过期时调用官方 `grok models` 刷新并重读凭据，Daylight 不复制刷新令牌、不自行写认证文件、不运行 CLI Agent。模型与额度使用真实 CLI 上游目录和 billing 接口，分别缓存五分钟与一分钟；模型缓存按账号隔离，默认参数修改不会重新发现模型。

- 三种协议支持流式/非流式、图片输入、function 工具及多轮回传、推理强度；默认值可以由请求覆盖。Grok 模型上下文来自 `context_window`，不能冒充独立最大输入；最大输出未提供时保持未知。上游的输出预算限制正文，usage 输出总量还包含思考 token。
- Responses 保留原生事件、引用及不透明 reasoning 项，支持 `web_search` 和 `x_search`；Chat 的 `response_format` 和 Responses 的 `text.format` 可设置结构化输出。原生搜索只通过 Responses 开放，避免在协议转换时丢失事件语义。
- 当前不支持 `previous_response_id`、`store=true`、手动 thinking token 预算、关闭思考、显式缓存控制/TTL、上下文长度覆盖，以及未列入支持范围的采样参数。请求这些功能会明确报错，不静默降级。多轮请带完整历史；Responses 可回传原生 reasoning 项。
- usage 保留输入、输出、缓存读取、推理 token 与上游 `cost_in_usd_ticks`（官方单位：1 USD = 1e10 ticks）。这是上游报告的请求计价，不作为订阅额外实扣金额；缓存写入缺失不填零。部分客户端会自行用模型价表计算费用，不能据其显示的零费用判断上游计价。
- Pi 推荐 `openai-responses`，也可使用 `openai-completions`。如使用 `anthropic-messages`，推理需配置 `compat.forceAdaptiveThinking=true`、关闭显式缓存标记（`cacheRetention: none`）；Grok 不接受 Claude 风格的手动 thinking 预算。用户的现有 Pi 配置不会自动修改。
- Grok 模型设置与目录缓存保存在 Daylight 数据目录的 `grok/`；真实请求记录仍在共享 `qoder/usage.json`，按实际来源归属。上游未知最大输出不会写入固定硬上限。

Grok 输出预算为可选项：请求未传且页面留空时，不向上游发送 `max_output_tokens`，不增加固定 token 上限。页面已保存的预算仍作为默认值，客户端显式值优先。官方 [Grok 4.7 规格](https://docs.x.ai/developers/grok-4-7)声明无文本输出上限；CLI 上下文仍使用其在线目录值，不用公开 API 的 500k 替换。流式请求采用五分钟无数据超时，收到数据后重新计时，不因总时长超过五分钟截断持续输出。

### Codex 与自定义上游

Codex 标签只复用本机 `CODEX_HOME`（默认 `~/.codex`）中的 ChatGPT OAuth 文件。认证刷新和模型发现使用官方 app-server 的 account/model RPC；推理直接请求 Codex Responses 上游，不创建 CLI Agent、线程或工具执行环境，也不读取 Pi 的 Codex 凭据。模型发现缓存五分钟并按账号隔离，设置默认推理强度和速度不会强制重新探测。

- 推荐使用 `/v1/responses`，支持原生流式事件、图片、function 工具调用和完整历史回传。工具由调用方执行；加密 reasoning 项原样保留。Chat/Messages 采用有限协议转换，不能表示的字段明确报错。
- Codex 通道不接受显式 `max_output_tokens`（包括其他协议转换来的输出预算）、`previous_response_id`、服务端 conversation、`store=true` 和当前未适配的采样参数。多轮携带完整历史。上下文来自本机模型目录，未知最大输出不编造。
- Fast 映射到 `service_tier: priority`，与 reasoning effort 独立。请求记录分别保存请求档位与实际档位。应以上游回显的实际档位为准，不能仅凭请求成功认定 Fast 已生效。

自定义标签支持多个上游，填写 Base URL、Key、上游协议与模型映射，保存后共用现有出口和 Key。默认在 URL 后追加 chat/completions、responses 或 messages；高级设置可指定相对端点、自定义请求头、模型上下文元数据及可选输出预算。模型可发现或手填；同名模型汇集来源，通过模型路由管理，也可设置别名分别调用。每个上游支持多个 Key，分别发现模型权限；成功重新获取后覆盖目录。测试按钮会调用第一个启用模型并产生正常上游用量。

自定义 Key 和额外请求头存入 macOS Keychain，由随 App 打包的凭据助手读写，不写入来源 JSON、不通过命令行参数传递。页面留空保留原密钥。相同协议原样转发请求字段与原生响应；跨协议支持文本、图片和 function 工具的基本映射，拒绝不透明 reasoning、缓存控制、内置工具等无法无损转换的请求。Token 用量仅记录上游实际提供的字段，未知费用与缓存写入不伪造为零。

所有来源共用页面顶部的服务开关、接入地址、Key 和设置。下方“来源状态”区分目录检查与实际生成、流式、工具调用记录；成功记录只是已观察到的结果，不能保证所有模型和协议都支持相同能力。切换本机账号后需刷新登录；来源标识或保存配置改变后，旧记录不作为当前配置的验证证据。

“最近请求”统一查看原生转发和协议转换，可按来源、模型与结果筛选，包含阶段耗时、实际 HTTP 状态、上游模型与已返回的用量。记录沿用 `qoder/usage.json`，保留最近 1000 条并兼容历史格式；只保存诊断元数据，不保存提示词、响应正文、工具参数或凭据。查询 `/api/proxy/status`、`/sources`、`/requests` 使用工作台鉴权，不触发上游探测或推理，也不改变客户端 `/v1` 接口。

### Kimi Code

Kimi 标签通过官方本机授权服务启动网页 OAuth，复用 `~/.kimi-code/credentials/kimi-code.json` 的访问凭据。需要安装官方 Kimi Code；优先连接已运行的本机服务，无服务时按需启动 `kimi web --no-open`。授权与令牌刷新由官方服务负责，Daylight 不复制刷新令牌或自行写官方认证文件；推理直接调用模型 API，不创建 CLI Agent 对话。退出 Daylight 时只结束由 Daylight 启动的授权服务。

模型列表读取真实上游目录，页面优先显示展示名称，并保留接口 ID。2026-10-01 的实测中，`kimi-for-coding` 对应 K2.8 Preview，另有 K2.7 Code Highspeed、K3、K3-256k；名称和可用性由上游更新。所有模型进入统一模型路由，原有自定义配置保留。

OAuth 与 API Key 的 `kimi-for-coding` 请求均在传入 `temperature: 0.7` 时返回 400；OAuth 的 `k3`、`k3-256k` 和 Highspeed 也有相同限制，省略时均成功。这四个官方模型会省略客户端传入的 `temperature`，使用上游默认值。规则同时适用于自定义来源中精确配置为 `https://api.kimi.com/coding/v1` 的通道，不应用于其他模型或第三方中转。最近请求记录原始值及“已省略”，其余参数遵循原生转发或现有有限协议转换。

K2.8 Preview 和 K3 已分别验证普通请求及 function 工具调用，K2.8 Preview 已验证流式输出。真实工具多轮回传、不同客户端的完整编码会话及全协议兼容仍需按实际使用核验。官方授权参考：[登录流程](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html#kimi-login)、[本机授权服务 API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html)。

自定义编辑和模型路由调整共用浅绿色右侧抽屉；打开 220ms、关闭 160ms，系统减少动态效果时禁用动画。标题和操作区固定，内容独立滚动；未保存关闭会提示，保存失败保留内容。

Kimi 与 Qoder、Codex、Grok、AGY 使用同一 createProviderPage 和 proxyPage 布局，独立 kimi-proxy.js 页面已删除。网页登录是公共账号栏中的来源专属操作。官方目录的 reasoning.effort.valid / think_efforts.valid_efforts 提供支持档位，按目录展示默认推理强度；客户端传入的 reasoning_effort 或跨协议 reasoning.effort 优先于中转默认值。Highspeed 未声明档位时不提供默认强度设置。Pi 同步使用同一目录，only thinking 模型的关闭档位为不支持。

模型路由的“全部模型”和“多个来源”仅显示已启用模型。启用状态与连接可用性分别记录；连接失败的已启用模型保留在列表中，显示失败标记与“重试”，重试仅检测该模型的失败来源，保留可用备用来源。
