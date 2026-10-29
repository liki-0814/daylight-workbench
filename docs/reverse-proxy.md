# 反向代理

侧栏“反向代理”包含 Qoder、千问办公、AGY、Grok、Codex、Kimi、Copilot、自定义来源及模型路由标签，分别管理账号、模型与额度，共用一个服务开关、接入地址和 API Key；模型、额度、运行设置默认折叠。默认手动开启，可在停止状态下设置“随 Daylight 启动”。关闭窗口后继续运行，退出 App 时停止代理；有请求进行时，停止前需要确认中断。后端和前端的具体文件职责见 [中转架构](proxy-architecture.md)。

标签栏右侧“显示来源”可勾选需要显示的来源，默认全部显示，保存后在本机持续生效。隐藏只影响来源页面，不会停用来源、退出账号、删除配置或改变模型路由，代理运行时也能修改。模型路由始终可见；当前来源被隐藏时切换到第一个可见页面。显示设置独立保存在 `qoder/view.json`，记录隐藏项而非固定的可见白名单，新增来源默认显示。

Qoder、AGY、Grok、Codex、Kimi、Copilot 都可直接在 Daylight 登录，无需安装对应 CLI。来源页复用同一账号栏：未登录时提供网页登录，登录后显示账号、刷新登录和退出账号；“刷新登录”续期当前凭据并重新检测目录。Qoder 更换或退出账号前仍需停止代理。取消待完成的授权不删除已有账号，退出只清除 Daylight 保存的该来源凭据，不修改 CLI 登录文件。AGY、Kimi、Grok、Codex 和 Copilot 凭据保存在 macOS Keychain。

独立认证仅用于反向代理。AI 对话的 Codex / Qoder 执行后端继续使用各自 CLI；AI 管理工具可以为所有上述来源生成登录、取消、刷新及退出草稿，由用户审阅应用。

## macOS 安装包的网络与证书

原生 App 启动 Node 时显式使用 Node 内置公共根证书；Node 22.19+、23.9+、24+ 同时加载系统信任证书，保留 `NODE_EXTRA_CA_CERTS`。这避免 Homebrew Node 默认 OpenSSL 证书路径缺失时，所有来源在授权请求阶段一起失败。TLS 校验保持启用。

来源的授权、身份校验、续期、模型目录、额度和推理共用网络层。原生父进程读取 macOS 静态 HTTP/HTTPS 代理，终端显式设置的 `http_proxy` / `HTTP_PROXY`、`https_proxy` / `HTTPS_PROXY` 和 `no_proxy` / `NO_PROXY` 优先；本机 `127.0.0.1`、`localhost` 和 `::1` 始终直连。系统代理变更后重启 App。当前不解析 PAC 或 SOCKS 专用代理，请启用代理软件的系统 HTTP/HTTPS 代理。

证书、连接超时、DNS 和钥匙串失败会显示明确原因，ChatGPT / AGY 回调错误会保留到页面；网络或证书失败不应要求退出已有账号。AGY 会自动检测本机官方客户端的 OAuth 参数，检测方式与手动覆盖见下文。

## 公共服务与 Qoder / AGY

- 默认监听 `127.0.0.1:4319`，端口可配置。OpenAI Base URL 为 `http://127.0.0.1:4319/v1`，Anthropic Base URL 为 `http://127.0.0.1:4319`。
- 提供 `/v1/models`、`/v1/chat/completions`、`/v1/responses`、`/v1/messages`，以及图像和视频的 `/v1/images/generations`、`/v1/images/edits`、`/v1/videos/generations`、`/v1/videos/{id}`。文本支持流式响应。客户端必须发送页面中的 API Key（Bearer 或 `x-api-key`）。图像和视频模型不出现在 `/v1/models`。 来源页的“图像与视频”支持逐个启用或停用，设置自动保存；停用后拒绝新的生成请求，已提交的视频任务仍可查询。公共“接入配置”默认折叠，展开后可复制地址、密钥与请求示例。
- Qoder 使用 PKCE 浏览器授权，登录成功后自动保存并刷新令牌。AGY 通过 Google 官方 OAuth 网页独立登录，使用本机 `localhost:51121/oauth-callback` 回调、state 和 PKCE；回调服务只监听 `127.0.0.1`，取消、过期和关闭会释放端口。令牌存入 Daylight 自有的 `agy-oauth` Keychain 项，续期复用公共账号机制，不启动 CLI。
- AGY 登录及续期优先使用本机 OAuth 客户端配置，默认路径为 `~/.config/daylight/agy-oauth-clients.json`，可用 `DAYLIGHT_AGY_OAUTH_CLIENTS_FILE` 指定其他路径。默认文件不存在时，自动从 PATH、`~/.local/bin/agy`、Homebrew 路径或系统／用户 Applications 下的官方 Antigravity 安装中只读识别 consumer 客户端参数；仅接受已知公开客户端指纹对应的一对参数，不执行 CLI、不读取账号令牌、不写入原客户端配置。指纹不匹配时不会猜测其他 Google 客户端。手动文件按 `consumer` / `gcp` 保存 `client_id` 和 `client_secret`，建议权限为 `0600`；网页登录使用 `consumer`。显式指定但无效的配置仍报错，避免静默切换客户端。源码和安装包不包含这些参数；既无可识别安装也无配置时给出明确提示，原登录保留。
- 兼容升级时，没有 Daylight 独立凭据才尝试一次导入旧 CLI 登录文件或旧版 Keychain。可读取且有效的账号复制到 Daylight；原记录不修改、不删除。旧凭据不可读取不阻止新网页登录。退出会阻止以后重新导入，避免已退出的账号自动恢复。此后续期仅更新 Daylight 凭据，CLI 切换账号不会自动替换 Daylight 登录。
- Google 授权成功后还要通过 AGY 项目和模型目录检查。未开通、账号权限/资格失败与登录失效分别提示，不把目录成功当作真实推理成功。推理直接请求上游，不启动 Agent 对话；页面连接检查不发推理请求。
- 模型名不加来源前缀，后台按名称分发。同名模型对外只显示一次，在“模型路由”设置主用和备用顺序；可重试故障仅在输出开始前尝试备用。显式会话标识可绑定成功来源，没有会话标识时固定优先级。AGY 模型目录直接读取上游推荐模型及具体推理档位，保留上游提供的 CLI 公共别名和模型路由，缓存 5 分钟，点击刷新可立即重新发现；额度直接读取上游共享额度汇总，展示 Claude/GPT、Gemini 的 5 小时和 7 天周期。
- Gemini 图像走 `/v1/images/generations` 和 `/v1/images/edits`，使用同一把 Google 登录，请求发到 `daily-cloudcode-pa.googleapis.com/v1internal:generateContent`。已登录即转发 `gemini-3-pro-image`、`gemini-3.1-flash-image`、`gemini-3.1-flash-image-preview`、`gemini-2.5-flash-image-preview`。这些 id 不进入聊天目录。上游返回图像字节，默认以 `b64_json` 交给客户端。
- AGY 图像编辑的远程参考图只接受公网 `https` 地址；本机、回环、内网、链路本地等地址（含 IPv6 与 DNS 解析后的结果）一律拒绝。图片先看 `content-length`，再边读边计数，超过 8 MB 立即中止，不再整张缓冲后才判断。
- AGY 支持文本、base64 图片、工具调用/结果回传、`tool_choice`、`temperature`、`top_p`、`top_k`、停止序列与输出长度。Claude 与 Gemini tiered 模型支持 `low/medium/high`：Chat 使用 `reasoning_effort`，Responses 使用 `reasoning.effort`，Messages 使用 `output_config.effort`；页面可保存默认强度，请求参数优先。Gemini 按通用规则合并：同一基础 ID 仅末尾 `low/medium/high/xhigh/max` 档位不同，且本机发现至少两档时，自动合为一个模型，无需逐版本配置。可选强度以实际发现档位为准；请求参数优先于页面默认值，自动默认取 medium（若无则 high）。Flash 使用 tiered 模型加思考档位；Pro 按档位选择各自的上游模型和上游提供的思考预算。3.1 Pro 仅 low/high，不提供 medium。
- Claude 支持 `thinking: {type: "adaptive"}`、`{type: "enabled", budget_tokens: 1024}`（预算至少 1024 且小于 `max_tokens`）和 `{type: "disabled"}`；OpenAI 协议可使用 `reasoning_effort: "none"` / `reasoning.effort: "none"` 关闭。手动预算不与 effort 混用。Messages 流式/非流式保留思考块签名，可用于下一轮。工具签名仍在当前进程内保存，重启后应开启新工具会话。
- AGY 不把 `max/xhigh` 降级为 `high`；上游不接受的档位明确报错。显式 `cache_control`、缓存 TTL、上下文长度覆盖、结构化输出、服务端会话续接等未适配参数返回错误；不承诺完整 Anthropic/OpenAI API 等价。
- 三种协议共用 token/cache usage 转换与请求记录。AGY 仅映射上游实际返回的缓存读取量，缺失计数不记为零；自动缓存由上游决定，显式缓存写入/TTL 未适配。不估算金额或 Credits，也不把账户共享配额当作单次请求费用。
- 模型目录保留通用模型和企业模型，跳过团队自定义目录及名称标注“专属”的模型。Credits 用量图直接读取 Qoder 的个人额度和团队资源包，显示已用、剩余及总额度，包含其他客户端的使用；不以 Tokens 估算，也不将额度快照当作每日消费历史。
- App 自动检测 PATH、Homebrew、nvm、mise、fnm 和 Volta 中的 Node，也可手动指定绝对路径。使用标准 Node API，无额外 npm 运行依赖，不打包 Node。
- 共用服务配置和请求用量沿用 Daylight 数据目录的 `qoder/`，AGY 模型设置单独存放在 `agy/`；文件权限为 0600。用量只记录来源、模型、结果、耗时、重试和 token 数，保留最近 1,000 次请求，不记录 prompt 或工具参数。AGY 令牌保存于 Keychain；`agy/auth.json` 只记录退出后禁止重新导入旧登录的标记。
- 原生任务服务保持独立；代理与 AI 分别使用按需启动的 Node 子进程。Node 不可用或代理配置损坏时，任务管理继续工作。退出父进程后子进程自动停止。


## 千问办公

千问办公的 MaaS 系统 Chat 模式支持 `low / medium / high / xhigh / max`。目录中的 `is_reasoning: false` 不代表推理接口拒绝强度参数：2026-10-22 真实请求验证了六个系统模式接受这些档位、拒绝非法档位，并返回推理用量。适配仅对目录没有明确档位列表、直接使用 `mode-` 标识的系统 Chat 模式补全这些能力；BYOK、自定义上游和其他原生协议不套用此规则，后续明确提供的档位列表优先。

Chat Completions 使用 `reasoning_effort`，Responses 使用 `reasoning.effort`，Messages 使用 `output_config.effort` 和自适应 thinking，经转换后向 MaaS 原样传递档位；不会把 `max` 或 `xhigh` 降为 `high`。页面可保存默认强度，单次请求优先；自动模式不追加强度参数。实测接受参数不保证短题的推理 token、耗时或正确率随档位单调增加，也不能据此确认三个产品档位的底层型号。

## Grok

Grok 与其他来源共用地址、Key 和运行开关。Daylight 通过 xAI OIDC 发现设备授权与令牌端点，用户在官方网页输入授权码后完成登录；访问令牌与轮换的刷新令牌独立保存，不读取 `~/.grok`，也不运行 `grok login` 或 `grok models`。模型和额度继续使用现有订阅通道的 models / billing 接口，分别缓存五分钟与一分钟；模型缓存按账号隔离，默认参数修改不会重新发现模型。该路径不会自动回退到独立付费 API Key。

- 三种协议支持流式/非流式、图片输入、function 工具及多轮回传、推理强度；默认值可以由请求覆盖。Grok 模型上下文来自 `context_window`，不能冒充独立最大输入；最大输出未提供时保持未知。上游的输出预算限制正文，usage 输出总量还包含思考 token。
- Responses 保留原生事件、引用及不透明 reasoning 项，支持 `web_search` 和 `x_search`；Chat 的 `response_format` 和 Responses 的 `text.format` 可设置结构化输出。原生搜索只通过 Responses 开放，避免在协议转换时丢失事件语义。
- 当前不支持 `previous_response_id`、`store=true`、手动 thinking token 预算、关闭思考、显式缓存控制/TTL、请求正文中的上下文长度覆盖，以及未列入支持范围的采样参数。请求这些功能会明确报错，不静默降级。页面的上下文选择仅调整客户端目录容量，不扩大上游窗口。多轮请带完整历史；Responses 可回传原生 reasoning 项。
- usage 保留输入、输出、缓存读取、推理 token 与上游 `cost_in_usd_ticks`（官方单位：1 USD = 1e10 ticks）。这是上游报告的请求计价，不作为订阅额外实扣金额；缓存写入缺失不填零。部分客户端会自行用模型价表计算费用，不能据其显示的零费用判断上游计价。
- Pi 推荐 `openai-responses`，也可使用 `openai-completions`。如使用 `anthropic-messages`，推理需配置 `compat.forceAdaptiveThinking=true`、关闭显式缓存标记（`cacheRetention: none`）；Grok 不接受 Claude 风格的手动 thinking 预算。用户的现有 Pi 配置不会自动修改。
- Grok 模型设置与目录缓存保存在 Daylight 数据目录的 `grok/`；真实请求记录仍在共享 `qoder/usage.json`，按实际来源归属。上游未知最大输出不会写入固定硬上限。

图像和视频使用同一次 Grok 登录，走 `cli-chat-proxy.grok.com` 的 `/images/generations`、`/images/edits`、`/videos/generations`。本机入口是 `/v1/images/generations`、`/v1/images/edits`、`/v1/videos/generations` 和 `/v1/videos/{id}`。模型包括 `grok-imagine-image-2.0`、`grok-imagine-image`、`grok-imagine-image-quality`、`grok-imagine-video-1.5`、`grok-imagine-video-1.5-lite` 和 `grok-imagine-video`。这些 id 不进入聊天目录、模型路由或 Pi 同步。来源页在聊天模型下面单独列出它们。视频任务保存在数据目录的 `proxy/media-jobs.json`，只记录任务号和状态，不记录提示词或图片。

Qoder 也有图像和视频，同一次登录，走 `api3.qoder.sh` 的 `/algo/api/v2/service/pro/generateImage` 和 `/videos`（COSY 签名，请求体与聊天同样编码）。本机入口同上，模型是 `qwen-image-3.0`（上游 `ge3i`，显示名带“映射待确认”）和 `wan3.0-video`（万相 3.0，上游 `wan30`，别名 `wan30`）。图像只返回 `b64_json`，视频目前只有文生视频（`duration` 2 到 30 秒、`size`），任务和 Grok 一样保存在 `proxy/media-jobs.json`。费用是团队 Credits（图像约 4、5 秒 720p 视频约 40，实测），不折算美元，不进参考花费。详见 [plans/qoder-media.md](plans/qoder-media.md)。

Grok 输出预算为可选项：请求未传且没有历史默认预算时，不向上游发送 `max_output_tokens`，不增加固定 token 上限。历史已保存预算仍作为默认值，客户端显式值优先；统一页面不再单独提供预算输入框，容量选择的语义见下文。订阅通道能力以其在线目录和实际返回为准，不能用公开 API 的规格替换。流式请求采用五分钟无数据超时，收到数据后重新计时，不因总时长超过五分钟截断持续输出。

历史验收（2026-09-30）：四个在线模型文本推理通过；grok-4.7 的图片、结构化输出、函数工具回传、网页/X 搜索通过，彼时安装的 Pi 通过三种协议的工具与多轮回传。该记录来自统一架构重构前，不代表 0.4.0 已完成相同真实账号回归。

## Codex

Codex 标签通过 [Sign in with ChatGPT 的开源客户端流程](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)独立授权。点击“Continue with ChatGPT”后打开登录链接，使用本机随机端口回调、PKCE、state、nonce 和签名校验；保留稳定 host ID 与授权返回的 client ID。访问、刷新和 ID 令牌保存在 Daylight 的 Keychain 项，不读取 `CODEX_HOME`，不启动 app-server。模型与推理直接调用 `https://api.openai.com/v1/models` 和 `/responses`，模型目录按账号缓存五分钟，401 最多续期重试一次。需要用户授权 `chatgpt.tokens.use.direct`，实际可用性受套餐及上游准入限制。

此独立授权接口没有文档化的额度查询端点，额度区明确显示暂未提供；不会将未知额度显示成零。用量与授权可在 [ChatGPT 设置](https://chatgpt.com/settings/usage)核对。

- 推荐使用 `/v1/responses`，支持原生流式事件、图片、function 工具调用和完整历史回传。工具由调用方执行；加密 reasoning 项原样保留。Chat/Messages 采用有限协议转换，不能表示的字段明确报错。
- Codex 通道不接受显式 `max_output_tokens`（包括其他协议转换来的输出预算）、`previous_response_id`、服务端 conversation、`store=true` 和当前未适配的采样参数。多轮携带完整历史。上下文来自账号在线模型目录，未知最大输出不编造。
- Fast 映射到 `service_tier: priority`，与 reasoning effort 独立。请求记录分别保存请求档位与实际档位。应以上游回显的实际档位为准，不能仅凭请求成功认定 Fast 已生效。
- 图像生成和编辑走 `/v1/images/generations` 与 `/v1/images/edits`，使用同一把 ChatGPT 登录，但请求发到 `https://chatgpt.com/backend-api/codex/images/generations` 和 `/images/edits`。公开的 `api.openai.com` 图像接口会拒绝这把套餐令牌。若返回 `hardened_oauth_rule_missing` 或 `no_matching_rule`，且本机 `~/.codex/auth.json` 的邮箱与 Daylight 登录相同，则只读取其中的访问令牌和账号号再请求一次，不读取或保存里面的 API Key，也不改写这个文件。已转发 `gpt-image-2.5-flare`、`gpt-image-2.5-sunburst` 及各自的 `2026-09-08` 快照、`chatgpt-image-latest`、`gpt-image-2` 及其 `2026-04-21` 快照、`gpt-image-1.5`、`gpt-image-1-mini`。没有 `gpt-image-2.5` 这个裸 id，也不转发已关闭的 `gpt-image-1`。文本请求仍走 `api.openai.com/v1/responses`，并继续拒绝托管工具 `image_generation`。这些图像模型不进入聊天目录。

## 自定义来源

自定义标签支持多个上游，填写 Base URL、Key、上游协议与模型映射，保存后共用现有出口和 Key。默认在 URL 后追加 chat/completions、responses 或 messages；高级设置可指定相对端点、自定义请求头及模型容量/默认参数元数据。模型可发现或手填；同名模型汇集来源，通过模型路由管理，也可设置别名分别调用。每个上游支持多个 Key，分别发现模型权限；成功重新获取后覆盖目录。测试按钮会调用第一个启用模型并产生正常上游用量。

自定义 Key 和额外请求头存入 macOS Keychain，由随 App 打包的凭据助手读写，不写入来源 JSON、不通过命令行参数传递。页面留空保留原密钥。相同协议保留调用方字段与原生响应；已确认支持的 Messages 通道在调用方未指定策略时补齐缓存控制，规则见下文。跨协议支持文本、图片和 function 工具的基本映射，拒绝不透明 reasoning、原生缓存控制、内置工具等无法无损转换的请求。Token 用量仅记录上游实际提供的字段，未知费用与缓存写入不伪造为零。

## Kimi Code

Kimi 标签直接使用官方设备 OAuth 端点。点击网页登录，在 Kimi 官方网页输入授权码；Daylight 按返回间隔轮询并处理等待、减速、拒绝、过期和取消，自动续期独立保存的凭据。无需本机 Kimi Code，不启动本地授权服务、不读取或修改 `~/.kimi-code`。推理和模型、额度仍直接访问 Coding API。设备 ID 保存在 Daylight 数据目录，令牌保存在 Keychain。

模型列表读取真实上游目录，页面优先显示展示名称，并保留接口 ID。2026-10-01 的实测中，`kimi-for-coding` 对应 K2.8 Preview，另有 K2.7 Code Highspeed、K3、K3-256k；名称和可用性由上游更新。所有模型进入统一模型路由，原有自定义配置保留。

OAuth 与 API Key 的 `kimi-for-coding` 请求均在传入 `temperature: 0.7` 时返回 400；OAuth 的 `k3`、`k3-256k` 和 Highspeed 也有相同限制，省略时均成功。这四个官方模型会省略客户端传入的 `temperature`，使用上游默认值。规则同时适用于自定义来源中精确配置为 `https://api.kimi.com/coding/v1` 的通道，不应用于其他模型或第三方中转。最近请求记录原始值及“已省略”，其余参数遵循原生转发或现有有限协议转换。

K2.8 Preview 和 K3 已分别验证普通请求及 function 工具调用，K2.8 Preview 已验证流式输出。真实工具多轮回传、不同客户端的完整编码会话及全协议兼容仍需按实际使用核验。官方授权参考：[登录流程](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html#kimi-login)、[本机授权服务 API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html)。

Kimi 与 Qoder、Codex、Grok、AGY、Copilot 使用同一 `public/proxy/source-page.js` 来源页面，模型与额度分别复用 `model-list.js` 和 `quota-panel.js`。网页登录是公共账号栏中的来源专属操作。官方目录的 reasoning.effort.valid / think_efforts.valid_efforts 提供支持档位，按目录展示默认推理强度；客户端传入的 reasoning_effort 或跨协议 reasoning.effort 优先于中转默认值。Highspeed 未声明档位时不提供默认强度设置。Pi 同步使用同一目录，only thinking 模型的关闭档位为不支持。

## GitHub Copilot

Copilot 使用 GitHub 账号独立网页登录，无需安装、运行或读取本机 Copilot CLI。点击“网页登录”，打开 GitHub 官方链接并输入页面显示的用户码；Daylight 按 GitHub 返回的间隔轮询，处理等待、减速、拒绝、过期和取消。授权完成后自动读取模型目录，账号栏显示 GitHub 用户名。GitHub OAuth 凭据仅存入现有 macOS Keychain，短期 Copilot token 在内存缓存，过期前换取新 token；401 最多刷新重试一次，账号变化时不重放请求。退出账号删除 Daylight 保存的凭据。

模型、容量、视觉和工具能力读取上游目录，不按模型名称猜测；按模型声明选择 Chat Completions、Responses 或 Anthropic Messages 上游端点。客户端仍共用三个现有协议入口、模型路由、流式与工具转换、请求诊断及公共模型/额度组件。额度读取 Copilot 上游请求配额，缺失值保持未知，不以 token 数估算 Premium 请求或费用。Pi 接入复用现有全量同步、备份、恢复与默认值保护。建议使用 Responses 或 Chat Completions；选择 Pi Messages 时，仅原生声明 Messages 的模型可接入，以保留手动 thinking 预算、签名和缓存字段。Pi Messages 的 Base URL 使用服务根地址，避免 SDK 重复追加 `/v1`。AI 管理支持 `sourceId: copilot` 的登录/取消/退出、目录和模型设置；`daylight_get_configuration` 使用 `copilot.quota` 查询额度，写操作仍通过审阅草稿。

协议调研参考 [copilot-api](https://github.com/ericc-ch/copilot-api/tree/0ea08febdd7e3e055b03dd298bf57e669500b5c1/src)（MIT）及 [GitHub device flow 文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)。Copilot token、目录及推理路径属于上游非公开兼容接口，实际账号的订阅和组织策略仍决定可用性。当前实现支持 github.com 账号；自建 GitHub Enterprise Server 登录域未接入。

## 提示缓存与自适应时长

缓存由上游建立和读取，Daylight 不在本地缓存模型回答。转换为 Anthropic Messages 时，公共转换层默认添加 5 分钟缓存断点，最多覆盖工具定义末尾、系统提示末尾和最后两条消息的可缓存块。断点表示截至该位置的整个前缀；正文、工具定义、思考配置或上游身份变化仍可能导致未命中。

Copilot Messages 和直接连接 `https://api.anthropic.com` 的自定义 Messages 来源启用自适应时长。原生 Messages 未指定缓存策略时也参与；未知兼容网关继续使用原有默认策略。Chat / Responses 使用上游隐式缓存，不套用 Anthropic 的 TTL。

| 同一会话及稳定前缀的复用情况 | 自动选择 |
| --- | --- |
| 未携带会话标识，或该标识首次出现 | 5 分钟；无标识时不保存学习记录 |
| 已有该会话记录，本次与上次请求时间戳相差超过 5 分钟 | 1 小时，不设间隔上限 |
| 已选 1 小时，连续 3 次新的用户输入间隔均不超过 5 分钟 | 回到 5 分钟 |

间隔按被上游 HTTP 成功接受的请求发起时间计算，包含模型生成时间。纯工具结果和重试不作为新的用户输入，不会单独触发降级。策略只随正常请求判断，不发送保活请求。第一次未知长停顿前只有 5 分钟缓存时，过期无法事后挽回；这次停顿用于选择后续的 1 小时缓存。它是命中与写入成本之间的启发式策略，不保证每次命中或全局最低费用。

会话标识优先取 `X-Daylight-Conversation-Id`，其次取请求正文的 `prompt_cache_key`。前者是 Daylight 自定义请求头，由调用方为每段对话设置稳定值，不是账号 ID 或认证凭据；普通客户端不会自动携带。`prompt_cache_key` 可作为备用关联值，但只有调用方按会话独立、稳定地生成时才能可靠关联。两者都没有时默认 5 分钟，不按内容推断会话，不保存匿名学习记录。

本机 Pi 1.4.0 的 Responses 发送器默认将自身会话 ID 放入 `prompt_cache_key`，因此不必额外配置 Daylight 请求头；关闭 Pi 缓存时该字段可能不再发送。这是已核对客户端实现及合成请求的行为，不是所有客户端或历史代理流量的覆盖率统计。

账号、来源、Key 和模型分别隔离，同一范围内按稳定标识保存上次时间戳。系统提示或工具定义改变不会把有标识的会话变成新会话，但实际缓存前缀仍可能因此失效。路由到其他来源不会继承原来源的学习结果。

调用方在原生 Messages 中指定的 `cache_control` 始终优先，包括混合 5 分钟与 1 小时策略。Chat 与 Responses 互转时保留 `prompt_cache_key`、`prompt_cache_retention`，但仍受各来源参数限制；OpenAI 的保留时长不能换算为 Messages TTL，显式跨协议转换会报错。缓存 key 转为 Messages 时不透传为未知字段。

自动选择的 `1h` 若收到明确的 TTL 不支持错误，系统仅重试一次 5 分钟策略，并为该学习条目暂停 1 小时策略 24 小时。时间从拒绝发生时计算，不随之后的正常请求延长。调用方显式策略不会被自动改写；其他错误沿用现有来源处理。

学习数据保存在数据目录的 `copilot-proxy/prompt-cache.json` 和 `custom-proxy/prompt-cache.json`，仅包含有标识会话的哈希、时间、当前 TTL、连续短交互数及必要的禁用截止时间。每份最多 1000 条，超限淘汰最久未使用的条目；不按会话年龄删除，保留老会话的上次时间戳。不保存提示词、回答、原始会话 ID 或凭据。被淘汰的会话因缺少上次时间戳，会按首次请求处理。删除学习文件后重启对应服务，可以重新学习；文件损坏或写入失败不阻断推理，但本次进程可能只在内存中学习。旧的内容推断学习格式只重置派生记录，不迁移到当前按 ID 关联的格式。

`GET /api/proxy/requests` 的 `promptCacheTtl`、`promptCacheReason` 表示本次请求采用的策略与原因，`caller` 表示保留调用方策略。是否实际命中仍以 `usage.cacheReadTokens` 为准，策略选择不是缓存成功的证明。

2026-10-28 的真实 Copilot 试验未显式指定 TTL：首个请求写入 5 分钟缓存，静置 306 秒后自动改用 1 小时；再次静置 315 秒，读取缓存 13,097 Token，重新写入为 0。记录见[自适应实测](verification/proxy-cache/2026-10-28-adaptive.json)。该记录证明当前账号、模型与前缀的这条路径，不代表所有兼容上游或实际账单节省比例。

同日最终安装版通过真实代理完成有 ID／无 ID 对照。有 ID 会话先用 `prompt_cache_key` 接入，静置 358 秒后以同值请求头接续，自动写入 13,112 Token 的 1 小时缓存；再次静置 325 秒后切回正文 key，读取 13,112 Token、重新写入为 0。期间修改系统提示，没有重置会话时间戳。无 ID 对照三轮均为 `5m / no-session-id`，只写入 5 分钟缓存，没有 1 小时写入。六次请求全部成功，未发送保活或显式指定 TTL，详见[安装版对照记录](verification/proxy-cache/2026-10-28-adaptive-installed.json)。

## 模型路由与统一控件

自定义编辑和模型路由调整共用浅绿色右侧抽屉；打开 220ms、关闭 160ms，系统减少动态效果时禁用动画。标题和操作区固定，内容独立滚动；未保存关闭会提示，保存失败保留内容。

模型路由的“全部模型”和“多个来源”仅显示已启用模型。启用状态与连接可用性分别记录；连接失败的已启用模型保留在列表中，显示失败标记与“重试”，重试仅检测该模型的失败来源，保留可用备用来源。

模型控件统一显示上下文、最大输出、上游默认和支持的推理强度。上下文提供不超过模型最高容量的 256k、353k、500k、1000k，默认选最高值；实际最高值不在预设内时也保留。最大输出使用独立输出档位，按真实输出上限筛选。未知上限显示“上游未提供”。支持 Fast 才显示同一个 Fast 开关，Codex 对应 priority，Qoder 对应原生 Fast；Grok 的独立 Fast 模型保持独立。

上下文和最大输出选择保存的是有效客户端模型容量，Pi 一键配置从同一份目录读取。原始能力上限另行保留，降低选择后仍可恢复最高值。页面没有独立的请求输出预算输入框，客户端显式请求参数继续沿用已有协议规则。Custom 控件保存在编辑草稿中，保存整个来源后才生效，逐 Key 模型权限不互相复制。

模型参考目录每 24 小时检查更新，可在页面主动刷新；在线同名条目优先于本地补充，失败时保留最近有效缓存。Grok 的隐式缓存建立计入普通输入：参考价表未单列缓存写入价时，Pi 的 `cacheWrite` 按对应基础档或长上下文档的输入单价映射。其他模型的未知价格保持为空，不按零计费；订阅渠道明确显示参考估算。

Pi 按来源同步：目录正常的来源继续更新模型、容量和参考价表；目录失败的来源保留原有模型及配置，标记“暂不可用 · 已保留”，恢复后重新参与正常同步。`cli/pi-sync.json` 保存每个模型的来源集合；旧配置没有来源记录时，在部分来源失败期间保守保留归属未知的模型。保留模型不会清除当前默认值、个性化设置或私有请求头，也不会将私有请求头输出到页面/AI 预览。其他 providers、Pi 登录文件及默认思考设置不变。存在保留模型时，禁止更换全局协议、地址或 Key，避免原配置失效。写入仍使用版本校验、外部修改保护、自动备份和恢复。

## 来源状态与请求诊断

`GET /api/proxy/sources` 区分目录检查与已观察的生成、流式、工具调用。成功记录只证明已观察结果，不能保证所有模型和协议能力相同。切换本机账号后需刷新登录；来源标识或配置改变后，旧记录不作为当前配置的验证证据。

`GET /api/proxy/requests` 统一查询原生转发和协议转换，按来源、模型与结果筛选，包含阶段耗时、实际 HTTP 状态、上游模型与已返回用量。记录沿用 `qoder/usage.json`，保留最近 1000 条并兼容历史格式；只保存诊断元数据，不保存提示词、响应正文、工具参数或凭据。状态与记录查询不触发上游探测或推理。并行工具历史的 502 根因与回归记录见 [中转架构](proxy-architecture.md#问题记录并行工具历史导致-qoder-502)。

## 被动生成速度

模型列表随实际代理请求自动积累生成速度，无需发起测速请求。思考、正文和工具参数合并统计；每组显示最近至多 20 次有效请求的 TPS 中位数和样本数，悬停可查看各组参数、最近一次速度和更新时间。自定义来源的已保存列表和编辑抽屉使用同一展示。来源轮询每 3 秒更新速度，只更新文字，不重建模型控件或打断编辑焦点。

可见流按首个内容分片到最后内容分片的时间计算，排除首次输出前的等待、结束后的 usage/落盘等待及心跳。首个网络分片可能包含多个 token，因此按其文字权重占比扣除对应 token 的估计数；SSE 分片数不作为 token 数。它是代理端观测的输出速度，不能还原上游每个 token 的精确生成时刻。上游报告隐藏思考 token，或只返回非流式 JSON 时，改用本次实际上游请求开始到生成完成的窗口，包含首次输出前的等待，页面标记“含首包等待”；两种计时口径分别聚合。

最终真实输出用量优先，包含上游计入的思考 token，不对中文真实用量额外乘系数。缺失或只有过期的中途用量时，按可见思考、正文和工具参数估算，复用已有中文/混合文本估算与模型校准系数，显示“估算”；已知存在隐藏思考而缺少最终真实用量时不计算。估算只保存在独立的 `generationSpeed` 测量字段中，不补入真实 `usage`，也不用于费用计算。

至少 20 个输出 token、计时窗口至少 250ms 的成功完成/正常预算截断请求才纳入统计。失败、取消、超时、手动推理检查以及单分片缓冲返回的流式响应不纳入。统计按实际来源、当前来源配置/账号代次、来源模型及实际上游模型、思考强度、服务档位、计数可信度和计时口径分组，回退前的用量和计时不会带入最终来源。数据沿用最近 1000 条请求记录保存，重启后保留；旧记录缺少测量字段时等待新的实际请求。`GET /api/proxy/sources` 的各来源 `performance` 返回这些聚合结果，不触发生成。


## 流式 token 计数与 Pi

Chat Completions 和 Responses 的正文、可见推理及工具参数增量附带累计 `usage`。上游尚未提供真实输出计数时，Daylight 按可见输出估算（拉丁文本约 4 个 UTF-8 字节/token，中日韩字符约 1 字/token），标记 `usage.estimated: true`；收到真实计数后从该快照继续累计。估算无法覆盖隐藏推理、图片或完整提示词，不代表计费数据。Responses 增量上的 `usage` 是 Daylight 扩展字段，客户端需要显式读取。

最终完成/截断事件继续保留上游真实 usage，允许校准为更小值；上游未提供时保持缺失。非流式响应和请求记录只使用上游实际用量。Messages 暂不添加输出估算，但协议转换会即时传递已经收到的真实 usage 给内部转换层。

每次正常完成且提供真实输出用量的流式请求，会用“真实输出 token / 原始可见输出估算”学习下一次请求的系数。系数按来源、实际上游模型、客户端/上游协议和思考档位隔离，保存在数据目录 `proxy/token-estimates.json`，重启后继续使用。首个可靠样本建立系数，之后以 20% 新样本权重平滑更新；一次请求使用固定系数，中间真实 usage 不乘系数。只保存聚合系数、样本数和更新时间，不保存正文或提示词。

转换到 Chat Completions 的上游请求会显式携带 `stream_options.include_usage: true`，Kimi 原生流式请求也默认请求该字段，确保上游可在结束时提供学习所需的计数；Kimi 原生请求显式指定 `false` 时保留客户端选择。

不足 40 token 的样本、比例超出 0.25–4 倍的异常样本、失败/取消/截断、缺失最终计数及仅有上游估算的请求不参与学习。上游声明隐藏推理用量而流中未见推理文本或仅提供思考摘要时也跳过，避免把隐藏思考预算误当作正文分词差异。原生 Messages 也可提供学习样本，但不改变其输出协议或添加估算 usage。不同语言、工具密度和思考内容仍会造成误差，学习目标是降低同类请求的系统偏差，不能保证每条请求都更准。Pi 的代理 usage 已应用校准，`tps-cjk` 直接读取该值，避免再乘本地系数。

`useProviderTokens` 是 `pi-token-speed` 的设置，不是通用 API 参数。Pi 1.4 的 Responses 适配器只在终止事件读取 usage，需要加载仓库内的 `integrations/pi/daylight-streaming-usage.js` 扩展，将中间 usage 写入 Pi 的实时消息。该扩展仅作用于 `daylight` provider 的 `openai-responses`，不替换 Pi 适配器或更改模型协议；Pi 自带逻辑处理最终真实计数。可复制到 `~/.pi/agent/extensions/daylight-streaming-usage.js`，在 `tokenSpeed.providerOverrides.daylight` 中设置 `useProviderTokens: true`，然后在 Pi 中执行 `/reload`。Chat Completions 适配器可直接读取每个增量上的 usage。

验证本机 Pi 适配器和 agent 事件链路（合成流，不发真实请求、不修改个人配置）：

```sh
node scripts/check-streaming-usage-pi.mjs /path/to/node_modules/@earendil-works/pi-coding-agent
```

## 公共管理入口

页面统一使用 `/api/proxy/status`、`/service`、`/settings`、`/key`、`/check`；来源操作位于 `/api/proxy/sources/{id}/status`、`/models`、`/models/setting`、`/quota`、`/auth/{operation}`、`/check`。来源 ID 按 URL 编码。来源检查 POST body 使用 `kind: catalog` 或 `kind: inference`，后者才发实际生成请求。支持的认证操作、模型设置字段和原生协议由来源描述返回。

自定义配置在 `/api/proxy/custom/sources` 及 `/sources/save`、`/sources/delete`、`/sources/discover`、`/sources/key` 管理，推理检查在 `/api/proxy/custom/test`；路由保持 `/api/proxy/routes`。以上接口都需要工作台管理凭据，旧来源管理路径继续兼容。

公共参数模块只统一可复用规则。上游是否接受输出预算、采样参数、Fast 或某个推理档位仍由来源能力和原生协议决定；未知能力不会被补成相同默认值。额度页面明确显示单位和未知值，刷新失败保留上一份有效数据。

## 独立认证参考与验证

认证参考：[Kimi Code 官方 OAuth 实现](https://github.com/MoonshotAI/kimi-code/tree/ef727e517923cb312cb48d42825c49dfacd528e7/packages/oauth)、[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)、[ChatGPT 开源接入](https://developers.openai.com/siwc/token-sharing-open-source)。这次没有引入这些项目作为运行时依赖。

`test/standalone-accounts.test.mjs` 使用隔离凭据和模拟上游验证登录、续期、取消、退出、回调校验及账号隔离；`scripts/check-standalone-pi.mjs` 使用本机 Pi 验证 Kimi、Grok、Codex、AGY 四个独立来源的工具调用和多轮回传。模拟验证不代表真实账号已完成授权或推理。

AGY 独立 OAuth 的端点、scope、回调和项目发现参考 [CLIProxyAPI 固定版本源码](https://github.com/router-for-me/CLIProxyAPI/tree/355fd10e76b82e03ba6625acc583b900286e4bf2/internal/auth/antigravity)。AGY 授权、续期、退出的边界回归使用隔离凭据和模拟上游。2026-10-16 用户完成独立登录后，真实 `gemini-3.8-flash` 和 `claude-opus-4-6-thinking` 均通过 Messages 文本推理，以及本机 Pi 1.2.0 `ModelRuntime` 的 Responses 工具调用、结果回传与续接；6 条请求均确认来自 AGY，HTTP 200 且完整结束。20 个受保护配置文件和已有登录记录核对未变。具体范围和摘要见 [真实验证记录](proxy-architecture.md#agy-独立登录后的真实验证)。

## 使用统计

「反向代理 → 使用统计」提供请求次数、真实 Token、按输入 Token 加权的缓存命中率和请求成功率，支持日期、来源、模型筛选，以及每日趋势与分布联动。手动测试不计入；取消、超时、失败及未知状态分别计数，成功率排除取消和未知状态。Token 缺失或估算不补为零，页面显示真实用量覆盖率；缓存属于输入、思考属于输出，细分项不重复累加。

按日、实际来源和来源模型聚合的数字保存在数据目录的 `qoder/usage-history.json`，永久保留，不保存提示词、输出正文或新增的逐条请求明细。现有短期诊断记录继续供 TPS 和调用频次排序使用。首次启用只回填当前仍保留的记录，并显示持续统计起点；早期缺失数据无法恢复。每次可查询最多 366 天，永久保存不受查询范围限制。统计时区在首次创建时固定，后续按相同时区归属日期。统计写入合并为约 3 秒一次的原子写；正常停止代理、退出进程（含 SIGTERM）会立即落盘，强杀进程最多丢失最近几秒，重启时由保留的最近 1,000 条记录补回，不会重复计数。

统计页每 30 秒在可见且没有操作内部控件时刷新；切页、隐藏窗口和销毁页面会取消请求。历史统计读取失败会保留原文件并显示错误，不妨碍现有代理请求记录继续使用。

Token 数值统一使用 M（百万）和 B（十亿），达到 1,000,000,000 Token 使用 B；指标卡悬停可查看精确总 Token。模型分布按来源目录的明确别名合并历史 ID，例如 Qoder 的 `dfmodel` 与 `deepseek-flash`；其他来源的同名模型不会因字符串相同而被误合并。

“官方 API 参考折算（USD）”按当前参考目录收录的官方 API 公开单价统一折算已知历史用量，价格更新后参考金额会变化，不代表订阅、账号的实际扣费。参考价来自已关联的公开 API 价表，不采用手动或上游账号价格。缓存读取与单列的缓存写入从普通输入中扣除后分别计价，思考已包含在输出中。未单列的缓存写入按普通输入价折算；计费字段或价格缺失的部分不计入，显示可折算请求数与价格来源，未知部分不视为免费；不可计价的请求不影响同一天其他可计价请求。

### 长上下文分档

价表的 `pricing_tiers` 用 `input_tokens_gt` / `input_tokens_lte` 表示档位：输入长度 > 下限且 ≤ 上限（无上限为开放）时适用，价表备注均为“整个请求按该档计费”。输入长度按价表口径取整次请求的输入总量，即普通输入 + 缓存读取 + 缓存写入；输出（含思考）不计入长度。所选档位对该请求的输入、缓存读取、缓存写入和输出统一计价。价表没有结构化字段表达“仅超出部分加价”，因此默认整次请求按所选档计价；档位之间有空档或超过最后一个有上限档位的请求视为不可计价，不猜测价格。阈值与单价始终取自当前参考目录，没有硬编码。

新请求在 `qoder/usage-history.json` 的每个日/来源/模型汇总下追加有界的 `tiers` 输入长度直方图（固定刻度加上价表阈值；每个区间只存请求数、输入/缓存读/缓存写/输出 Token 和实际出现的最小/最大输入长度，不含正文）。价表刷新后仍按当前阈值重算：区间被阈值切开时才会产生范围。启动时用仍保留的 `qoder/usage.json` 明细回填尚无直方图的已计入请求，`tieredIds` 保证重复启动、崩溃重放不会重复统计，也不改变原有汇总数字。

无法还原逐请求输入长度的旧汇总（明细已超出保留窗口）只知道请求数和 Token 合计：按请求数与输入总量推出可能出现的全部档位，对输入、缓存读、缓存写、输出四个分量分别取这些档位中的最低/最高单价，给出“≈ 下限 – 上限”。各分量单价升降方向不一致时范围仍然成立，但可能比真实值宽；它是估算，不是精确值，页面和提示会标明估算的请求数。
