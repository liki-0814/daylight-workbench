# composer（新建任务面板）

`composerBody({ error, project, projects, title, notes, status, priority, due, estimate, *Options, attachments, keepOpen })` 与 `composerDialog(props)`（外面包一层 dialog，680 宽）。居中，无边框标题，描述，附件缩略图（120×56，圆角 10），胶囊属性（状态 / 项目 / 优先级 / 截止 / 预估时长，都是 select 组件，项目菜单向下展开并可越过弹窗边缘），底栏：左 ＋ 附件圆形按钮与「继续新建」开关，右 ⌘↵ 提示与青绿圆形创建按钮。**没有麦克风按钮。**

页面级命令（`data-action`）：`attach-files`、`create-task`（同时带 `data-dialog-submit`，⌘/Ctrl+↵ 触发）。

`error`：字符串，非空时在属性行上方渲染 `<p class="dl-comp__error" role="alert">`（经 `esc()`）。页面用 `mountDialog(...).update(composerBody({ ..., error }))` 重绘，不要自己 `createElement` / 查询内部类。标题 / 描述输入框是 live 的：每次输入都派发 `ui:change`，页面只监听 `ui:change`。

## 派发的事件
**无**（纯组合）。里面的 select 派发 `ui:change` / `ui:select`（「新建项目…」`value: '__new__'`），switch 派发 `ui:change`，dialog 派发 `ui:dismiss` / `ui:close`。

## 转义
所有标题 / 描述 / 附件名 / 选项文字经 `esc()`（子组件负责）。
