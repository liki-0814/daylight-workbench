# 图像与视频反代

状态：按此实现。日期 2026-10-28。一次做完，不按来源拆成几轮。

三家都用各自已经存在的登录，不另加 API Key：

| 来源 | 页面上的名字 | 这次做 | 登录 |
| --- | --- | --- | --- |
| `grok` | Grok | 图像、图像编辑、视频 | 现有 OIDC，`cli-chat-proxy.grok.com` |
| `codex` | Codex | 图像、图像编辑 | 现有 ChatGPT 登录，`chatgpt.com/backend-api/codex` |
| `agy` | AGY | Gemini 图像、图像编辑 | 现有 Google 登录，`daily-cloudcode-pa.googleapis.com` |

Codex 和 AGY 这次没有视频。本机 Codex 0.161.0 没有视频接口。AGY 现有的 `v1internal` 路径上也没有视频方法。Qoder 的文生图和文生视频后来经真实探针确认并接入，见 [qoder-media.md](qoder-media.md)。Copilot、Kimi、千问办公和自定义来源没有生成接口。

文本目录、`model-list.js`、模型路由和 Pi 同步都不收这些模型。`supportsImages` 和 `isVL` 只表示能看图，不表示能生成图。

## 文件

来源自己的请求放在 `proxy/<来源>/media.js`。路由、校验、任务和页面组件是公共的。`proxy/shared/` 不导入来源目录。

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `proxy/grok/media.js` | 新增 | Grok 图像与视频 |
| `proxy/codex/media.js` | 新增 | Codex 图像 |
| `proxy/agy/media.js` | 新增 | Gemini 图像 |
| `proxy/grok/provider.js`、`proxy/codex/provider.js`、`proxy/agy/provider.js` | 修改 | 挂上 `mediaModels()` 和 `executeMedia()`。现有 `execute()` 仍只做文本 |
| `proxy/grok/auth.js`、`proxy/codex/auth.js`、`proxy/agy/auth.js` | 不改 | Grok 用 `credential()`，Codex 用 `read()`，AGY 用 `token()` |
| `proxy/grok/protocol.js`、`proxy/codex/provider.js` 的文本转发、`proxy/agy/protocol.js` | 不改协议 | 文本编解码保持原样。Codex 文本路径继续拒绝托管工具 `image_generation` |
| `proxy/grok/models.js`、`proxy/codex/models.js`、`proxy/agy/models.js` | 不改 | 聊天目录的过滤规则不变 |
| `proxy/gateway.js` | 修改 | 四条媒体路由 |
| `proxy/shared/media.js` | 新增 | 路径、正文大小、图片 URL、选择来源 |
| `proxy/shared/media-jobs.js` | 新增 | 视频任务。这次只有 Grok 写入 |
| `proxy/providers.js` | 修改 | `executeMedia`。来源没有该方法则没有媒体 |
| `proxy/management.js` | 修改 | 路由正则加入 `media-models` 和 `media/jobs/:id`。Grok 登出后按 `auth.identity` 删除视频任务 |
| `public/proxy/state.js` | 修改 | `media-models` 的刷新也带 `?refresh=1` |
| `public/components/media-models.js` | 新增 | 三家来源共用的图像与视频列表 |
| `public/components/media-models.css` | 新增 | 只放行布局 |
| `public/proxy/source-page.js` | 修改 | 聊天模型下面挂上这个组件 |
| `test/grok-media.test.mjs`、`test/codex-media.test.mjs`、`test/agy-media.test.mjs` | 新增 | 各来源的模拟上游 |
| `test/media-gateway.test.mjs`、`test/media-models.test.mjs` | 新增 | 路由、任务、组件 |
| `docs/reverse-proxy.md` | 修改 | Grok、Codex、AGY 各补一小节 |

## 前端

新组件放在 `public/components/media-models.js`。折叠和刷新复用 `disclosureSection`、`mountDisclosures`、`refreshButton`、`setRefreshState`。不复用 `model-list.js`，也不复用 `image-input.js`。

`createMediaModels({ source, load })` 对三个来源页是同一个函数。`load()` 读 `GET /api/proxy/sources/:id/media-models`。`models` 为空则整个折叠区隐藏。有模型时标题是「图像与视频」。已登录的来源把下面各节列出的模型全部标成 `ready`，页面写「已登录可用」。没有 `unverified` 这一档，也不等第一次成功调用才放行。行内没有启用、上下文、推理强度或结果链接。

`source-page.js` 把它放在聊天模型列表后面。账号身份变化时 `reset()`。`public/proxy/state.js` 的 `resource()` 今天只给 `models` 附加 `?refresh=1`，媒体刷新要同样带上。`public/proxy/api.js` 已经能拼接 `sources/:id/:operation`，不用改路径函数。

## 公共契约

本机路径：

- `POST /v1/images/generations`
- `POST /v1/images/edits`
- `POST /v1/videos/generations`
- `GET /v1/videos/{id}`

Host、无 Origin、代理 API Key 与现有 `/v1` 相同。`Content-Type` 是 `application/json`，可以带 `charset=utf-8`。`source` 只给本机选来源，不转发给上游。

图片 `url` 只允许 `https://` 或 `data:image/(png|jpeg|webp);base64,...`。单张解码上限 8_000_000 字节。图像生成正文上限 1_000_000。图像编辑和视频提交上限 64_000_000。图像响应缓冲上限 32_000_000。整次调用含正文：图像 180 秒，视频提交 45 秒，视频查询 30 秒。

`response_format` 缺省 `url`。`b64_json` 时 `n` 必须是 1。上游只给了 URL 而客户端要 `b64_json` 时返回 502 `response_format_unavailable`，代理不下载后再编码。

不带 `source` 时，只在 `ready` 的声明里找模型。零个是 `model_not_found`，一个就用它，多个是 400 `model_ambiguous`。失败不改到另一家。来源特有的键，例如 Codex 的 `size`，在选中来源之后由那一家校验。只传 `size`、不传 `source`，且只有 Codex 声明了这个模型时，仍然交给 Codex。

内容策略 code：`content_filter`、`content_safety`、`content_safety_rejected`、`image_gen_content_safety_rejected`、`moderation_rejected`、`policy_violation`、`safety_rejection`。HTTP 400、403、422 不重试。摘要是「上游拒绝了该内容，请修改描述后重试。」

诊断沿用 `RequestTrace`。`metadata.mediaOperation` 取 `image.generate`、`image.edit`、`video.submit`、`video.poll`。不记录提示词、data URI 和输出 URL。

视频任务在 `{dataDir}/proxy/media-jobs.json`，读写走 `serial()`。字段是 `id`、`provider`、`account`、`model`、`operation`、`upstreamId`、`status`、时间、`outputUrl`、`errorCode`。`operation` 只有 `video.submit`。不保存提示词和图片字节。最多 50 条，超出时先删过期终态，再删最早的终态。`GET /v1/videos/{id}` 的 id 是 `vid_` 加 UUID。终态直接返回本地记录。非终态超过 24 小时标成 `expired`，不再请求上游。

| 上游 | 本地 `status` |
| --- | --- |
| HTTP 202，或 `pending` | `in_progress` |
| `done` 且有 `video.url` | `succeeded` |
| `failed` | `failed` |
| `expired`，或本地超过 24 小时 | `expired` |

成功时客户端响应才带 `url`。`DELETE /api/proxy/media/jobs/{id}` 只删本地行，响应不带 URL。

## Grok

已登录时下面这些 id 都是 `ready`，都打到同一主机。令牌和 401 刷新与聊天相同。`jsonCall` 的 `Accept` 是 `application/json`，不走现有 `call()` 的 SSE。主机是 `https://cli-chat-proxy.grok.com/v1`。

| 模型 id | 种类 |
| --- | --- |
| `grok-imagine-image-2.0` | 图像 |
| `grok-imagine-image` | 图像 |
| `grok-imagine-image-quality` | 图像。官方价目写明 2026-11-02 起停用，停用前仍转发 |
| `grok-imagine-video-1.5` | 视频 |
| `grok-imagine-video-1.5-lite` | 视频 |
| `grok-imagine-video` | 视频 |

图像生成允许 `prompt`、`n`、`response_format`、`aspect_ratio`、`resolution`、`quality`。`n` 在 `url` 时为 1 到 10。`aspect_ratio` 是 `1:1`、`16:9`、`9:16`、`4:3`、`3:4`、`3:2`、`2:3`、`2:1`、`1:2`、`19.5:9`、`9:19.5`、`20:9`、`9:20`、`21:9`、`5:2`、`auto`。`resolution` 是 `1k`、`2k`。`quality` 是 `low`、`medium`、`auto`。

图像编辑是 `image` 或 `images` 二选一，最多五张，元素为 `{ "type": "image_url", "url" }`。

视频允许 `prompt`、`duration`、`aspect_ratio`、`resolution`、`image`。`duration` 是 1 到 15。`resolution` 是 `480p`、`720p`、`1080p`。`aspect_ratio` 是 `1:1`、`16:9`、`9:16`、`4:3`、`3:4`、`3:2`、`2:3`、`21:9`、`5:2`。有参考图时 `image` 只有 `url`。`reference_images`、声音、钉帧、编辑和延长返回 400。

上游图像成功体取 `data[].url`。视频提交只取 `request_id`。任务的 `account` 是 `auth.identity`，登出成功后删除。`cost_in_usd_ticks` 只留在当次响应里，当作上游标价，不写入用量历史。

## Codex

登录方法是 `auth.read()`，不是 `credential()` 或 `token()`。已登录时这些 id 都是 `ready`，请求都会转发。它们不从聊天 `parseModels` 里读，因为那个解析只保留 `visibility === 'list'` 的对话模型。

| 模型 id | 说明 |
| --- | --- |
| `gpt-image-2.5-flare` | Images 2.5 的默认模型 |
| `gpt-image-2.5-flare-2026-09-08` | Flare 的日期快照，规则与 Flare 相同 |
| `gpt-image-2.5-sunburst` | Images 2.5 里更慢、编辑更细的那个 |
| `gpt-image-2.5-sunburst-2026-09-08` | Sunburst 的日期快照，规则与 Sunburst 相同 |
| `chatgpt-image-latest` | 官方列表里的别名，尺寸和画质规则按 2.5 |
| `gpt-image-2` | 本机 Codex 0.161.0 的 CLI 默认值 |
| `gpt-image-2-2026-04-21` | `gpt-image-2` 的日期快照，规则与 `gpt-image-2` 相同 |
| `gpt-image-1.5` | 仍在官方图像接口的模型列表里 |
| `gpt-image-1-mini` | 仍在官方图像接口的模型列表里 |

没有名为 `gpt-image-2.5` 的 id。客户端若传入这个名字，返回 400，并在错误里写出 Flare 和 Sunburst 两个 id。不列出 `gpt-image-1`。官方图像接口写明它已在 2026-10-23 关闭。本机 Codex 0.161.0 的二进制没有 2.5 的 id；2.5 和日期快照以 2026-10-28 的官方图像接口为准，仍然转发。

请求用 `auth.read()` 的令牌，打到 `https://chatgpt.com/backend-api/codex/images/generations` 和 `/images/edits`。公开的 `api.openai.com/v1/images/*` 会用 401 `hardened_oauth_rule_missing` 拒绝这把套餐令牌。请求头包含 `ChatGPT-Account-ID`、`Originator: codex_cli_rs`、`Version`、`User-Agent` 和 `OAI-Product-Sku: codex`。401 按 Codex 文本的规则刷新一次。文本里的 `forward()` 继续走 `api.openai.com/v1/responses`，并拒绝 `tools[].type === 'image_generation'`。

公共字段在 Codex 里的对应关系：

| 公共字段 | 发给 Codex |
| --- | --- |
| `prompt`、`n`、`response_format` | 同名 |
| `quality` | `gpt-image-2` 及其日期快照是 `low`、`medium`、`high`、`auto`。两个 2.5 模型、它们的日期快照和 `chatgpt-image-latest` 再加 `xhigh` 和 `max` |
| `aspect_ratio` 加 `resolution` | `gpt-image-2`、它的日期快照、两个 2.5 模型、它们的日期快照和 `chatgpt-image-latest` 换成 `size`：宽高为 16 的倍数，长边不超过 3840，长短边不超过 3:1。`gpt-image-2` 及其日期快照另要求像素在 655360 和 8294400 之间。`gpt-image-1.5` 与 `gpt-image-1-mini` 只接受 `1024x1024`、`1536x1024`、`1024x1536`、`auto` |
| 编辑的 `image` / `images` | 同一条 URL 规则。`gpt-image-2` 及其日期快照不接受 `input_fidelity`，也不接受透明背景。2.5 两个模型、它们的日期快照和 `chatgpt-image-latest` 接受透明背景 |

客户端可以直接传 `size`。选中的来源不是 Codex 时返回 400。没有视频模型，`grok-imagine-video-*` 不会选到 Codex。

## AGY 上的 Gemini

来源 id 仍是 `agy`。已登录时下面四个 id 都是 `ready`，都会转发。目录里没有某一条时仍然列出并转发，上游拒绝就把它的状态码返回客户端。不用 `supportsImages` 推断，那个字段在 `models.js` 里已经变成视觉输入 `isVL`。也不把这些 id 写进聊天 `parseModels`。

- `gemini-3-pro-image`
- `gemini-3.1-flash-image`
- `gemini-3.1-flash-image-preview`
- `gemini-2.5-flash-image-preview`

不调用 `AgyProvider.call('generateContent')`。`call()` 只在方法名以 `streamGenerateContent` 开头时才选择 `daily-cloudcode-pa.googleapis.com`，并且 `headerDeadline().settle()` 在响应头到达后就结束超时。图像请求自己发到 `https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent`，令牌、`User-Agent` 和正文外壳与 `call()` 相同：`{ project, model, userAgent: 'antigravity', requestId, request }`。180 秒的中止信号覆盖响应正文。

`request.generationConfig.responseModalities` 为 `['IMAGE']`。编辑时把参考图放进同一条用户消息的 `inlineData`，最多五张，MIME 只限 PNG、JPEG、WebP。`aspect_ratio` 写入 `generationConfig.imageConfig.aspectRatio`。`resolution` 的 `1k`、`2k` 写成 `imageSize` 的 `1K`、`2K`。其他 `quality` 或分辨率返回 400，不删掉再送。

响应读取候选内容里的 `inlineData`。客户端没写 `response_format` 时，这一家按 `b64_json` 返回，因为上游给的是字节。客户端明确要 `url` 而上游没有 URL 时，返回 502 `response_format_unavailable`。不把图像 part 送进文本 SSE 解析。401 和项目号的检查与现有生成请求相同。没有视频行。页面与另外两家一样显示「已登录可用」。

## 审查

审查分四层。前三层不过，不能把第四层的页面当成功能通过。每一层只证明它那一列里的事。

| 层 | 手段 | 证明 | 不证明 |
| --- | --- | --- | --- |
| 规格对照 | 对照本文和当前源码读一遍 | 文件位置、登录方法、主机、模型清单和聊天目录隔离与代码一致 | 上游会接受请求 |
| 模拟上游 | `node --test` 跑下面列出的测试 | 每个要转发的 id 都会进上游 JSON，错误主机和聊天目录污染会失败 | 真实账号的额度或令牌有效 |
| 真实账号 | 每条通道抽一个模型打一次，结果写入 `docs/verification/proxy/media-proxy.json` | 该登录和主机能生成 | 同通道上没抽到的 id 也成功 |
| 页面 | 组件测试，再加上来源页的一次浏览器操作 | 列表与聊天控件分开，没有媒体的来源不出现折叠区 | 图片或视频的画面质量 |

### 规格对照

审查者打开实现，逐项核对，不靠回忆：

- `proxy/shared/` 没有导入 `proxy/grok/`、`proxy/codex/`、`proxy/agy/`。
- Grok 媒体主机是 `cli-chat-proxy.grok.com`。Codex 图像用 `auth.read()` 打 `chatgpt.com/backend-api/codex`。AGY 图像打 `daily-cloudcode-pa.googleapis.com/v1internal:generateContent`，不经过 `AgyProvider.call('generateContent')`。
- 本文列出的每个 id 都出现在对应 `mediaModels()` 里，并且 `executeMedia` 会把这个 id 原样放进上游 `model`。`gpt-image-2.5` 和 `gpt-image-1` 不在清单里。
- `parseModels`、`GET /v1/models`、模型路由和 Pi 同步的数据源没有这些 id。
- Codex 文本路径仍拒绝 `tools[].type === 'image_generation'`。
- 管理路由正则包含 `media-models`。`state.js` 对 `media-models` 的刷新带 `?refresh=1`。
- 任务文件和用量记录的断言里没有提示词、data URI 和输出 URL。

### 模拟上游

测试使用临时数据目录和注入的 `fetchImpl`，不读取本机 Keychain。每个要转发的模型 id 各有一条断言：请求 URL 的主机正确，JSON 里的 `model` 等于该 id。Grok 的六条、Codex 的九条、AGY 的四条都要有，不能只测每家的第一个。

另外必须有这些失败用例：

- 未登录。
- 非法图片 URL、超过单张 8 MB、图像编辑超过五张。
- Grok 收到 `reference_images`、声音或钉帧时返回 400，且没有发出上游请求。
- 裸 id `gpt-image-2.5` 返回 400，错误正文同时含 `gpt-image-2.5-flare` 和 `gpt-image-2.5-sunburst`。
- Codex 的 `size` 在选中 Codex 之后才校验。同一请求若被分到 Grok 或 AGY，返回 400。
- AGY 省略 `response_format` 时返回 `b64_json`。明确要求 `url` 而上游只有 `inlineData` 时返回 502 `response_format_unavailable`。
- Grok 视频：提交得到 `request_id`，查询把 `done` 写成 `succeeded`，`failed` 不保存错误正文，终态不再请求上游，登出删除该 `auth.identity` 的任务。
- 聊天 `GET /v1/models` 的响应里没有本文的媒体 id。
- 组件在空列表时隐藏，有模型时没有启用框、上下文、推理强度和 Fast。

命令是仓库现有的 `npm test`，超时保持 30 秒。媒体测试不单独加长到会等待真实生成的时间。

### 真实账号

每条通道只抽一个模型，用本机已经登录的账号打本机反代，不打上游控制台的按次 Key。记录写到 `docs/verification/proxy/media-proxy.json`，字段只保留时间、来源、模型 id、本机路径、上游主机、HTTP 状态和是否拿到图像 URL、`b64_json` 或视频 `request_id`。不写提示词、令牌、图片字节和输出 URL。

| 通道 | 抽取 | 通过 |
| --- | --- | --- |
| Grok 图像 | `grok-imagine-image-2.0` 生成一张 | 主机是 `cli-chat-proxy.grok.com`，响应有 `data[].url` |
| Grok 视频 | `grok-imagine-video-1.5` 提交一条短视频并查询到终态 | 先有 `request_id`，终态为 `succeeded` 或上游明确的 `failed` |
| Codex 图像 | `gpt-image-2.5-flare` 生成一张 | 主机是 `chatgpt.com`，响应有 `url` 或 `b64_json` |
| AGY 图像 | `gemini-3.1-flash-image` 生成一张 | 主机是 `daily-cloudcode-pa.googleapis.com`，响应有 `b64_json` |

同一次登录、同一主机上的其他 id 由模拟测试证明「id 被原样转发」。真实抽取失败时，只把这一条通道标成未通过，不改记其他通道，也不把失败说成全部模型不可用。`grok-imagine-image-quality` 在 2026-11-02 之后不再要求真实抽取。

### 页面

组件测试先证明折叠区的数据来自 `media-models`，并且不渲染聊天控件。实现改动了来源页之后，再用浏览器打开反向代理的 Grok、Codex、AGY 三个来源页：聊天模型区仍在，其下有「图像与视频」，行上能看见对应 id 和「已登录可用」。再打开 Copilot 来源页，确认没有这个折叠区。这一步检查行为，不把一张静态截图当作通过。

模拟测试和 `docs/reverse-proxy.md` 与实现同一批完成。真实账号记录在模拟测试通过之后补上，不放进 `npm test`。

## 不做

Qoder 的首帧 / 参考图视频与图像编辑（文生图、文生视频见 [qoder-media.md](qoder-media.md)）。Copilot、Kimi、千问办公、自定义来源的媒体。Codex 和 AGY 的视频。网页 cookie。`api.x.ai` 和另外购买的图像 API Key。Grok 的参考图视频、声音、钉帧、视频编辑、延长和 lite。把媒体模型写进聊天目录或在页面里直接生成。把聊天额度换算成剩余张数。
