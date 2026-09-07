# 本地管理 API v1

默认地址 `http://127.0.0.1:4318`。推荐使用 skill 的 `scripts/workbench.py`，自动从 config.json 指向的数据目录读取凭证。

所有 `/api/v1/*` 需要 `Authorization: Bearer <本机 agent-token 文件内容>`。token 不通过接口返回，不写进 skill，不放入 shell 参数或日志。客户端不发送 Origin，服务器拒绝第三方网页 Origin。服务只监听回环地址。

## 读取与导出

- `GET /api/v1/capabilities`：实时能力表、接口版本及去重窗口。
- `GET /api/v1/state`：`{version, localDate, state}`；state 含 schema、projects、tasks、plans。
- CLI `state --query TEXT --project ID --view today|inbox|done|all --date YYYY-MM-DD` 返回完整 state 和筛选后的 matchingTasks。`today` 含当天计划内的已完成任务，保留计划顺序。
- CLI `export --out PATH` 保存完整业务 state 到新文件，不覆盖已有文件，不导出凭证及内部请求记录。

项目：`{id,name,path,color}`。任务：`{id,title,projectId,notes,status,completedAt}`。`projectId:null` 为收件箱。状态只有 `todo`、`active`、`done`。`plans` 将日期映射到有序任务 ID 数组。

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
| project.delete | id | 只允许删除无任务项目，避免级联丢失 |
| task.create | title, projectId?, notes?, today?, id? | 默认进入收件箱，today 默认 false |
| task.update | id, title?, projectId?, notes? | 部分更新；projectId=null 移到收件箱 |
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
    {"type":"task.create","id":"draft-task-unique-id","title":"用户明确的任务","projectId":"billing"},
    {"type":"plan.add","id":"draft-task-unique-id"}
  ]
}
```

不提供外部 toggle 操作，避免重试把完成变成未完成。网页内部的完整状态接口不应用于 skill，使用以上受版本保护的语义接口。

400 表示输入或业务条件不合法；401 表示认证失败；409 表示版本冲突或 ID 被复用；5xx/超时的写结果可能未知，先保留原请求。无副作用的读取可重试，写入客户端不自动重试。
