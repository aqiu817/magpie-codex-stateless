# magpie-codex-stateless（中文说明）

[magpie](https://usemagpie.ai) 网关中间件：修 **GPT 模型**走 Responses 协议时 Azure 系中转的 400——路由前把 Codex 请求变成**无状态**形态，剥掉三类「绑定在服务端资源上的状态」：顶层 `previous_response_id`、`input[]` 每个 item 的 `id`（`msg_…`/`rs_…`/`fc_…`）、以及任何 `encrypted*` 字段（加密思维链）。多资源 Azure 轮转中转从此**每一发都收**，不再挑资源报 400。

**默认只对 gpt/codex 系模型**的 Responses 协议请求（`ctx.protocol === "responses"`）生效，例如经 magpie 接入的 Codex CLI / VS Code 扩展 / 桌面 App；其余模型、其余协议、响应流一律不动。

## 修的是什么问题

Azure OpenAI 的 Responses API 是有状态的：返回的 item 与加密思维链按「创建它的那个 Azure 资源」存储和加密。one-api 系中转背后是资源池轮转、不做会话粘性，Codex 每轮重放历史（id + 加密块 + `previous_response_id`）落到非原资源就报错：

```
Previous response with id 'resp_…' not found.
The requested item was created under a different Azure OpenAI resource.
The encrypted content for item rs_… could not be verified.
```

真实中转实测（agentrouter，Responses 原生直通）：1:1 真实 Codex 重放 → **400，约 19 秒后返回**；同一请求剥离状态后 → **200，`response.completed`**。（本中间件在路由**前**剥离——没有重试、没有浪费的往返。）

## 安装

```sh
magpie plugin add magpie-codex-stateless          # npm
magpie plugin add github:aqiu817/magpie-codex-stateless   # 或 GitHub
magpie plugin add ./magpie-codex-stateless        # 或本地文件夹
```

装上开着即可，默认静默。

## 选项

在插件行的选项按钮（JSON）或 `magpie plugin options magpie-codex-stateless '<json>'` 设置：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `models` | `""` → 内置 `["gpt", "codex"]` | 作用范围：只剥匹配的模型——字符串或数组，`/正则/` 风格（与社区 model-map 同惯例）或普通子串。未设/空 = 仅 gpt/codex 系模型；`"*"` = 所有 Responses 模型全剥 |
| `debug` | `false` | 每个被剥离的请求向 magpie 日志输出一行 `codex-stateless: model=… stripped=4 (prevId=1 ids=2 encrypted=1)`（magpie 限 60 行/分钟） |
| `stripPreviousResponseId` | `true` | 设 `false` 保留会话指针——只适合依赖服务端状态、**且上游具备会话粘性**的增量式客户端；无粘性中转上保留 = 每轮重放 400 `Previous response not found` |
| `stripEncrypted` | `true` | 设 `false` 保留 `encrypted_content`，让模型在上游能解密续接时接续上轮思考；校验型 Azure 后端会报 `The encrypted content … could not be verified`；宽容中转上只是每轮多传加密块 tokens |

## 剥什么 / 留什么

| 剥（服务端绑定状态） | 留（其余全部） |
| --- | --- |
| 顶层 `previous_response_id` | 消息正文、`instructions` |
| `input[]` 每个 item 的 `id` | 工具调用与输出的 `call_id`、工具 `arguments` |
| 任何 `encrypted*` 字段（`encrypted_content` 等） | `store`、`include`、`reasoning`、`tools`、请求头 |

其他协议（`anthropic`/`chat`/`gemini`）天然无此类状态，原样放行。magpie 自己的请求（会话标题、路由分类器、代搜）不经过中间件。

## 代价

模型不再跨轮「接续」隐藏思维链，每轮重新推理；对话内容与工具调用不受影响。在中转没有粘性的场景下这不算代价——那些状态本来就会被拒。

## 「每个请求都剥离」的后果（真机逐字段实测）

| 剥离字段 | 功能影响 | 实测 |
| --- | --- | --- |
| `previous_response_id` | 对**全量重放型客户端**（Codex 每轮在 `input` 里重放完整对话——上游项目抓包与本插件真机双重确认）无影响；只有依赖服务端保存上下文的**增量式客户端**才会丢上下文——这类用户用 `stripPreviousResponseId: false` 保留指针 | 不剥：400（约 19 秒后）；剥：200 |
| item `id` | 无——`call_id` 配对不动，工具循环照常 | 200 |
| `encrypted*` | 功能无损：中转既不校验加密块（真实块重放也 200），无粘性时也无法续接。剥离省掉每轮重传加密块的 tokens；`stripEncrypted: false` 保留只在能解密续接的上游上有收益 | 真实块保留：200；剥离：200 |

prompt cache 不受影响（剥离行为每轮一致，请求形态稳定）。magpie 的故障切换/重试看到的请求形态一致——剥离幂等。

## 与 aggregate-repair 的关系

[xwyjh3612/aggregate-repair](https://github.com/xwyjh3612/aggregate-repair) 是同族中间件，默认保守（默认保留会话指针与加密块、带图形设置页、按渠道派生会话 ID 防 409）。它的默认适合未知客户端与可能有粘性的上游；本插件的默认针对实测场景——中转 20 秒内就丢弃服务端状态，每轮重放必须自给自足。设 `stripPreviousResponseId: false` + `stripEncrypted: false` 即等价于它的默认模式。

## 开发

```sh
bun test test/strip.test.mjs    # 37 个测试，含 moejs 沙箱静态检查
```

`lib/strip.js` 是 [codex-strip-proxy](https://github.com/AnnaofArendelle/codex-strip-proxy) `sanitize()` 的移植，语法刻意保守（已在 magpie 的 moejs 沙箱真机验证）。

## 许可

MIT
