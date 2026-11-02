# 任务与导航

## 当前界面

侧栏保留任务、AI 对话、反向代理、CLI 配置、扩展管理、更新和设置七个页面。任务页默认平铺显示全部任务，包括待办、旧的 active 状态和已完成任务，不按今天计划筛掉任务，也不再按项目拆成多组。

状态筛选使用共享 `segmentedControl`：全部、待办、已完成；项目筛选使用共享 `selectField`：全部项目、未归类及各项目。搜索匹配任务标题、备注和项目名称。状态、项目与关键词可组合，项目切换保留状态和关键词。所有任务视图共享标题、筛选栏和列表结构，项目目录及编辑入口位于公共筛选栏下方。

每行保留完成/恢复勾选、完整可换行的标题和必要的项目标记；点击标题编辑名称、项目和备注。新建任务只创建任务，不再提供同时加入今天。列表不再提供开始/暂停、加入/移出今天、今日排序，也不挂载专注条、统计或任务专注摘要。设置和原生菜单栏同步移除专注入口。菜单栏仅展示待办数量、最多十二项快捷任务及查看全部入口，主列表不截断任务数量。

## 路由

| Hash | 行为 |
| --- | --- |
| `#tasks` 或 `#tasks&status=all` | 完整任务列表 |
| `#tasks&status=open` | 全部待办，包含历史 active 状态 |
| `#tasks&project=ID&status=done` | 指定项目的已完成任务 |
| `#tasks&unassigned=1` | 未归类任务 |
| `#task=ID` | 按当前项目及状态定位，打开任务编辑 |
| `#today`、`#calendar`、`#focus` | 回到完整任务列表，忽略历史日期与统计筛选 |
| `#focus&task=ID` | 打开该任务，不再打开统计页 |
| `#ai&conversation=ID` | 指定 AI 会话 |

关键词通过 `q` 编码。旧 `#all`、`#done`、`#inbox`、`#project=ID`、`#new`、`#new-project` 保持可用。任务/项目不存在时明确提示，不按名称猜测替代对象。往返 AI、设置恢复任务视图与滚动位置；刷新和浏览器前进/后退以 URL 为准。

## 数据与写入兼容

本次精简不迁移或清空业务数据：schema 仍为 1，projects/tasks/plans、任务 ID、备注和完成记录保持原样。历史 plans 和独立 focus 文件继续保留；旧任务/计划/专注 API 与导出契约保持兼容，不因移除界面删除记录。历史 active 任务作为待办展示，界面不再创建 active 状态。

任务编辑、新建、删除、完成/恢复和撤销沿用既有版本校验与写入契约。`public/task-client.js` 仍持有唯一任务撤销描述；外部版本变化使旧撤销失效。多窗口和 API 写入通过版本同步刷新；编辑时保留输入并延迟列表更新，提交仍校验版本。

`GET /api/v1/tasks` 保留原有 scope/status/projectId/unassigned/query/day 参数，`core/task-selection.js` 和 `public/task-view.js` 继续为 Node、原生 JavaScriptCore 和历史接口提供一致筛选。当前界面统一使用 `scope: all`，默认 `status: all`。
