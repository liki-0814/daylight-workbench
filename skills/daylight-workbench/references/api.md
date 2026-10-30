# 本地管理 API v1

默认地址 `http://127.0.0.1:4318`。推荐使用 skill 的 `scripts/workbench.py`，自动从 config.json 指向的数据目录读取凭证。

所有 `/api/v1/*` 需要 `Authorization: Bearer <本机 agent-token 文件内容>`。token 不通过接口返回，不写进 skill，不放入 shell 参数或日志。客户端不发送 Origin，服务器拒绝第三方网页 Origin。服务只监听回环地址。

## 读取与导出

- `GET /api/v1/capabilities`：实时能力表、接口版本及去重窗口。
- `GET /api/v1/state`：`{version, localDate, state}`；state 含 schema、projects、tasks、plans。
- CLI `state --query TEXT --project ID --view today|inbox|done|all --date YYYY-MM-DD` 返回完整 state 和筛选后的 matchingTasks。`today` 含当天计划内的已完成任务，保留计划顺序。
- CLI `export --out PATH` 保存完整业务 state 到新文件，不覆盖已有文件，不导出凭证及内部请求记录。

项目：`{id,name,path,color}`。任务：`{id,title,projectId,notes,status,completedAt}`。`projectId:null` 为未归类（旧称收件箱）。状态只有 `todo`、`active`、`done`。`plans` 将日期映射到有序任务 ID 数组。

## 写入

`POST /api/v1/actions`，JSON：

```json
{
  "requestId": "a-unique-request-id",
  "expectedVersion": 0,
  "day": "2026-09-07",
  "action": { "type": "plan.add", "id": "task-1" }
}
```

`expectedVersion` 必须取自当前读取结果。`day` 可省略，默认本机当天；重试时保留完全相同的请求体，包括是否省略 day。requestId 使用 UUID 等 8–100 位字母、数字、下划线或连字符，单次逻辑操作唯一。

成功：`{version,state,replayed,appliedVersion}`。`appliedVersion` 是该请求首次生效的版本，`version/state` 是当前状态，可能包含后续操作。最近 100 个成功请求持久化去重，跨服务重启有效；同 ID 换参数返回 409。未知结果只重试原请求，别换 ID 重新创建。

| action.type | 字段 | 行为 |
| --- | --- | --- |
| project.create | name, path?, id? | 创建项目，path 默认空，id 默认生成 |
| project.update | id, name?, path? | 仅修改提供字段 |
| project.delete | id | 删除项目及其全部任务（包括已完成任务）和日期引用；不删除本地目录 |
| task.create | title, projectId?, notes?, today?, planDay?, id? | 默认未归类；planDay 指定加入日期，与 today:true 互斥 |
| task.update | id, title?, projectId?, notes? | 部分更新；projectId=null 移到未归类 |
| task.status | id, status | 显式设置状态；active 会暂停其他当前任务并加入指定日期；done 写完成时间，todo 恢复/暂停 |
| task.delete | id | 删除任务并移除所有日期的引用 |
| plan.add | id | 将未完成任务加入指定日期，已存在不重复 |
| plan.remove | id, preserveExecution? | 从指定日期移出；默认 active 回到 todo；preserveExecution:true 保留执行状态 |
| plan.move | id, direction | 未完成任务中移动一位，direction 为 -1 或 1；保留执行状态 |
| plan.set | ids | 用有序唯一 ID 列表替换指定日期的整个计划，只接受未完成任务；可能移除旧计划项，应符合用户意图 |
| plan.reschedule | id, fromDay, toDay | 原子移出来源、加入目标；目标去重，保留任务状态和其他日期安排 |
| batch | actions | 1–100 条原子操作；子操作可带独立 day，缺失时继承顶层 day；任何一步失败不保存，不能嵌套 batch/undo |
| undo | 无 | 恢复最近一次全局写入前的业务数据；版本继续增加，去重记录仍保留 |

新增对象可指定客户端生成的 ID，以便在一个 batch 内创建后引用。例如：

```json
{
  "type": "batch",
  "actions": [
    {"type":"task.create","id":"draft-task-unique-id","title":"用户明确的任务","projectId":"实际读取到的项目ID"},
    {"type":"plan.add","id":"draft-task-unique-id"}
  ]
}
```

不提供外部 toggle 操作，避免重试把完成变成未完成。网页内部的完整状态接口不应用于 skill，使用以上受版本保护的语义接口。

400 表示输入或业务条件不合法；401 表示认证失败；409 表示版本冲突或 ID 被复用；5xx/超时的写结果可能未知，先保留原请求。无副作用的读取可重试，写入客户端不自动重试。

## 删除与恢复

删除指定任务：`{"type":"task.delete","id":"实际任务ID"}`。完成、进行中和待办任务均可删除，同时清除所有日期引用。项目删除：`{"type":"project.delete","id":"实际项目ID"}`，同时级联删除项目下全部任务（包括已完成任务）及其所有日期引用，其他项目和未归类任务保留。执行前提醒项目名和任务总数。不存在的对象返回 400。

读取当前版本后再提交删除；成功后核对目标及安排引用已移除。最新一次删除可用 `{"type":"undo"}` 恢复整个被删除项目、任务、原状态及各日期安排。撤销仍需最新 expectedVersion 和新的 requestId；后续有其他写入时，undo 恢复的是那次写入，不是更早删除的对象。


## 统一任务查询（增量接口）

`GET /api/v1/tasks` 沿用 Agent Bearer 认证。`capabilities.taskQuery` 声明支持；没有这个字段的旧服务仍可用旧 `state` 命令。

参数：`scope=all|today`（默认 all）、`status=all|open|done`（默认 all）、`projectId`、`unassigned=1`、`query`、`day=YYYY-MM-DD`（默认服务器 localDate）。projectId 与 unassigned 互斥。open 包含 todo 和 active；today 保留计划顺序，包括选择 all/done 时的已完成项。非法枚举或日期返回 400，不存在项目返回 404，合法条件没有任务返回 200。

返回 `{version,localDate,selection,counts:{open,done,total},tasks}`。counts 在相同范围、归属、关键词下按所有状态统计，tasks 再按 status 筛选。读取不修改版本或数据，不包含 AI 会话。

```sh
python3 "$SKILL/scripts/workbench.py" tasks --scope today --status open
python3 "$SKILL/scripts/workbench.py" tasks --project PROJECT_ID --status done
python3 "$SKILL/scripts/workbench.py" tasks --unassigned --query '接口'
```

旧 `state --view all|today|inbox|done` 仍兼容：all 包含所有状态，today 保留计划内已完成项及顺序，inbox 是未归类待办的旧名称。取消 UI 收件箱入口不改变 null 归属、action 或导出合同。

## 日历与专注

新增接口沿用 `/api/v1` Agent Bearer 和本机 Origin 规则；capabilities.calendarQuery、taskPlanning、focus 声明路径、操作与限额。未知或重复查询参数明确拒绝，日期为严格 YYYY-MM-DD，含两端。

| 接口 | 请求与返回要点 |
| --- | --- |
| GET /api/v1/calendar | from/to 必填，最多 62 天；status=all/open/done、projectId 或 unassigned=1、query、previewLimit=0–5（默认3）；返回 version/selection/days，每天含 counts/matchedCount/preview/hasMore，preview 按计划顺序，计数先于状态筛选 |
| GET /api/v1/focus/state | 不接受查询；返回 version/taskVersion/serverNow/settings/current/lastOutcome/runtime，不含全历史 |
| GET /api/v1/focus/statistics | from/to 必填，最多 366 天；projectId 或 unassigned=1、taskId；返回 summary/daily/projects/timeZone/asOf/version |
| GET /api/v1/focus/sessions | 日期范围可省略；同上筛选，可加 phase=work/shortBreak、limit=1–100（默认20）、cursor；返回总数、前后游标和会话 |
| GET /api/v1/focus/task-summary | taskId 必填，recentLimit=0–10（默认5）；返回该 taskId 全历史工作累计和最近记录，允许已删除任务 ID |
| GET /api/v1/focus/export | 无参数；返回独立专注业务数据，剔除内部去重回执，不返回凭证 |
| POST /api/v1/focus/prepare | `{action}`；返回 focusVersion/taskVersion/normalizedAction/impact/preparedAt 和适用的 expiresAt；严格无持久写入 |
| POST /api/v1/focus/actions | 下述版本保护请求；原子保存，仅修改专注数据 |

工作/休息统计单位为毫秒；有效运行段按固定 IANA 统计时区拆日，工作完成轮数按结束日期计数。休息不进入工作累计；项目归属使用开始时快照，任务累计按稳定 ID。当前工作已发生的时间计入并标记 includesCurrent。会话游标绑定版本/筛选，变化后返回 CURSOR_STALE/409，需重新从第一页查询。

写请求：

```json
{
  "requestId": "unique-focus-request-id",
  "expectedVersion": 4,
  "expectedTaskVersion": 12,
  "expiresAt": 1791252600000,
  "action": {"type":"focus.start","phase":"work","taskId":"actual-task-id","durationSeconds":1500}
}
```

示例值只表达形状；版本、ID 与 expiresAt 必须从实际读取/prepare 获取。最近 100 个成功 focus 请求持久去重，回执匹配在版本、会话与过期检查之前；同 ID 同请求可跨重启重试，同 ID 换请求返回 409。过期后重试已提交请求仍必须保留原 expiresAt。返回 `{ok,version,appliedVersion,replayed,current,lastOutcome,actionResult,runtime}`；current/lastOutcome 为当前快照，不能当作首次请求时的完整状态。

| action.type | 字段 |
| --- | --- |
| focus.start | phase=work/shortBreak，工作必须带未完成 taskId；durationSeconds 可省略，范围 work 60–10800、shortBreak 60–3600 |
| focus.switch | 同 start，另带当前 sessionId；提前结束旧轮并开始新轮 |
| focus.pause / focus.resume / focus.finish | 当前 sessionId |
| focus.settings | settings 局部字段 workSeconds/shortBreakSeconds/notificationsEnabled/soundEnabled/showTrayTimer；固定统计时区不可改 |
| focus.acknowledge | 当前 lastOutcome 的 outcomeId |

start/switch 必须带 expectedTaskVersion；所有动作带 expectedVersion。时间敏感 prepare 草稿 10 分钟过期，settings/acknowledge 不返回 expiresAt。prepare 不生成 request ID，客户端自行生成并保留。Web 使用同语义的 `/api/focus/*`（会话token）与 `/api/calendar`；Web 专注写、task-actions 和恢复 POST 同时要求正确 Origin。

任务写入成功后会核对关联工作会话；专注保存失败返回任务成功并带 focusWarnings，随后重试核对。专注损坏返回 FOCUS_UNAVAILABLE/503 并保留文件，任务 API 可继续使用。通知消费仅原生内部使用，没有 Agent 消费或权限授权出口。内置 AI 的持久恢复 endpoint 仅供 Web 审阅，不属于外部 Agent API。

## AI 对话查询与删除

`capabilities.aiConversations` 声明此能力；沿用 Agent Bearer 和本机 Origin 检查。

- `GET /api/v1/ai/state` 返回 `{version,settings,conversations}`，version 为字符串。列表包括 id/title/backend/config/scope/status/updatedAt/messageCount，不返回消息内容或凭据。
- `POST /api/v1/ai/actions` 仅接受删除操作：

```json
{"requestId":"unique-request-id","expectedVersion":"读取到的字符串版本","action":{"type":"ai.conversation.delete","id":"真实对话ID","expectedUpdatedAt":"目标的updatedAt"}}
```

返回 `{ok:true,status:"applied",action}`；最近 100 个管理回执跨重启保存，同 requestId/同 action 可重试，同 ID 换 action 返回 409。expectedVersion 检查 AI 设置与会话元数据；expectedUpdatedAt 保护目标内容。运行中、等待确认或目标已变化返回 409，不存在返回 404。删除该对话的 Daylight 存档及列表条目，不删除 CLI 自身历史、工作目录、项目任务或其他对话保存的引用快照。不可撤销，业务 `undo` 不恢复 AI 对话。界面使用同语义的 `/api/ai/state` 与 `/api/ai/actions`，使用本机会话鉴权。


## 本地扩展接口

前缀 /api/v1/extensions，Bearer 沿用本机 Agent 凭证。GET /state、/objects/:id?file=SKILL.md、/diagnostics、/operations/:requestId；POST /refresh、/prepare、/actions；GET/DELETE /probes/:id。所有未知接口先鉴权再拒绝。静态查询不启动 MCP。来源缺失时只展示空清单，不创建目录。

prepare 请求 {"action":...}，返回 normalizedAction、expectedVersion（字符串）、planId、files（真实前后内容/链接）、conflicts、impact。actions 请求 {"requestId":"UUID","expectedVersion":"...","planId":"...","action":规范化动作}；必须使用同一份审阅结果。文件、来源或接入目标变化时 409，保留输入并重新预览。相同 ID 不同内容拒绝，相同原请求成功回执可跨重启重放。

动作：skill.create(directory,content完整SKILL.md,clientId?省略为共享来源)、skill.update(id,file?,content)、skill.archive(id)、skill.disable(id)、skill.enable(id,clientIds?)、skill.import(sourcePath,scope,clientId?)、mcp.importJson(json,scope,clientId?)、mcp.save(server,clientId?省略为共享来源,create?新建时传 true：ID 已存在返回 409 EXTENSIONS_DUPLICATE_ID，省略则编辑并替换同 ID 服务)、mcp.install(id共享MCP,clientId)、mcp.toggle(id软件MCP,enabled)、mcp.archive(id)、mcp.generate(clientId)、mcp.probe(id)、binding.connect/adopt/disconnect(id,clientId)、client.save(client)、client.select(clientId,selected布尔值)、client.remove(clientId)、operation.restore(operationId)。Skill ID 从清单读取，MCP ID 与名称分别存储。archive 可用 operation.restore 恢复，恢复遇到后续文件变化不覆盖。receipt 状态 applying/applied/rolled_back/recovery_required 明确区分；外部漂移须核对文件后重试原请求。

server 字段 id/name/transport/enabled；stdio 使用 command/args/cwd/envRefs，HTTP 使用 url/headerRefs。凭据引用格式 {"请求头或变量名称":"环境变量名称"}，不接受 env/headers 明文。stdio 不经 shell 执行。mcp.probe 须明确授权，仅 initialize 和 tools/list；实际命令/端点在预览中呈现，不能作为静态诊断的隐式动作。

软件详情的 root 为软件主目录，skillsRoot 为该软件自身的 Skills 目录；state.root/skills 为 Daylight 管理来源。Codex 主目录默认 ~/.codex，可由 CODEX_HOME 指定；Codex 链接位置为 ~/.codex/skills；Pi 主目录默认 ~/.pi，链接位置为 ~/.pi/agent/skills。PI_CODING_AGENT_DIR 显式覆盖时代表 agent 目录，Skills 在其 skills 下。只发现 ~/.agents/skills 的一级子目录。

各软件按 Skill 链接，软件本地目录也可用 skill.update/archive 管理；未知外部链接归档只移除链接，不读取或删除其目标。已有正确链接可用 binding.disconnect(includeExisting:true) 预览移除，adopt 只是可选的归属记录。同名实体或外部漂移不能覆盖。

Skill 启用/停用（仅共享来源的 Skill）：skill.disable 取消该 Skill 在所有软件中的链接（Daylight 管理的与已有的正确链接都会移除），把这些接入记入 bindings.json 的 `skillStates[skillId] = {disabled, rememberedBindings:[{clientId,source,target,linkTarget}]}`，源文件不动；停用中的 Skill 不能 connect/adopt（409 EXTENSIONS_SKILL_DISABLED）。skill.enable 按记忆重建链接；目标位置被占用进入 conflicts（apply 返回 409 EXTENSIONS_CONFLICT），可用 clientIds 只恢复其中一部分，其余继续保留在记忆中。已停用再停用 409 EXTENSIONS_ALREADY_DISABLED；没有可恢复内容时再启用 409 EXTENSIONS_ALREADY_ENABLED；软件自带（client scope）或只读链接 Skill 返回 400 field=id。state.skills[] 增加 `enabled`（布尔）与 `rememberedClientIds`（字符串数组）。

MCP 清单通过 scope(shared/client)、clientId、serverKey、sourcePath 区分来源。软件 mcp.save 使用 serverKey 作为 server.id；mcp.install 拒绝覆盖同名服务；mcp.toggle 仅用于 toggleSupported 服务；mcp.generate 仍仅导出到 ~/.agents/mcp/generated。原生 MCP 修改只改变目标字段，其他设置、未知字段和既有凭据保留。公开计划不展开整个软件配置，secretKeys 表示隐藏并保留的字段；新凭据仅填环境变量引用。Qoder 的插值未核实，不写新引用。软件 MCP 握手和运行发现由 CLI 核对；mcp.probe 用于共享 MCP。

client.save 的 client 字段为 id（client_ 前缀）、name、command（单个命令名或可执行文件绝对路径）、root（绝对路径或 ~/ 开头）、skillsDirectory（相对目录，默认 skills）、mcpFormat（none/toml/json，默认 none，仅导出格式）、adapter（auto/manual/codex/qoder/pi/grok/claude，默认按命令匹配）。登记在 ~/.agents/daylight/clients.json，最多 50 项；不会安装或执行 CLI。仅自定义登记支持 client.remove；自动识别项有 registrationId 时可用该旧 ID 删除登记并迁移管理记录，不改链接。其他登记移除和变更接入目录前须解除已管理链接，恢复登记也受该约束。已登记软件从 state.clients 读取，不把 capabilities.clients 的内置列表当成全量列表。

CLI 自动发现只提供候选项，state.clients.selected 表示用户是否选择接入。client.select 通过审阅持久化选择到 clients.json 的 selectedClients；选择后才扫描该 CLI 的 Skills、用户级 MCP，取消选择不修改已有文件、链接和归属记录。未选择的 CLI 不能执行本地 Skill/MCP 写操作，返回 EXTENSIONS_CLIENT_NOT_SELECTED。已有明确登记及 Daylight 管理记录沿用原选择，单纯存在命令、目录或外部链接不自动接入。

扩展错误与诊断契约：校验失败（400）与重复 ID（409）的响应在 `error`、`code` 之外带 `field`（点分字段路径，如 `server.url`、`server.envRefs`、`directory`、`content`），前端据此把错误贴到字段旁。计划（prepare 响应）与 `servers[]` 带 `warnings`（如 `{code:'INSECURE_HTTP',field:'server.url',message}`：http:// 非本机地址），警告不阻止应用。`GET /objects/:id?kind=skill|mcp|client` 的 404 文案按类型区分并回传 `kind`。`diagnostics[]` 每项带 `tab`（skills/mcp/clients）；`MCP_FORMAT` 另带 `path`、`line`、`column`、`reason`（不回显文件内容）。

导入：skill.import 仅支持本地绝对路径文件夹（无 URL 导入）；顶层需有合法 SKILL.md，目录名取 SKILL.md 的 name，不跟随任何符号链接，忽略隐藏文件与 node_modules，限制 500 个文件 / 5 MB / 6 层；同名为 conflicts（409 EXTENSIONS_CONFLICT），无效来源 400 field=sourcePath（code EXTENSIONS_IMPORT_NO_SKILL/SYMLINK/LIMIT/SPECIAL）。mcp.importJson 接受 {mcpServers:{…}} 或带 id/name 的单个服务对象（最多 100 个），env/headers 的值只能是 `${VAR}`/`$VAR`，明文值 400（field 形如 mcpServers.<id>.env.<KEY>，响应不回显该值）；JSON 语法错误 400 field=json 并带 `line`、`column`；已有 ID 为 conflicts，不覆盖。

MCP 交互：mcp.toggle 共享服务行级启停（只改主配置，不启动服务）；POST /probes 支持 {ids:[…],expectedVersion} 批量检测（同时最多 2 个，其余 status=queued；已停用的列入 skipped）；服务带 refStatus（变量名与是否已设置，永不含值）。
