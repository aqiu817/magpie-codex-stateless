// bun test test/strip.test.mjs
import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { stripResponsesState, matchModels, normalizeModels } from "../lib/strip.js"
import { onRequest } from "../codex-stateless.middleware.js"

// —— 测试夹具：1:1 真实 Codex 重放形态（与 M0 真机 D2 测试同构）——
function codexReplayBody() {
  return {
    model: "agentrouter/gpt-6.1-sol",
    instructions: "You are Codex, a coding agent.",
    input: [
      {
        type: "message",
        id: "msg_0d02635a257d4a12016afc8650ba6081978cf46182502802e0",
        role: "assistant",
        content: [{ type: "output_text", text: "ok" }],
      },
      {
        type: "reasoning",
        id: "rs_0d02635a257d4a12016afc86501adc8197a63aaeace7683992",
        summary: [],
        encrypted_content: "gAAAAABq_IZQi_dPodeApvLtaLhM97-TbqohBPi97ud0W7X3v",
      },
      {
        type: "function_call",
        id: "fc_0d02635a257d4a12016afc8659999999999999999999999",
        call_id: "call_9f8e7d6c5b4a",
        name: "shell",
        arguments: '{"command":["ls","-la"]}',
      },
      {
        type: "function_call_output",
        call_id: "call_9f8e7d6c5b4a",
        output: "total 0",
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Reply with exactly: ok" }],
      },
    ],
    previous_response_id: "resp_0d02635a257d4a12016afc864edc3481978ec11435f9a6d22e",
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
  }
}

function ctx(protocol = "responses", options = undefined) {
  return { protocol, options, path: "/v1/responses", model: "x", stream: true, state: {} }
}

// —— stripResponsesState ——

test("计数精确：5 处剥离（prev_id + 3 个 item id + 1 个 encrypted_content）", () => {
  const b = codexReplayBody()
  const { stripped } = stripResponsesState(b)
  // previous_response_id(1) + message.id(1) + reasoning.id(1) + reasoning.encrypted_content(1) + function_call.id(1)
  // function_call_output 只有 call_id（不剥）
  expect(stripped).toBe(5)
})

test("call_id 与工具参数逐字节保留", () => {
  const b = codexReplayBody()
  stripResponsesState(b)
  const fc = b.input[2]
  expect(fc.call_id).toBe("call_9f8e7d6c5b4a")
  expect(fc.arguments).toBe('{"command":["ls","-la"]}')
  expect(fc.name).toBe("shell")
  expect(b.input[3].call_id).toBe("call_9f8e7d6c5b4a")
  expect(b.input[3].output).toBe("total 0")
})

test("消息正文与顶层业务字段不动", () => {
  const b = codexReplayBody()
  stripResponsesState(b)
  expect(b.input[0].content[0].text).toBe("ok")
  expect(b.input[4].content[0].text).toBe("Reply with exactly: ok")
  expect(b.instructions).toContain("Codex")
  expect(b.store).toBe(false)
  expect(b.stream).toBe(true)
  expect(b.include).toEqual(["reasoning.encrypted_content"])
  expect(b.tool_choice).toBe("auto")
  expect(b.model).toBe("agentrouter/gpt-6.1-sol")
})

test("剥离后无残留 id / previous_response_id / encrypted*", () => {
  const b = codexReplayBody()
  stripResponsesState(b)
  expect(b.previous_response_id).toBeUndefined()
  for (const it of b.input) {
    expect(it.id).toBeUndefined()
    for (const k of Object.keys(it)) expect(k.startsWith("encrypted")).toBe(false)
  }
})

test("幂等：二次剥离计数为 0", () => {
  const b = codexReplayBody()
  stripResponsesState(b)
  expect(stripResponsesState(b).stripped).toBe(0)
})

test("input 为字符串：不动，计数 0", () => {
  const b = { model: "m", input: "hello", previous_response_id: "resp_x" }
  const { stripped } = stripResponsesState(b)
  expect(stripped).toBe(1) // 只剥了 prev_id
  expect(b.input).toBe("hello")
})

test("缺 input：只剥 prev_id", () => {
  const b = { model: "m", previous_response_id: "resp_x", instructions: "i" }
  const { stripped } = stripResponsesState(b)
  expect(stripped).toBe(1)
  expect(b.instructions).toBe("i")
})

test("input 里混入非对象项：安全跳过", () => {
  const b = { input: [null, "text", { id: "msg_1", encrypted_content: "e" }] }
  const { stripped } = stripResponsesState(b)
  expect(stripped).toBe(2)
  expect(b.input[0]).toBeNull()
  expect(b.input[1]).toBe("text")
})

test("无任何状态字段：计数 0，body 原样", () => {
  const b = { model: "m", input: [{ type: "message", role: "user", content: [] }] }
  const raw = JSON.stringify(b)
  const { stripped } = stripResponsesState(b)
  expect(stripped).toBe(0)
  expect(JSON.stringify(b)).toBe(raw)
})

test("encrypted 前缀全家族都剥（encrypted_content / encrypted_reasoning）", () => {
  const b = { input: [{ type: "reasoning", encrypted_content: "a", encrypted_reasoning: "b" }] }
  const { stripped } = stripResponsesState(b)
  expect(stripped).toBe(2)
  expect(Object.keys(b.input[0])).toEqual(["type"])
})

test("body 非对象：安全返回 0", () => {
  expect(stripResponsesState(null).stripped).toBe(0)
  expect(stripResponsesState(undefined).stripped).toBe(0)
  expect(stripResponsesState("str").stripped).toBe(0)
  expect(stripResponsesState(42).stripped).toBe(0)
})

// —— matchModels ——

test("matchModels：/正则/ 风格命中", () => {
  expect(matchModels("agentrouter/gpt-6.1-sol", ["/gpt-5|gpt-6/"])).toBe(true)
})

test("matchModels：普通子串命中", () => {
  expect(matchModels("agentrouter/gpt-6.1-sol", ["gpt-6.1"])).toBe(true)
})

test("matchModels：不命中", () => {
  expect(matchModels("agentrouter/gpt-6.1-sol", ["/claude/"])).toBe(false)
})

test("matchModels：数组任一命中即 true", () => {
  expect(matchModels("m/claude-x", ["/gpt/", "/claude/"])).toBe(true)
})

test("matchModels：无效正则降级为普通匹配", () => {
  expect(matchModels("m/gpt-5(", ["/gpt-5(/"])).toBe(true)
  expect(matchModels("m/other", ["/gpt-5(/"])).toBe(false)
})

test("matchModels：空模式/null 安全", () => {
  expect(matchModels("m", [])).toBe(false)
  expect(matchModels("m", [""])).toBe(false)
  expect(matchModels("m", null)).toBe(false)
  expect(matchModels(null, ["/x/"])).toBe(false)
})

// —— normalizeModels ——

test("normalizeModels：未设/空 → null（全剥）", () => {
  expect(normalizeModels(undefined)).toBeNull()
  expect(normalizeModels(null)).toBeNull()
  expect(normalizeModels("")).toBeNull()
  expect(normalizeModels([])).toBeNull()
  expect(normalizeModels("   ")).toBeNull()
})

test("normalizeModels：字符串 → 单元素数组；数组过滤空项", () => {
  expect(normalizeModels("gpt-5")).toEqual(["gpt-5"])
  expect(normalizeModels(["a", "", "  ", "b"])).toEqual(["a", "b"])
})

test("normalizeModels：非字符串数组元素被过滤", () => {
  expect(normalizeModels([1, "a", null])).toEqual(["a"])
  expect(normalizeModels([1, 2])).toBeNull()
})

// —— 开关选项（对照 aggregate-repair 学到的改进）——

test("stripPreviousResponseId=false：保留 prev_id，其余照剥", () => {
  const b = codexReplayBody()
  const r = stripResponsesState(b, { prevId: false })
  expect(b.previous_response_id).toBeDefined()
  expect(b.input[1].encrypted_content).toBeUndefined()
  expect(r.stripped).toBe(4) // 3 个 item id + 1 个 encrypted
  expect(r.breakdown).toEqual({ prevId: 0, ids: 3, encrypted: 1 })
})

test("stripEncrypted=false：保留 encrypted_content，其余照剥", () => {
  const b = codexReplayBody()
  const r = stripResponsesState(b, { enc: false })
  expect(b.previous_response_id).toBeUndefined()
  expect(b.input[1].encrypted_content).toBeDefined()
  expect(b.input[1].id).toBeUndefined()
  expect(r.stripped).toBe(4) // prev_id + 3 个 item id
  expect(r.breakdown).toEqual({ prevId: 1, ids: 3, encrypted: 0 })
})

test("两个开关都关：只剥 item id（aggregate-repair 默认形态）", () => {
  const b = codexReplayBody()
  const r = stripResponsesState(b, { prevId: false, enc: false })
  expect(b.previous_response_id).toBeDefined()
  expect(b.input[1].encrypted_content).toBeDefined()
  expect(b.input[0].id).toBeUndefined()
  expect(r.stripped).toBe(3)
})

test("onRequest 透传 stripPreviousResponseId/stripEncrypted", () => {
  const b = codexReplayBody()
  expect(onRequest(b, ctx("responses", { stripPreviousResponseId: false, stripEncrypted: false }))).toBe(b)
  expect(b.previous_response_id).toBeDefined()
  expect(b.input[1].encrypted_content).toBeDefined()
})

test("开关未设时默认全剥（向后兼容）", () => {
  const b = codexReplayBody()
  const r = stripResponsesState(b, {})
  expect(r.stripped).toBe(5)
  expect(r.breakdown).toEqual({ prevId: 1, ids: 3, encrypted: 1 })
})

// —— onRequest（入口，moejs 行为模拟）——

test("非 responses 协议：原样放行（返回 undefined）", () => {
  const b = codexReplayBody()
  expect(onRequest(b, ctx("anthropic"))).toBeUndefined()
  expect(onRequest(b, ctx("chat"))).toBeUndefined()
  expect(onRequest(b, ctx("gemini"))).toBeUndefined()
  expect(b.previous_response_id).toBeDefined() // 未被触碰
})

test("responses 协议：返回 body 且状态已剥", () => {
  const b = codexReplayBody()
  const out = onRequest(b, ctx("responses"))
  expect(out).toBe(b)
  expect(b.previous_response_id).toBeUndefined()
  expect(b.input[1].encrypted_content).toBeUndefined()
})

test("models 选项不匹配：放行不剥", () => {
  const b = codexReplayBody()
  expect(onRequest(b, ctx("responses", { models: "/claude/" }))).toBeUndefined()
  expect(b.previous_response_id).toBeDefined()
})

test("models 选项匹配：正常剥离", () => {
  const b = codexReplayBody()
  expect(onRequest(b, ctx("responses", { models: "/gpt-6/" }))).toBe(b)
  expect(b.previous_response_id).toBeUndefined()
})

test("models 设为空串/空数组：等同未设，走内置默认（gpt/codex 系）", () => {
  const b1 = codexReplayBody()
  expect(onRequest(b1, ctx("responses", { models: "" }))).toBe(b1)
  expect(b1.previous_response_id).toBeUndefined()
  const b2 = codexReplayBody()
  expect(onRequest(b2, ctx("responses", { models: [] }))).toBe(b2)
  expect(b2.previous_response_id).toBeUndefined()
})

test("内置默认：非 gpt/codex 模型放行不剥（灰宝要求的作用域）", () => {
  const b = codexReplayBody()
  b.model = "agentrouter/claude-opus-5"
  expect(onRequest(b, ctx("responses"))).toBeUndefined()
  expect(b.previous_response_id).toBeDefined() // 未被触碰
  expect(b.input[1].encrypted_content).toBeDefined()
})

test("内置默认：codex 命名模型命中（无 gpt 字样）", () => {
  const b = codexReplayBody()
  b.model = "openai/codex-mini-latest"
  expect(onRequest(b, ctx("responses"))).toBe(b)
  expect(b.previous_response_id).toBeUndefined()
})

test('models="*"：显式全剥（非 gpt 模型也剥）', () => {
  const b = codexReplayBody()
  b.model = "agentrouter/claude-opus-5"
  expect(onRequest(b, ctx("responses", { models: "*" }))).toBe(b)
  expect(b.previous_response_id).toBeUndefined()
})

test("debug=true 且发生剥离：输出一行计数日志", () => {
  const logs = []
  const orig = console.log
  console.log = (m) => logs.push(m)
  try {
    const b = codexReplayBody()
    onRequest(b, ctx("responses", { debug: true }))
  } finally {
    console.log = orig
  }
  expect(logs.length).toBe(1)
  expect(logs[0]).toContain("codex-stateless:")
  expect(logs[0]).toContain("stripped=5")
  expect(logs[0]).toContain("prevId=1")
  expect(logs[0]).toContain("encrypted=1")
})

test("debug=true 但无剥离：不输出", () => {
  const logs = []
  const orig = console.log
  console.log = (m) => logs.push(m)
  try {
    onRequest({ model: "m", input: [{ type: "message", role: "user", content: [] }] }, ctx("responses", { debug: true }))
  } finally {
    console.log = orig
  }
  expect(logs.length).toBe(0)
})

test("ctx 缺失/异常形态：安全放行", () => {
  const b = codexReplayBody()
  expect(onRequest(b, undefined)).toBeUndefined()
  expect(onRequest(b, {})).toBeUndefined()
  expect(onRequest(null, ctx("responses"))).toBeUndefined()
  expect(onRequest("str", ctx("responses"))).toBeUndefined()
})

// —— moejs 兼容静态检查 ——

const mwSrc = readFileSync(new URL("../codex-stateless.middleware.js", import.meta.url), "utf8")
const libSrc = readFileSync(new URL("../lib/strip.js", import.meta.url), "utf8")
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

test("moejs 沙箱静态检查：无 Node API / fetch / 定时器", () => {
  for (const [name, src] of [["middleware", mwSrc], ["lib/strip.js", libSrc]]) {
    expect(src).not.toMatch(/require\(/)
    expect(src).not.toMatch(/node:/)
    expect(src).not.toMatch(/fetch\(/)
    expect(src).not.toMatch(/setTimeout|setInterval|setImmediate/)
    expect(src).not.toMatch(/process\./)
    expect(src).not.toMatch(/Buffer\./)
  }
})

test("moejs 导入纪律：入口只相对导入包内文件", () => {
  const imports = [...mwSrc.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1])
  expect(imports.length).toBe(1)
  expect(imports[0]).toBe("./lib/strip.js")
})

test("纯中间件包结构：无 main/exports，middleware 指向存在的文件", () => {
  expect(pkg.main).toBeUndefined()
  expect(pkg.exports).toBeUndefined()
  expect(pkg.magpie.middleware).toBe("./codex-stateless.middleware.js")
  expect(mwSrc.length).toBeGreaterThan(0)
})

test("package.json 关键字段齐备", () => {
  expect(pkg.name).toBe("magpie-codex-stateless")
  expect(pkg.type).toBe("module")
  expect(pkg.magpie.options).toEqual({ models: "", debug: false, stripPreviousResponseId: true, stripEncrypted: true })
  expect(pkg.magpie.icon).toMatch(/^data:image\/svg\+xml,/)
  expect(pkg.magpie.summary.en).toBeTruthy()
  expect(pkg.magpie.summary.zh).toBeTruthy()
  expect(pkg.keywords).toContain("opencode")
  expect(pkg.keywords).toContain("opencode-plugin")
})
