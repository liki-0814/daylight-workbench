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
| `providers.js` | 六类来源注册、公开描述、动态自定义实例增删、执行结果入口；旧注入测试对象的兼容路径仅留在此边界 |

### shared 公共机制

| 文件/目录 | 功能 |
| --- | --- |
| `contracts.js` | 来源快照、设置能力、执行结果契约、诊断错误分类 |
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
| `quota.js` | 额度公共格式、数值与单位规范化，保留缺失值 |
| `store.js` | JSON 读取、原子写入与串行操作 |
| `secrets.js` | 自定义 Key 与敏感额外请求头的 Keychain 存取 |
| `tools.js` | AI state/prepare/apply 等操作、审阅草稿、配置版本与操作回执 |
| `utils.js` | 少量基础工具 |

来源缓存保存上游目录；router 缓存保存聚合目录与路由，两者责任不同。保存模型默认值只重算有效目录，不触发无关来源的远程发现。请求显式值优先于已保存默认值，再由上游使用缺省值；公共机制不强加全局采样、思考或输出预算默认值。

## 来源目录与文件职责

每个来源都有 `provider.js` 和 `models.js`；提供额度的来源有 `quota.js`；独立账号流程放在 `auth.js`。只有存在专属协议编解码时才增加 `protocol.js`，文件数量按实际职责决定。

| 来源 | 文件 | 功能 |
| --- | --- | --- |
| Qoder | `provider.js` | 组合认证、目录、请求与流，处理 Qoder 排队和重试 |
| Qoder | `auth.js` | 账号存储、PKCE 授权、轮询、取消/退出、令牌刷新、组织信息 |
| Qoder | `transport.js` | COSY 身份、签名、专属请求头与 HTTP；签名绑定实际发送路径与正文 |
| Qoder | `body-codec.js` | 正文编码/解码纯函数 |
| Qoder | `protocol.js` | 请求封装、session/request-set/business 字段、工具续接阶段 |
| Qoder | `stream.js` | 拆开上游 SSE 包装后交给共享 Chat 流解析器 |
| Qoder | `models.js` | Qoder 目录、CLI 模型配置、原生上下文档位、专属设置和排队规则 |
| Qoder | `quota.js` | Credits、团队包、按账号隔离的额度快照历史 |
| AGY | `provider.js` | 认证、目录缓存、有效设置与上游执行编排 |
| AGY | `auth.js` | 官方 Keychain 读取、CLI 刷新、模型发现、身份指纹 |
| AGY | `protocol.js` | 生成请求、思考配置、图片、工具、响应与签名适配 |
| AGY | `models.js` | CLI 别名与上游能力合并、Gemini 思考档位归并 |
| AGY | `quota.js` | 共享额度分组与周期解析 |
| Grok | `provider.js` | 目录/额度缓存、设置、上游执行与输出策略 |
| Grok | `auth.js` | 官方 CLI OAuth 读取、CLI 负责的刷新与锁、版本和身份隔离 |
| Grok | `protocol.js` | Responses 请求/事件、搜索、引用、不透明 reasoning、原生响应组装 |
| Grok | `models.js` | Responses 目录、容量、推理与搜索能力 |
| Grok | `quota.js` | billing 订阅周期、百分比与未知额度解析 |
| Codex | `provider.js` | 目录、设置、参数约束、原生 Responses 与 401 刷新重试 |
| Codex | `auth.js` | 唯一本机 OAuth 来源、短生命周期 app-server 的账号/目录/额度 RPC |
| Codex | `models.js` | app-server 目录与本机容量元数据、思考/速度能力 |
| Codex | `quota.js` | 官方账户限额周期与百分比 |
| Kimi | `provider.js` | 目录、额度、设置、Chat 执行和 401 刷新重试 |
| Kimi | `auth.js` | 官方凭据、本机授权服务发现/按需启动、网页登录/轮询/取消/刷新；只关闭自身启动的进程 |
| Kimi | `models.js` | 官方容量、thinking 类型、推理档位与模型能力 |
| Kimi | `quota.js` | usages 的订阅、周期限额与未知单位 |
| Custom | `sources.js` | 来源和逐 Key 配置、发现、校验、保存/删除、配置版本、Keychain 调用 |
| Custom | `provider.js` | 单来源执行实例、映射、逐 Key 权限、冷却/回退/亲和性、协议转换 |
| Custom | `models.js` | 目录解析、模型校验、逐 Key 权限与容量的保守合并 |

Qoder 8 文件、AGY/Grok 各 5、Codex/Kimi 各 4、Custom 3。Qoder 多出的签名传输、正文编码和 SSE 拆包对应真实协议边界。Codex/Kimi 的短原生请求适配使用共享转换，不另造薄封装；Custom 凭据由 sources 管理，不增加空 auth/quota 文件。

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

后续应补充各来源真实账号回归；默认不改真实客户端配置。修改公共代码执行 `npm run check`、`npm test`；涉及原生资源/进程执行相应原生测试与构建。新增来源先实现公开接口、认证描述和能力目录，再注册；避免复制页面或在公共推理层增加来源名称分支。

重命名资源时同步检查 server.mjs 和 native/Server.swift 静态允许列表、native/Proxy.swift 管理转发、scripts/check-proxy.mjs、构建依赖图与动态入口。安装包继续裁剪不可达模块，保留许可证；SDK 对话适配与纯模型 API 中转分别验证。
