// lib/strip.js — 纯函数：剥离 OpenAI Responses 请求里的服务端绑定状态。
// 语法刻意保守（var/function/indexOf/hasOwnProperty）：本文件同时跑在
// magpie 网关的 moejs（Go JS 引擎）沙箱和 node/bun 测试里，只依赖已真机验证的语法子集。
//
// 剥离对象（codex-strip-proxy sanitize() 的忠实移植）：
//   - 顶层 previous_response_id
//   - input[] 每个 item 的 id（msg_/rs_/fc_ 等服务端 id；call_id 是独立字段名，不受影响）
//   - input[] 每个 item 上任何 encrypted* 前缀字段（encrypted_content 加密思维链等）
// 其余字段一律不动。剥离为原地修改，幂等。

function isObj(x) {
  return x !== null && typeof x === "object"
}

// 返回 { stripped, breakdown }。body 非对象时 stripped=0。
// opts（可省）：
//   prevId !== false  → 剥顶层 previous_response_id（默认剥；false 保留，供依赖服务端
//                       会话指针的增量式客户端——需上游具备粘性，否则重放必炸）
//   enc   !== false  → 剥 input item 的 encrypted* 字段（默认剥；false 保留加密思维链，
//                       供能解密续接的上游——代价是每轮重放多传加密块）
function stripResponsesState(body, opts) {
  var o = (opts && typeof opts === "object") ? opts : {}
  var stripPrev = o.prevId !== false
  var stripEnc = o.enc !== false
  var stripped = 0
  var breakdown = { prevId: 0, ids: 0, encrypted: 0 }
  if (!isObj(body)) return { stripped: stripped, breakdown: breakdown }
  if (stripPrev && Object.prototype.hasOwnProperty.call(body, "previous_response_id")) {
    delete body.previous_response_id
    stripped++
    breakdown.prevId++
  }
  if (Object.prototype.toString.call(body.input) === "[object Array]") {
    for (var i = 0; i < body.input.length; i++) {
      var it = body.input[i]
      if (!isObj(it)) continue
      if (Object.prototype.hasOwnProperty.call(it, "id")) {
        delete it.id
        stripped++
        breakdown.ids++
      }
      if (stripEnc) {
        var ks = Object.keys(it)
        for (var j = 0; j < ks.length; j++) {
          if (ks[j].indexOf("encrypted") === 0) {
            delete it[ks[j]]
            stripped++
            breakdown.encrypted++
          }
        }
      }
    }
  }
  return { stripped: stripped, breakdown: breakdown }
}

// matchModels("agentrouter/gpt-6.1-sol", ["/gpt-5|codex/"]) → true
// pattern 支持 "/正则/" 风格（与社区 model-map 惯例一致）或普通子串匹配。
// patterns 为空/非字符串项跳过；无效正则降级为普通匹配。
function matchModels(model, patterns) {
  if (model == null || patterns == null) return false
  var m = String(model)
  var list = Object.prototype.toString.call(patterns) === "[object Array]" ? patterns : [patterns]
  for (var i = 0; i < list.length; i++) {
    var p = list[i]
    if (typeof p !== "string" || p === "") continue
    var src = p
    if (p.length > 2 && p.charAt(0) === "/" && p.charAt(p.length - 1) === "/") {
      src = p.slice(1, -1)
    }
    try {
      if (new RegExp(src).test(m)) return true
    } catch (e) {
      if (m.indexOf(src) !== -1) return true
    }
  }
  return false
}

// options.models 规范化：未设/空 → null（全剥）；设了 → 字符串数组（只剥匹配项）。
function normalizeModels(models) {
  if (models == null) return null
  var list = typeof models === "string" ? [models] : (Object.prototype.toString.call(models) === "[object Array]" ? models : null)
  if (!list) return null
  var out = []
  for (var i = 0; i < list.length; i++) {
    if (typeof list[i] === "string" && list[i].trim() !== "") out.push(list[i].trim())
  }
  return out.length ? out : null
}

export { stripResponsesState, matchModels, normalizeModels }
