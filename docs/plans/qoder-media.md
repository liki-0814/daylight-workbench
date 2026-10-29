# Qoder 图像与视频接入设计

| 项 | 值 |
| --- | --- |
| 日期 | 2026-10-29 |
| 状态 | 第一刀已实现（分支 `feat/qoder-media`），待 review |
| 范围 | Qoder 文生图、文生视频 |
| 依据 | 真实账号探针（Qoder Teams，仅一次图像、一次视频，约 44 Credits）；实现以 [media-proxy.md](media-proxy.md) 和现有 Grok / Codex / AGY 代码为准 |

## 范围

第一刀：

- 文生图：`qwen-image-3.0`，上游 `ge3i`。
- 文生视频：`wan3.0-video`，上游 `wan30`。
- 入口沿用 `POST /v1/images/generations`、`POST /v1/videos/generations`、`GET /v1/videos/{id}`。

之后再说：

- 首帧 / 参考图视频。上游要先 `PUT /api/v2/image/upload`（multipart）拿到 url，再放进 `input_reference {type: 'first_frame' | 'reference', image_url}`。现有媒体路由只收 JSON，需要单独决定上传入口，所以不放进第一刀。
- 图像编辑：没有探针，不猜。`image.edit` 明确返回 400。
- 一次多张（`n > 1`）：上游一次一张。

## 模型 id、别名、显示名

| 客户端 id | 别名 | 显示名 | 上游 | 状态 |
| --- | --- | --- | --- | --- |
| `qwen-image-3.0` | `ge3i` | Qwen-Image 3.0 (映射待确认) | `ge3i` | ge3i 是否就是 Qwen-Image 3.0 是推测（大概率） |
| `wan3.0-video` | `wan30` | 万相 3.0 | `wan30` | 用户确定的 id |

- 上游模型列表接口里没有媒体模型，所以两行是代码里的固定目录，只要登录就是 `ready`。
- 别名只在 `selectMedia` 里匹配，进入 `executeMedia` 前统一成规范 id；响应里的 `model` 永远是规范 id。
- 启用开关沿用 `settings.json` 的 `disabled` 列表（与聊天模型共存，互不覆盖），经 `bindMediaModelSettings`。
- 确认映射后只改 `QODER_MEDIA` 里的显示名和说明，id 不变。

## 客户端 API

图像（字段白名单，未知字段 400）：

- `model`、`prompt`（必填）。
- `size`：`1024x1024`（默认）、`1536x1024`、`1024x1536`、`768x1024`、`1024x768`、`1024x1280`、`1280x1024`、`1024x1792`、`1792x1024`、`2560x1080`。
- `n`：只能是 1。
- `response_format`：只支持 `b64_json`（默认）。

视频：

- `model`、`prompt`（必填）。
- `duration`：2 到 30 的整数，默认 5，发给上游时转成字符串 `seconds`。
- `size`：`1280x720`（默认）、`1920x1080`、`720x1280`、`1080x1920`、`720P`、`1080P`。
- `image`、`mode`、`input_reference`、`seconds`、`aspect_ratio`、`resolution` 等第一刀不支持的字段显式 400，不静默丢弃，也不发给上游。

视频提交返回 `{id: 'vid_…', object: 'video', status, model, source}`，轮询 `GET /v1/videos/{id}`，完成后带 `url` 和 `expires_at`（秒）。

## 响应处理

- 上游图像响应是 `data[0].url = data:image/png;base64,…`（1024² 约 1.1 MB），不是 https 地址。
- 返回 `b64_json`：去掉 data URL 前缀，沿用 32 MB 读取上限，用共享的 `imageResult`。
- `response_format: 'url'` 在发请求前就 400。图像已经花了额度却因为格式再 502，用户损失更大。如果上游以后改为 https 地址，`imageResult` 会返回 502 `response_format_unavailable`，不下载也不转换。
- 上游的 `usage`、`created` 不转发；`created` 由共享逻辑生成。
- 视频完成体里的 `video_url` 是带签名的 OSS 地址，无需鉴权，约 30 天过期，等同口令：只写进本机 job 行，不进请求记录；要求 `https://`，否则按未完成处理。

## 任务存储

沿用 `{dataDir}/proxy/media-jobs.json`（最多 50 条，非终态 24 小时后过期）：

- 行：`{id: vid_<uuid>, provider: 'qoder', account: 'acc_<uid>', model: 'wan3.0-video', upstreamId, status, outputUrl?, expiresAt?, errorCode?}`。
- 不存提示词、`usage`、上游错误正文。
- 状态映射：`queued`、`in_progress`、未知 → `in_progress`；`completed` 且有 https `video_url` → `succeeded`；`failed` → `failed`（只留错误码，没有就是 `upstream_failed`）。
- 终态任务直接本地返回，不再请求上游。
- 退出登录时按 `acc_<uid>` 清理。`QoderAuth` 以前没有 `identity`，新增 `accountKey()`（必要时读账号文件），`management.js` 在退出前取这个值。

## 传输

`QoderHttp.signedMedia(url, {session, method, body, requestId, signal})`：

- COSY 签名，路径去掉 `/algo` 前缀（与聊天一致）。
- `accept: application/json`；POST 用 `content-type: application/json`，GET 无 body。
- 不带聊天用的 `x-model-key`、`cosy-scene`、`text/event-stream`，所以不复用 `signedInference`。
- POST 请求体是 `encodeBody({payload: JSON.stringify(inner), encodeVersion: '1', sessionId, requestId})`，URL 带 `?Encode=1`；轮询 GET 不带 `Encode=1`。
- `sessionId` 每次请求新生成 `randomUUID()`，永不为空：空串会让视频提交返回 `500 Internal Server Error`（探针已复现，361 ms）。`requestId` 与签名里的一致。
- 超时沿用网关：图像 180 s、视频提交 45 s、轮询 30 s，并带客户端取消。不对 POST 自动重试，避免重复计费。

## 错误

- 未登录：401 `unauthenticated`（`mediaLoginError`），不去请求上游。
- 上游 400 / 403 / 422 且错误码属于共享的内容拒绝集合（`content_filter` 等）：固定文案“上游拒绝了该内容，请修改描述后重试”，不回显上游文字。
- 上游 500：原状态码和“上游请求失败（500）”，不重试，不改写成别的状态。
- 提交响应没有任务号：502 `invalid_upstream`，文案提醒先核对 Qoder 用量，不要重复提交。
- 响应超过 32 MB：502 `response_too_large`。
- 内容拒绝在 Qoder 上的真实错误体还没见过，目前只按共享集合识别（风险见下）。

## 额度与参考花费

- 额度：Qoder 的积分是团队资源包额度（Credits，不是 USD），已在来源页额度面板里显示；媒体生成消耗同一份额度，不新增接口。
- 实测消耗：图像约 4 Credits，5 秒 720p 视频约 40 Credits。这只是一次实测，且额度是账号级别的，其他客户端也会扣。
- 参考花费（`reference-cost` / `model-metadata`）按 token 和 USD 价目计算，媒体请求没有 token 桶，也没有 Credits 与 USD 的换算依据。所以媒体不进参考花费，不折算美元，不显示“参考估算”。
- 展示方式：媒体行说明里只写“团队 Credits 计费，实测约 …”。不做按张或按秒的自动估价。

## UI

- 复用 `mediaRowsHtml`、启用开关、刷新、未启用分组，不新增组件。
- 行说明（`hint`）在“图像 · 已登录可用”后追加行里的 `note`（上游代号、Credits 实测）。别的来源没有 `note`，渲染不变。
- 桌面端 1440 验收：Qoder 来源页出现两行，开关可以关闭、再启用，关闭后进入“未启用模型”分组。

## 改动文件

- `proxy/qoder/media.js`（新）：目录、校验、请求体构造、响应转换、任务轮询。
- `proxy/qoder/transport.js`：`signedMedia`。
- `proxy/qoder/provider.js`：构造里挂载媒体。
- `proxy/qoder/auth.js`、`proxy/management.js`：账号标识与退出登录清理任务。
- `proxy/shared/media.js`：`selectMedia` 支持 `aliases`。
- `public/components/media-models.js`：显示 `note`。
- `fixtures/qoder/media.mjs`、`test/qoder-media.test.mjs`：脱敏夹具与测试。
- 文档：本文、`docs/reverse-proxy.md`、`docs/plans/media-proxy.md`、`docs/plans/media-generation-proxy.md`（更正）。

## 测试与夹具

夹具来自探针：图像响应用 1×1 PNG 代替 1.1 MB 的真实图；视频提交、排队、进行中、完成、500 都是脱敏后的真实形状，签名 URL 替换为占位。测试覆盖：

- 请求信封（解码后字段、`sessionId` / `requestId` 为 UUID、头部、`Encode=1`、无聊天专用头）。
- 图像：b64 返回、被拒绝的参数不请求上游、https 响应不被转换、内容拒绝、500 只请求一次。
- 视频：`seconds` 为字符串、任务行不含提示词、轮询状态映射、终态不再请求上游、失败不保存上游文字、缺任务号。
- 网关：别名 `ge3i` / `wan30` 命中规范 id，停用后 `model_not_found`，请求记录不含提示词。
- 登录状态、设置共存、`accountKey()`。

## 验证计划

- `npm test`、`npm run check`。
- Playwright 只测桌面 1440，使用独立数据目录和模拟上游，检查 Qoder 来源页媒体列表与开关。
- 不做真实上游调用（积分已经花过一次；再探针要用户确认）。合并前的真实验证建议：图像 1 次、视频 2 秒 720p 1 次，约 5 到 10 Credits，由用户决定。

## 风险

- `ge3i` 与 Qwen-Image 3.0 的对应是推测，所以显示名带“映射待确认”。
- 内容拒绝在 Qoder 的真实错误形状未知，可能被当作普通 4xx / 5xx 显示。
- 上游可能随时改变 `sessionId` 规则或 `size` 取值，上游返回 500 时用户只看到“上游请求失败（500）”。
- 图像 data URL 响应大（最大 32 MB 上限内），内存占用随之增加。
- 视频 `video_url` 带签名，约 30 天过期，泄露等于泄露视频。
- 视频进行中 `progress` 长时间停在 50，不能当作卡住。
- 额度是账号级，团队内别人使用也会让额度变化，不能用额度差精确算单次花费。

## PR 拆分与规模

一个 PR 即可：代码约 170 行、测试约 190 行、夹具约 15 行、文档约 250 行。首帧 / 参考图视频（含上传入口）另开 PR。

## 对 `docs/plans/media-generation-proxy.md` 的更正

该文件是早期草案，已按 `media-proxy.md` 实现为 Grok / Codex / AGY 的现状，Qoder 部分需更正：

1. 图像模型是上游 `ge3i`，对外 `qwen-image-3.0`，不是 `qwen-image-2.0-pro`；尺寸有 10 种，不止 1024x1024。
2. 视频内层是 `{model: 'wan30', prompt, seconds: '5'（字符串）, size}`；其他模式用 `input_reference {type, image_url}`，不是 `media.first_frame`。
3. `sessionId` 必须是非空 UUID，空串返回 500，不是“另一个 UUID”。
4. 图像响应是 `data[0].url` 的 data URL（base64），不是 https 地址；文档里“已知响应是 URL、只允许 `response_format: 'url'`”不成立，现在只支持 `b64_json`。
5. 视频结果是 `video_url`（OSS 签名，约 30 天），不是约 10 天；实测一个 5 秒视频约 158 秒，不需要 18 分钟的轮询器。
6. 媒体请求用 `application/json` 进出，不是 `text/plain`；不需要 `signedInference` 的聊天头。
7. 文档里的 PR1 到 PR9、`unverified` / `needs_key` / `unavailable` 状态、`media-capability.json` 不存在于代码；实际是 `ready` 加 `enabled`。
8. “Qoder 不做、需要手动探针”已过时；探针已有，第一刀已实现。
9. Credits 不换算美元的结论保持不变，并明确不进参考花费。

## 需要用户决定

1. `ge3i` 的映射确认后，是否把显示名改为 `Qwen-Image 3.0`（id 不变）？
2. 是否保留 `ge3i` 作为别名？当前保留（`wan30` 别名按要求保留）。
3. 图像 `response_format: 'url'` 是 400 还是把 data URL 当 url 返回？当前 400。
4. 首帧 / 参考图视频是否做，上传入口是新的 multipart 路由，还是接受 `data:` URL 后由代理上传？
5. 是否开放 `duration` 到 30 与 `720P` / `1080P` 别名？当前开放（已在探针列表里）。
6. 媒体任务是否需要在页面里列出和删除？
7. 是否在页面显示 Credits 实测说明？当前只有一句静态说明。
8. 合并前是否做一次小额真实验证？
