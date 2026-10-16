# 中转架构

本文描述当前工作区的实现，使用说明见 [反向代理](reverse-proxy.md)，通用开发约定见 [开发说明](development.md)。原 Grok 接入方案与中转统一计划已完成，其有效职责、兼容约定和问题记录归入本文与使用说明，不再保留实施前的目录和步骤。

## 模块边界与调用关系

| 层 | 职责 |
| --- | --- |
| 公共服务 | 组装来源、服务生命周期、鉴权、路由、管理操作与响应输出 |
| 来源适配 | 本来源认证、模型和额度解析、上游参数、请求与响应适配 |
| 前端 | 公共服务栏、来源账号、共享模型/额度组件、自定义配置草稿 |

推理：客户端 → `gateway.js` → `shared/router.js` → 来源 `execute()` → 上游 → `shared/relay.js` → 客户端。`shared/request-records.js` 记录各阶段的诊断元数据。

管理：页面 → `/api/proxy` → `management.js` → 来源注册表与管理操作。Pi 和 AI 管理工具复用相同模型目录和管理操作；AI 写入仍经过草稿审阅、版本保护和请求去重。

公共服务通过来源公开接口访问适配器；来源依赖 `shared/`，`shared/` 不导入来源目录。`ai/adapters/qoder.mjs` 是 AI 对话的 CLI/SDK 适配，与 `proxy/qoder/` 的模型 API 中转独立。

## 公共后端文件

以下路径均相对 `proxy/`。

| 文件 | 功能 |
| --- | --- |
| `sidecar.mjs` | 原生 App 的 Node 侧车入口、工作台管理鉴权、父进程退出清理 |
| `service.js` | 创建并连接各组件、监听端口、启动/停止、活动请求统计、资源关闭 |
| `gateway.js` | `/v1` 客户端鉴权、推理校验、模型路由、输出前回退、取消与请求记录 |
| `management.js` | 公共管理操作、HTTP 路由、旧管理路径兼容；AI 工具直接调用操作，不伪造 HTTP 对象 |
| `providers.js` | 内置与自定义来源注册、公开描述、动态自定义实例增删；生产及注入来源统一通过 `execute` 执行 |

### shared 公共机制

| 文件/目录 | 功能 |
| --- | --- |
| `contracts.js` | 来源快照、模型可设置字段及值校验、执行结果契约、诊断错误分类 |
| `router.js` | 聚合目录、别名、主备顺序、排除来源、冷却与来源级会话绑定 |
| `source-state.js` | 根据公开快照、目录检查和真实请求记录生成来源状态与已观察能力 |
| `request-records.js` | 一次客户端请求一条记录，包含路由尝试、阶段耗时、状态和真实用量 |
| `protocol.js` | 跨协议请求转换、原生响应观察、不可表示字段检查 |
| `protocols/` | Chat、Responses、Messages 请求解码、响应编码、模型列表与协议参数 |
| `llm/` | 规范消息、SSE、Chat 流解析、工具参数累积、响应组装、usage、模型 ID 解析 |
| `relay.js` | 原生 HTTP 或标准事件输出、JSON/SSE、背压、终态、取消与空闲超时 |
| `request-parameters.js` | 输出预算/强度读取与校验、别名冲突、已确认的 Kimi temperature 兼容规则 |
| `model-settings.js` | 默认模型设置和容量校验、能力上限保留、串行原子保存，适配原有 JSON 布局 |
| `catalog-cache.js` | 上游目录 TTL、并发去重、账号隔离、失效代次 |
| `account-catalog.js` | 账号变化时统一使目录/额度缓存失效，过滤旧账号迟到的检查结果 |
| `oauth-account.js` | 独立账号凭据、并发续期、设备授权、取消/退出及写入隔离 |
| `loopback-account.js` | AGY/Codex 共用本机回调、state 校验、过期、单次交换及资源关闭 |
| `oidc.js` | OIDC 签名、issuer、audience、nonce 与账号身份验证 |
| `quota.js` | 额度公共格式、数值与单位规范化，保留缺失值 |
| `store.js` | JSON 读取、原子写入与串行操作 |
| `secrets.js` | 自定义 Key、敏感额外请求头与独立账号凭据的 Keychain 存取 |
| `tools.js` | AI state/prepare/apply 等操作、读取来源能力的审阅草稿、配置版本与操作回执 |
| `utils.js` | 少量基础工具 |

来源缓存保存上游目录；router 缓存保存聚合目录与路由，两者责任不同。保存模型默认值只重算有效目录，不触发无关来源的远程发现。请求显式值优先于已保存默认值，再由上游使用缺省值；公共机制不强加全局采样、思考或输出预算默认值。

## 来源目录与文件职责

每个来源都有 `provider.js` 和 `models.js`；需要解析额度的来源有 `quota.js`；独立账号流程放在 `auth.js`。只有存在专属协议编解码时才增加 `protocol.js`，文件数量按实际职责决定。

| 来源 | 文件 | 功能 |
| --- | --- | --- |
| Qoder | `provider.js` | 组合认证、目录、请求与流，处理 Qoder 排队和重试 |
| Qoder | `auth.js` | 账号存储、PKCE 授权、轮询、取消/退出、令牌刷新、组织信息 |
| Qoder | `transport.js` | COSY 身份、签名、专属请求头与 HTTP；签名绑定实际发送路径与正文 |
| Qoder | `body-codec.js` | 上游请求正文编码；测试用反向解码位于 `fixtures/qoder/wire.mjs` |
| Qoder | `protocol.js` | 请求封装、session/request-set/business 字段、工具续接阶段 |
| Qoder | `stream.js` | 拆开上游 SSE 包装后交给共享 Chat 流解析器 |
| Qoder | `models.js` | Qoder 目录、CLI 模型配置、原生上下文档位、专属设置和排队规则 |
| Qoder | `quota.js` | Credits、团队包、按账号隔离的额度快照历史 |
| AGY | `provider.js` | 认证、目录缓存、有效设置与上游执行编排 |
| AGY | `auth.js` | 独立 Google OAuth、Keychain、静默续期及旧登录只读导入 |
| AGY | `oauth-client.js` | 读取本机 OAuth 客户端配置，校验登录方式与必需字段 |
| AGY | `protocol.js` | 生成请求、思考配置、图片、工具、响应与签名适配 |
| AGY | `models.js` | CLI 别名与上游能力合并、Gemini 思考档位归并 |
| AGY | `quota.js` | 共享额度分组与周期解析 |
| Grok | `provider.js` | 目录/额度缓存、设置、上游执行与输出策略 |
| Grok | `auth.js` | 独立 OIDC 设备授权、Keychain、自动续期和身份隔离 |
| Grok | `protocol.js` | Responses 请求/事件、搜索、引用、不透明 reasoning、原生响应组装 |
| Grok | `models.js` | Responses 目录、容量、推理与搜索能力 |
| Grok | `quota.js` | billing 订阅周期、百分比与未知额度解析 |
| Codex | `provider.js` | 目录、设置、参数约束、原生 Responses 与 401 刷新重试 |
| Codex | `auth.js` | 独立 ChatGPT OAuth、loopback + PKCE、签名校验与 Keychain |
| Codex | `models.js` | 账号在线 models 目录、上游明确返回的容量与思考/速度能力 |
| Codex | `auth.js` 的 `quota()` | 独立接口尚无额度 API，返回明确未知状态 |
| Kimi | `provider.js` | 目录、额度、设置、Chat 执行和 401 刷新重试 |
| Kimi | `auth.js` | 独立设备 OAuth、Keychain、轮询/取消/续期和稳定设备 ID |
| Kimi | `models.js` | 官方容量、thinking 类型、推理档位与模型能力 |
| Kimi | `quota.js` | usages 的订阅、周期限额与未知单位 |
| Copilot | `auth.js` | 独立 GitHub device flow、Keychain、短期 Copilot token 与安全端点校验 |
| Copilot | `provider.js` | 目录缓存、模型设置、按声明分流 Chat/Responses/Messages、401 单次重试与账号隔离 |
| Copilot | `models.js` / `quota.js` | 上游能力与请求配额，保留未知值 |
| Custom | `sources.js` | 来源和逐 Key 配置、发现、校验、保存/删除、配置版本、Keychain 调用 |
| Custom | `provider.js` | 单来源执行实例、映射、逐 Key 权限、冷却/回退/亲和性、协议转换 |
| Custom | `models.js` | 目录解析、模型校验、逐 Key 权限与容量的保守合并 |

Qoder 8 文件、AGY 6、Grok 5、Kimi/Copilot 各 4、Codex/Custom 各 3。Qoder 多出的签名传输、正文编码和 SSE 拆包对应真实协议边界。Codex/Kimi 的短原生请求适配使用共享转换，不另造薄封装；Custom 凭据由 sources 管理，不增加空 auth/quota 文件。Codex 已移除原 app-server RPC 额度解析器及专属测试，当前独立接口通过 `auth.quota()` 明确返回未知额度；推理和 401 重试直接使用同一 `auth.read()`。

来源级回退由 router 负责，Custom 内部 Key 回退由 provider 负责。模型设置不能自动把某个 Key 的权限复制给其他 Key。

## 来源接口与执行结果

| 入口 | 实际契约 |
| --- | --- |
| `snapshot()` | 返回已知身份/配置代次、认证描述、目录时间和管理能力，不触发远程发现或返回凭据 |
| `listModels(refresh)` | 返回规范化目录；refresh 为布尔值，Custom 配置目录不等同远程验证 |
| `setModel({id,field,value})` | 内置来源保存支持字段并返回有效目录；Custom 通过 sources 草稿保存，不支持即时设置时明确报错 |
| `execute(input, context)` | 发起推理，不访问客户端 HTTP response |
| `close()` | 清理来源拥有的资源 |
| `quota()`、认证操作 | 按来源声明提供，不支持的操作在页面隐藏、接口拒绝 |

execute 输入为 `{raw,protocol,model,conversationId,stateful}`，context 携带 `signal/observe`。原始请求字段保留供原生适配器使用；事件适配器通过 shared 协议解码。

注入测试来源也必须提供 `execute`，返回原生 response 或标准 events，不再由注册表猜测 `forward/stream`。事件测试复用 `fixtures/proxy/provider.mjs` 的 `eventExecution`；各来源内部仍可保留专属 `forward` 或 `stream` 实现。模型选择、冷却和会话绑定由 router 管理，实际执行及输出前回退由 gateway 管理；已删除仅被旧测试调用的 `ModelRouter.stream` 和 `relay(provider)`，相应测试改走 HTTP 网关、来源 `execute` 或 `relayResult`。

- `{kind:'response', response, protocol, ...}`：保留原生 HTTP/JSON/SSE、不透明字段与 usage。
- `{kind:'events', events, renderers?, ...}`：共享 text/reasoning/tool_call/usage/finish/error 事件。Grok 可携带原生渲染策略，公共层按结果类型选择输出。

注册表描述认证方式与可用操作；模型目录描述参数能力；source-state 根据请求记录提供 generation/streaming/toolCall 观察时间。目录检查成功不等于推理、工具或 Fast 实际生效；实际档位以上游回显为准。

## 前端文件

`public/proxy/` 保存浏览器页面模块；`proxy/` 保存服务端中转。两者通过管理 API 连接。来源共用同一套布局和样式，Custom 使用相同模型控件但保留完整草稿保存事务。

| 文件 | 功能 |
| --- | --- |
| `public/proxy.js` | 页面、来源标签、模型路由标签与可见性/销毁组装 |
| `public/proxy/api.js` | 工作台鉴权、HTTP/JSON、超时、错误、URL 编码 |
| `public/proxy/state.js` | 一份公共状态、按来源缓存资源、请求去重、失效代次、授权状态与轮询 |
| `public/proxy/service-panel.js` | 公共开关、地址/Key、协议示例、端口/自动启动/Node 配置、停止确认 |
| `public/proxy/source-page.js` | 认证描述驱动账号栏、授权操作、来源状态、挂载模型和额度 |
| `public/proxy/model-list.js` | 模型分组、启停、容量、推理强度、Fast；即时保存与草稿模式共用 |
| `public/proxy/model-options.js` | 容量档位、最高值过滤、Fast 映射的纯函数 |
| `public/proxy/quota-panel.js` | 公共额度卡、单位/周期/时间、未知/过期状态、可选趋势 |
| `public/proxy/custom-sources.js` | 多来源与逐 Key 编辑、发现、未保存保护、保存/删除事务 |
| `public/model-routes.js` | 主备顺序、排除与重试，使用相同 API 客户端 |
| `public/proxy.css` | 中转公共样式；复用 design-system 与 button/select/section |
| `public/components/proxy-drawer.js` | 抽屉、确认、脏状态与焦点恢复 |

公共状态使用一份轮询器，隐藏暂停、恢复刷新。模型首次展开或显式刷新时获取，额度展开后获取并按周期更新；同资源去重，不同来源互不阻塞。来源身份/配置改变后旧响应不能覆盖新状态；失败保留有效数据和编辑输入。

### 模型容量与额度

模型统一展示名称、启用、上下文、最大输出、上游默认和支持的推理强度。支持 Fast 才显示开关：Qoder 使用原生 fast，Codex 映射 priority；Grok 上游独立 Fast 模型保持独立模型。

上下文预设为 256000、353000、500000、1000000，只显示不超过真实上限的值，并保留实际最高值与已有有效选择。没有显式覆盖时默认最高值；选回最高值清除覆盖。输出档位独立使用 4096、8192、16384、32768 等，并受输出上限约束；未知上限禁用选择，不造默认值。

`contextLimit/outputLimit` 是原始能力上限，`contextWindow/maxOutputTokens` 是有效客户端容量。降低容量后仍可恢复最高值；Pi 从同一目录导出。Qoder 原生请求选择足够大的真实窗口，不把 353k 等客户端容量直接当成不存在的上游档位。页面没有独立输出预算输入框；历史预算配置与客户端显式请求继续按原协议规则处理。

额度返回 `checkedAt` 和 `buckets`，每桶保留 id/name/unit/group/period、已知 limit/used/remaining、usedPercent/resetsAt，Qoder 可带 history。单位有 credits/percent/tokens/requests/unknown；只知道百分比不能反推绝对数量。未知值不等于零，额度快照不等于按 token 估算的费用。

## 管理入口与兼容

页面使用工作台管理鉴权，与 `/v1` 的客户端 Key 分开。

| 公共入口 | 功能 |
| --- | --- |
| `GET /api/proxy/status`、`GET /sources`、`GET /requests` | 服务、来源公开状态与诊断记录，不自动生成 |
| `POST /api/proxy/service`、`POST /settings` | 开关、端口与自动启动；活动请求停止需确认 |
| `GET /api/proxy/key`、`POST /key/rotate` | 客户端 Key 与轮换 |
| `POST /api/proxy/check` | 公共连接检查 |
| `POST /api/proxy/runtime` | 仅原生外层处理 Node 配置 |
| `GET /api/proxy/sources/:id/status`、`GET /models`、`POST /models/setting`、`GET /quota` | 来源状态、目录、即时模型设置、公共额度 |
| `POST /api/proxy/sources/:id/auth/:operation`、`GET /auth/poll` | 来源声明的授权操作与轮询 |
| `POST /api/proxy/sources/:id/check` | body 指定 kind 为 catalog 或 inference；后者才发生成请求 |
| `/api/proxy/custom/sources` 与 `/sources/{save,delete,discover,key}` | 自定义配置和受控凭据读取；测试为 `/api/proxy/custom/test` |
| `GET/POST /api/proxy/routes` | 模型路由查询/保存 |

表内缩写路径沿用同一前缀。来源 ID 必须 URL 编码，Custom 为 `custom:<配置 ID>`。认证操作使用固定允许列表。外部 Agent 的 `/api/v1/proxy` 与 AI 草稿契约见 [AI 说明](ai.md)。

旧 `/api/qoder`、`/api/agy`、`/api/grok`、`/api/codex-proxy`、`/api/kimi-proxy`、`/api/custom-proxy` 继续映射同一管理操作，保持原方法、响应与测试副作用。共享配置仍使用历史 `qoder/` 数据路径，源码整理不迁移配置或更换凭据来源。原生同协议保留搜索/引用/reasoning/签名，跨协议不能无损表示时明确拒绝。

## 来源能力与管理工具

每个内置 provider 导出一份 `sourceDescription`，生产 snapshot 与注册表的兼容描述共用它。来源 `snapshot().authentication.operations` 声明可用授权操作，`listModels()` 中的 `settingFields` 声明每个模型可修改字段。公共 AI 管理工具从实际来源目录枚举来源，使用 `/api/proxy/sources/:id`，不按来源名称枚举字段或授权路径；字段的通用类型和能力校验位于 contracts，实际保存仍由 provider 或 Custom 的完整配置事务处理。未声明的字段与授权操作拒绝执行。

Custom 的 `models.js` 声明草稿可编辑字段，通过 sources 的公开配置提供给工具；逐 Key 权限与保存事务保持独立。来源 `capabilities.pi` 按 Pi API 名称给出已知不兼容原因，中转 service 将它带入共享客户端目录；cli/pi-config 不再根据来源名称决定协议限制。未声明限制不补造验证证据。

历史管理路径及旧配置资源名称的映射只留在 management 的兼容层，tools 通过注入的兼容读取函数保留旧资源响应。新增来源时实现能力与执行入口并在 providers 注册，公共工具和 Pi 不需要增加来源名称分支。`test/source-capabilities.test.mjs` 使用陌生来源 ID 核验设置、授权、重试和 Pi 限制。

## 问题记录：并行工具历史导致 Qoder 502

2026-10-03 定位：共享 Responses 转换把同一轮两个 function_call 拆为两条 assistant 消息，工具结果排列在两条消息之后，下游校验拒绝。共享转换已恢复同轮工具分组。

错误链为上游连接 HTTP 200 → 包装内业务错误 400 invalid_request_error → Qoder provider_error → Daylight 502。单工具成功、并行工具复现失败，修复后短合成历史返回 OK；问题不在 COSY 签名、正文编码或 Pi 并行执行。

回归位于 `test/protocol-normalization.test.mjs`、`test/qoder.test.mjs` 和 Pi 集成检查。诊断可记录安全的 upstreamErrorStatus/upstreamErrorCode，缺失保持缺失，不保存上游错误正文、提示词、工具参数或凭据。

## 验证与后续维护

2026-10-03 此次重构的记录：

- `npm run check`、200 项 Node 测试通过，覆盖协议、参数、缓存竞态、容量/设置、公开契约、兼容路径和前端状态。
- 原生浏览器使用隔离模拟来源检查六个页面、容量/强度/Fast 保存、Custom 草稿保护与路由；960px 无横向溢出。
- App 构建、`test/native-test.py`、`test/native-proxy-test.py` 通过；侧车测试使用模拟 Qoder，覆盖认证、流式、自动启动、父进程清理和缺失 Node 恢复。
- 本机 Pi 库通过 Chat/Responses 配置格式检查，以及 Responses 的模拟流式思考、工具调用和结果续接。
- 0.4.0 DMG 与镜像内 App 签名已校验；本地 App 已替换并启动，安装包与构建包一致，业务/配置摘要保留、代理自动启动。详情见 [macOS 应用记录](native-app.md#本地-040-打包记录)，安装核验不代替真实上游回归。

此前真实 Pi → Qoder 的并行工具短历史验证只证明原缺陷修复；2026-09-30 的 Grok 实测覆盖文本、图片、结构化输出、工具回传和搜索，属于重构前证据。上述记录不代表重构后六个真实账号或全部协议已完成端到端验收，也未重放真实会话。

2026-10-16 独立账号与公共组件复用的补充记录：

- `npm run check`、454 项 Node 测试通过；其中 `test/account-reuse.test.mjs` 的 14 项回归覆盖账号切换、迟到目录检查、授权取消、关闭清理、来源元数据一致性及 Copilot 原 Keychain 格式兼容。
- 打包资源通过本机 Pi 库的模拟工具调用和结果续接：Kimi/Grok/Codex 使用 Responses，Copilot 覆盖三个协议。真实 Copilot 账号通过 Pi Messages 完成工具调用及结果续接，两次请求均记录为 Copilot、HTTP 200；该证据不代表其他独立账号或全部模型已完成真实推理。
- 本机 App 已构建、签名校验并替换；业务数据、AI 会话、已有登录记录、Pi 配置与 CLI 登录文件保留。此阶段 AGY 目录失败仍会暂停 Pi 全量自动同步；后续已改为下文的按来源同步。

后续应补充各来源真实账号回归；默认不改真实客户端配置。修改公共代码执行 `npm run check`、`npm test`；涉及原生资源/进程执行相应原生测试与构建。新增来源先实现公开接口、认证描述和能力目录，再注册；避免复制页面或在公共推理层增加来源名称分支。

重命名资源时同步检查 server.mjs 和 native/Server.swift 静态允许列表、native/Proxy.swift 管理转发、scripts/check-proxy.mjs、构建依赖图与动态入口。安装包继续裁剪不可达模块，保留许可证；SDK 对话适配与纯模型 API 中转分别验证。


来源基础信息统一在 `core/proxy-sources.js` 定义，代理标签、Pi 来源筛选及后端来源名称从中生成；各页面保留原有排序和简短标签。来源显示使用 `public/proxy/source-navigation.js` 的统一标签注册，所有来源共用选择、可见页面回退与键盘顺序。统一 `GET/POST /api/proxy/view` 通过 `shared/view-settings.js` 原子保存 `qoder/view.json`，带版本校验拒绝其他窗口的过期覆盖，不改变运行设置或路由，不以账号连接状态自动隐藏来源。首次读取前隐藏标签栏，读取失败保留已有显示并提供重试，损坏配置保留原文件。Node 与桌面 helper 共用同一管理入口和页面资产。

### 公共账号认证与页面

`shared/oauth-account.js` 负责 Daylight 自有凭据、单次并发续期、轮换刷新令牌、授权轮询及取消后的写入隔离；`shared/oidc.js` 验证签名、issuer、audience、nonce 与账号身份。Kimi / Grok / Copilot 复用同一设备授权流程，来源适配器保留请求编码、账号读取和令牌格式差异；AGY / Codex 复用 `shared/loopback-account.js` 的本机回调；来源仅实现授权参数与令牌/身份交换。Copilot 继续读取原 Keychain 项与原 GitHub 凭据格式，短期 Copilot token 仍单独换取。来源只输出公开账号信息与身份指纹，不输出令牌。AGY 使用独立 Keychain 项，旧登录仅在首次兼容导入时读取；退出后不再导入。

`shared/account-catalog.js` 统一绑定账号变化与目录/额度缓存失效，并阻止旧账号检测结果覆盖新状态。管理层也按认证代次过滤迟到检测结果。

`public/proxy/source-page.js` 统一渲染账号、登录、刷新登录、退出及授权提示。`state.js` 以认证代次丢弃取消/退出前的迟到回复。AI 管理仍走公开认证契约及审阅草稿；授权 URL 中的 ID-token hint 不进入 AI 工具结果。Pi 从同一模型目录生成配置，不读取上述来源的 CLI 凭据。

### Pi 按来源同步

`cli/pi-config.js` 复用同一套预览、版本校验、写入事务、备份和恢复流程。健康来源正常同步；失败来源的原模型定义不参与重建，直接保留。来源集合写入 `cli/pi-sync.json` 的 `modelSources`，同名模型可对应多个来源；归属未知的旧模型在部分失败时保守保留。前端以 `retained` 状态展示，不开放修改保留模型，恢复后回到正常模型控件。目录告警使用 `catalogWarning`，不再阻止健康来源同步；协议、地址或 Key 变化与保留配置冲突时才用 `catalogError` 阻止写入。原先目录失败时仅同步参考价表的分支及对应旧测试已删除。

回归覆盖健康来源新增/移除/容量/价表更新、失败模型原样保留、跨重启的来源集合、未知归属、共享模型、默认值/私有头保护、恢复及外部修改冲突。AGY 回归覆盖回调校验、PKCE、取消/拒绝/过期、并发续期、退出竞态、原凭据兼容导入、目录权限与迟到账号结果。真实 AGY 推理和 Pi 调用已在用户完成独立登录后验证，范围见下文。

2026-10-16 本轮验证：`npm run check`、456 项 Node 测试、签名 App 构建与原生数据服务测试通过；打包资源使用本机 Pi 1.2.0 完成 Kimi/Grok/Codex/AGY 的模拟 Responses 工具调用及续接，Copilot 完成三个协议的模拟回归。隔离浏览器验收覆盖部分同步、AGY 授权/取消/刷新/退出、空结果和焦点恢复；六个来源在 1440px 与 900px 下公共布局锚点一致，无横向溢出。源码及安装包未包含本机 AGY OAuth 客户端配置值。

### AGY 独立登录后的真实验证

2026-10-16 14:27（Asia/Shanghai），在已安装的 App（代码提交 `1966434`）上使用真实 AGY 账号验证；配置及请求摘要见 [AGY 验证记录](verification/proxy/agy-independent-login.json)。

| 模型 | 实际上游模型 | Messages 文本推理 | Pi Responses 工具调用与结果续接 |
| --- | --- | --- | --- |
| `gemini-3.8-flash` | `gemini-3.8-flash-low` | 通过，回答 17 + 25 = 42 | 通过，调用 calculator 后回传 42，模型正确续答 |
| `claude-opus-4-6-thinking` | `claude-opus-4-6-thinking` | 通过，回答 17 + 25 = 42 | 通过，调用 calculator 后回传 42，模型正确续答 |

Pi 检查使用本机 Pi 1.2.0 的 `ModelRuntime` 和临时模型/认证配置，通过已安装 App 的 HTTP 网关发起 Responses 请求。每个模型分别完成一次原生 Messages 文本请求、一次 Pi 流式工具调用、一次工具结果续接。6 条请求均记录为 `provider: agy`，客户端与上游 HTTP 状态均为 200、结果为 `completed`；工具调用记录确认观察到工具事件。测试按请求指定 low 思考强度，没有改动保存的默认值。

前后比对的 20 个受保护配置文件摘要一致；Pi 的 models/settings/auth 文件、默认模型、思考档位、个性化设置及已有登录记录未变，临时配置已清理。该结果覆盖上述两个模型和两条调用路径，不代表其他模型、全部协议组合或长会话均已验证。
