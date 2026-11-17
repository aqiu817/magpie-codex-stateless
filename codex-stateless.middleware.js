// codex-stateless.middleware.js — magpie 网关中间件入口。
// Agent 的 Responses 协议请求在路由前剥掉服务端绑定状态（previous_response_id /
// input[].id / encrypted* 字段），使其成为任何 Azure 资源池都能接受的无状态形态。
// 响应侧、其他协议（anthropic/chat/gemini）一律不碰。
//
// 环境约束（moejs）：无定时器、无 fetch、无 Node API；只能相对导入包内文件。
// 语法刻意保守，与 lib/strip.js 一致（真机已验证的子集）。

import { stripResponsesState, matchModels, normalizeModels } from "./lib/strip.js"

// 返回请求体继续发送；不属于本插件职责范围时返回 undefined（原样放行）。
// options（plugins.json 里本插件的 options）:
//   models: string | string[] — 作用范围（"/正则/" 或普通子串）：
//     未设/空 = 内置默认 ["gpt","codex"]（只对 gpt/codex 系模型生效，如 gpt-5.6-sol、codex-mini）
//     "*"     = 所有 Responses 模型全剥
//   debug:  boolean — 每个被剥离的请求向 magpie 日志输出一行计数（上限 60 行/分钟，默认关）
//   stripPreviousResponseId: boolean（默认 true）— false 保留会话指针，供依赖服务端状态、
//     且上游具备会话粘性的增量式客户端；上游无粘性时保留会 400（not found）
//   stripEncrypted: boolean（默认 true）— false 保留加密思维链，供能解密续接的上游；
//     校验型 Azure 后端会报 "encrypted content could not be verified"

// 内置默认作用域：gpt/codex 系模型（Codex 客户端使用的模型族）。
var DEFAULT_MODELS = ["gpt", "codex"]

export function onRequest(body, ctx) {
  if (!ctx || ctx.protocol !== "responses") return
  if (!body || typeof body !== "object") return
  var o = (typeof ctx.options === "object" && ctx.options !== null) ? ctx.options : {}
  var models = normalizeModels(o.models) // null = 未配置
  var stripAll = models !== null && models.length === 1 && models[0] === "*"
  if (models === null) models = DEFAULT_MODELS
  if (!stripAll && !matchModels(body.model, models)) return
  var r = stripResponsesState(body, { prevId: o.stripPreviousResponseId, enc: o.stripEncrypted })
  if (o.debug === true && r.stripped > 0) {
    console.log(
      "codex-stateless: model=" + (body.model || "-") +
      " stripped=" + r.stripped +
      " (prevId=" + r.breakdown.prevId + " ids=" + r.breakdown.ids + " encrypted=" + r.breakdown.encrypted + ")"
    )
  }
  return body
}
