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
| task.create | title, projectId?, notes?, today?, id? | 默认未归类，today 默认 false |
| task.update | id, title?, projectId?, notes? | 部分更新；projectId=null 移到未归类 |
| task.status | id, status | 显式设置状态；active 会暂停其他当前任务并加入指定日期；done 写完成时间，todo 恢复/暂停 |
| task.delete | id | 删除任务并移除所有日期的引用 |
| plan.add | id | 将未完成任务加入指定日期，已存在不重复 |
| plan.remove | id | 从指定日期移出；任务保留；进行中的该任务回到 todo |
| plan.move | id, direction | 未完成任务中移动一位，direction 为 -1 或 1 |
| plan.set | ids | 用有序唯一 ID 列表替换指定日期的整个计划，只接受未完成任务；可能移除旧计划项，应符合用户意图 |
| batch | actions | 1–100 条原子操作，共用 day；任何一步失败不保存，不能嵌套 batch/undo |
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

## AI 对话查询与删除

`capabilities.aiConversations` 声明此能力；沿用 Agent Bearer 和本机 Origin 检查。

- `GET /api/v1/ai/state` 返回 `{version,settings,conversations}`，version 为字符串。列表包括 id/title/backend/config/scope/status/updatedAt/messageCount，不返回消息内容或凭据。
- `POST /api/v1/ai/actions` 仅接受删除操作：

```json
{"requestId":"unique-request-id","expectedVersion":"读取到的字符串版本","action":{"type":"ai.conversation.delete","id":"真实对话ID","expectedUpdatedAt":"目标的updatedAt"}}
```

返回 `{ok:true,status:"applied",action}`；最近 100 个管理回执跨重启保存，同 requestId/同 action 可重试，同 ID 换 action 返回 409。expectedVersion 检查 AI 设置与会话元数据；expectedUpdatedAt 保护目标内容。运行中、等待确认或目标已变化返回 409，不存在返回 404。删除该对话的 Daylight 存档及列表条目，不删除 CLI 自身历史、工作目录、项目任务或其他对话保存的引用快照。不可撤销，业务 `undo` 不恢复 AI 对话。界面使用同语义的 `/api/ai/state` 与 `/api/ai/actions`，使用本机会话鉴权。
