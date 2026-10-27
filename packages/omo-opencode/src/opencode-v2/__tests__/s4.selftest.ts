/**
 * S4 selftest: the client shim's semantic paths and the S2b-2 semantic hook bridge.
 *
 * Run inside the v2 container:
 *
 *   bun packages/omo-opencode/src/opencode-v2/__tests__/s4.selftest.ts
 *
 * Part A drives the *shim* against a fake V2 context whose `session.context()/active()/list()`,
 * `storage`, `model.default()`, `provider.list()`, `agent.list()` and `skill.list()` answer like the
 * 2.1.4 host does, and asserts the V1 view is real data:
 *
 *   session.messages   non-empty, legal V1 parts, ids preserved, unmappable entries counted
 *   session.todo       write -> read round trip through ctx.storage, shared with the hook bridge
 *   session.status     running session -> busy, listed session -> idle (not constant idle)
 *   config.get         model/provider/agent from the live domains + the project config file
 *   session.summarize  compact() mapped, receipt converted, providerState counted when lost
 *
 * Part B assembles the *real* V1 runtime, injects recording handlers for the semantic keys, and
 * fires fake V2 hook events (`prompt`, `context`, `http.request`) through the bridge:
 *
 *   chat.message                          text-part injection lands in prompt.text
 *   experimental.chat.system.transform    a pushed system string lands in SystemPart[]
 *   experimental.chat.messages.transform  a text part lands in the provider message content
 *   chat.params                           temperature lands in the context `options`
 *   chat.headers                          a header lands on the Request object
 *
 * Part C pins the S4 disable-list decision (two hooks off, four released).
 *
 * Everything runs under a throwaway HOME/XDG sandbox so the real plugin config is never touched.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { V2ContextLike } from "../adapter/types"

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "omo-v2-s4-selftest-"))
const projectDir = path.join(sandbox, "project")
const configDir = path.join(sandbox, "config")
fs.mkdirSync(projectDir, { recursive: true })
fs.mkdirSync(path.join(configDir, "opencode"), { recursive: true })

process.env["HOME"] = sandbox
process.env["XDG_CONFIG_HOME"] = configDir
process.env["XDG_DATA_HOME"] = path.join(sandbox, "data")
process.env["XDG_STATE_HOME"] = path.join(sandbox, "state")
process.env["XDG_CACHE_HOME"] = path.join(sandbox, "cache")
process.env["DO_NOT_TRACK"] = "1"

// The host reads these files itself; the shim must read the same ones (S4 requirement 5).
fs.writeFileSync(
  path.join(configDir, "opencode", "opencode.json"),
  JSON.stringify({ formatter: { prettier: { command: ["prettier"], extensions: [".ts"] } } }),
)
fs.writeFileSync(
  path.join(projectDir, "opencode.json"),
  JSON.stringify({ skills: { paths: [path.join(projectDir, "skills")] }, model: "global/default" }),
)

type Check = { readonly name: string; readonly ok: boolean; readonly detail: string }
const checks: Check[] = []
const pendingCleanups: Array<() => Promise<void>> = []

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`)
}

// ---------------------------------------------------------------------------------------------
// Fake V2 host
// ---------------------------------------------------------------------------------------------

const SESSION_A = "ses_s4_a"
const SESSION_B = "ses_s4_b"

/** `SessionMessage.Info[]` exactly as 2.1.4 decodes `session.context()` (flat, content in `content`). */
function createSessionMessages(): unknown[] {
  const created = "2026-10-27T10:00:00.000Z"
  return [
    { id: "msg_user", type: "user", time: { created }, text: "please fix the build", files: [], agents: [{ name: "sisyphus" }] },
    {
      id: "msg_assistant",
      type: "assistant",
      time: { created },
      agent: "sisyphus",
      model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
      parentID: "msg_user",
      cost: 0.012,
      tokens: { input: 1000, output: 200, reasoning: 10, cache: { read: 5, write: 1 } },
      content: [
        { type: "text", text: "looking at the build" },
        { type: "tool-call", id: "call_1", name: "bash", input: { command: "bun run build" } },
        { type: "tool-result", id: "call_1", name: "bash", result: { type: "text", value: "build failed" } },
        { type: "reasoning", text: "the build failed because of X" },
      ],
    },
    { id: "msg_compaction", type: "compaction", status: "completed", time: { created }, summary: "context compacted" },
    { id: "msg_idle", type: "idle", time: { created }, outcome: "succeeded" },
    { id: "msg_switch", type: "model-switched", time: { created }, model: { id: "x", providerID: "y" } },
  ]
}

function createStorageBackend(): { backend: Record<string, unknown>; data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  const backend = {
    get: async (key: string) => data.get(key),
    set: async (key: string, value: unknown) => {
      data.set(key, value)
    },
    remove: async (key: string) => {
      data.delete(key)
    },
    scan: async (options: { prefix: string }) => ({
      entries: [...data.entries()]
        .filter(([key]) => key.startsWith(options.prefix))
        .map(([key, value]) => ({ key, value })),
    }),
  }
  return { backend, data }
}

type FakeHost = {
  readonly context: Record<string, unknown>
  readonly storageData: Map<string, unknown>
  readonly registrations: Array<{ name: string; callback: (input: unknown) => unknown; disposed: boolean }>
  readonly compactCalls: Array<Record<string, unknown>>
}

function createFakeHost(): FakeHost {
  const storage = createStorageBackend()
  const registrations: FakeHost["registrations"] = []
  const compactCalls: Array<Record<string, unknown>> = []

  const context: Record<string, unknown> = {
    location: { directory: projectDir, project: { id: "prj_s4", directory: projectDir, canonical: projectDir } },
    app: { name: "omo-v2-s4-selftest", version: "0.0.0", channel: "local" },
    storage: storage.backend,
    session: {
      context: async () => createSessionMessages(),
      active: async () => ({ [SESSION_A]: { type: "running" } }),
      list: async () => ({
        data: [
          { id: SESSION_A, projectID: "prj_s4", title: "a" },
          { id: SESSION_B, projectID: "prj_s4", title: "b" },
        ],
        cursor: {},
      }),
      get: async (input: unknown) => ({ id: (input as { sessionID?: string })?.sessionID ?? SESSION_A, projectID: "prj_s4" }),
      create: async () => ({ id: SESSION_A, projectID: "prj_s4" }),
      interrupt: async () => undefined,
      prompt: async () => ({ id: "msg_prompt" }),
      compact: async (input: unknown) => {
        compactCalls.push((input as Record<string, unknown>) ?? {})
        return { type: "compaction", id: "msg_compact", sessionID: SESSION_A, delivery: "queue", time: { created: 0 } }
      },
      remove: async () => undefined,
      hook: async (name: string, callback: (input: unknown) => unknown) => {
        const registration = { name, callback, disposed: false }
        registrations.push(registration)
        return {
          dispose: async () => {
            registration.disposed = true
          },
        }
      },
    },
    agent: {
      list: async () => ({
        location: { directory: projectDir },
        data: [
          { id: "sisyphus", name: "sisyphus", mode: "primary", description: "main agent", hidden: false },
          { id: "oracle", name: "oracle", mode: "subagent", description: "advisor", hidden: false },
        ],
      }),
    },
    model: {
      list: async () => ({ location: { directory: projectDir }, data: [] }),
      default: async () => ({
        location: { directory: projectDir },
        data: { id: "claude-sonnet-4-5", providerID: "anthropic" },
      }),
    },
    provider: {
      list: async () => ({
        location: { directory: projectDir },
        data: [
          {
            provider: { id: "anthropic", name: "Anthropic" },
            models: new Map([["claude-sonnet-4-5", { id: "claude-sonnet-4-5", name: "Sonnet 4.5" }]]),
          },
        ],
      }),
    },
    skill: {
      list: async () => ({
        location: { directory: projectDir },
        data: [{ id: "sk_1", name: "omo-skill", description: "a skill", path: "/tmp/skills/omo" }],
      }),
    },
    worktree: {},
  }

  return { context, storageData: storage.data, registrations, compactCalls }
}

// ---------------------------------------------------------------------------------------------
// Part A: shim semantics
// ---------------------------------------------------------------------------------------------

async function runShimChecks(): Promise<void> {
  const { createV1ClientShim, readClientShimStats, captureSessionTodos } = await import("../adapter/client-shim")
  const { isLegalV1Part } = await import("../adapter/session-mapping")
  const { TODO_STORAGE_PREFIX } = await import("../adapter/todo-store")

  const host = createFakeHost()
  const client = createV1ClientShim({
    context: host.context as unknown as V2ContextLike,
    directory: projectDir,
  }) as unknown as Record<string, Record<string, (input?: unknown) => Promise<{ data?: unknown }>>>

  // ---- session.messages ------------------------------------------------------------------
  const messagesResponse = await client["session"]!["messages"]!({ path: { id: SESSION_A } })
  const messages = (messagesResponse.data ?? []) as Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
  record("session.messages is not empty", messages.length > 0, `${messages.length} messages`)

  const allParts = messages.flatMap((message) => message.parts)
  const illegal = allParts.filter((part) => !isLegalV1Part(part))
  record(
    "session.messages parts are legal V1 parts",
    allParts.length > 0 && illegal.length === 0,
    `parts=${allParts.length} illegal=${illegal.length}`,
  )
  record(
    "session.messages keeps the original ids and roles",
    messages[0]?.info["id"] === "msg_user"
      && messages[0]?.info["role"] === "user"
      && messages[1]?.info["id"] === "msg_assistant"
      && messages[1]?.info["role"] === "assistant",
    `${String(messages[0]?.info["id"])}/${String(messages[0]?.info["role"])} ${String(messages[1]?.info["id"])}/${String(messages[1]?.info["role"])}`,
  )
  const assistantParts = messages[1]?.parts ?? []
  const toolPart = assistantParts.find((part) => part["type"] === "tool")
  record(
    "assistant content maps to text/tool/reasoning parts with a merged tool state",
    assistantParts.some((part) => part["type"] === "text" && part["text"] === "looking at the build")
      && toolPart !== undefined
      && toolPart["tool"] === "bash"
      && (toolPart["state"] as { status?: string; output?: string }).status === "completed"
      && (toolPart["state"] as { output?: string }).output === "build failed"
      && assistantParts.some((part) => part["type"] === "reasoning"),
    `types=${assistantParts.map((part) => String(part["type"])).join(",")}`,
  )
  const compactionMessage = messages.find((message) => message.info["id"] === "msg_compaction")
  record(
    "compaction messages stay detectable (info.agent + compaction part)",
    compactionMessage !== undefined
      && compactionMessage.info["agent"] === "compaction"
      && compactionMessage.parts.some((part) => part["type"] === "compaction"),
    JSON.stringify(compactionMessage?.info ?? {}),
  )
  const stats = readClientShimStats()
  record(
    "unmappable messages are counted as dropped",
    (stats?.messages.dropped ?? 0) >= 2 && (stats?.messages.parts ?? 0) === allParts.length,
    `dropped=${String(stats?.messages.dropped)} parts=${String(stats?.messages.parts)} last=${JSON.stringify(stats?.messages.last?.droppedReasons)}`,
  )

  // ---- session.todo: write -> read round trip ---------------------------------------------
  const emptyTodos = (await client["session"]!["todo"]!({ path: { id: SESSION_A } })).data as unknown[]
  record("session.todo starts empty (no producer yet)", Array.isArray(emptyTodos) && emptyTodos.length === 0, JSON.stringify(emptyTodos))

  const captured = await captureSessionTodos({
    storage: host.context["storage"],
    sessionID: SESSION_A,
    tool: "todowrite",
    input: { todos: [{ content: "write the test", status: "in_progress", priority: "high" }, { content: "ship it", status: "pending", priority: "low" }] },
  })
  const storedTodos = (await client["session"]!["todo"]!({ path: { id: SESSION_A } })).data as Array<Record<string, unknown>>
  const storageKey = `${TODO_STORAGE_PREFIX}${SESSION_A}`
  record(
    "session.todo read/write round trip through ctx.storage",
    captured && storedTodos.length === 2
      && storedTodos[0]?.["content"] === "write the test"
      && storedTodos[0]?.["status"] === "in_progress"
      && host.storageData.has(storageKey),
    `captured=${String(captured)} read=${JSON.stringify(storedTodos)} key=${String(host.storageData.has(storageKey))}`,
  )
  const otherSession = (await client["session"]!["todo"]!({ path: { id: SESSION_B } })).data as unknown[]
  record(
    "session.todo is partitioned per session",
    Array.isArray(otherSession) && otherSession.length === 0,
    JSON.stringify(otherSession),
  )
  record(
    "a non-todo tool does not touch the store",
    (await captureSessionTodos({ storage: host.context["storage"], sessionID: SESSION_A, tool: "bash", input: { todos: [] } })) === false,
    "capture refused for bash",
  )

  // ---- session.status ---------------------------------------------------------------------
  const statusResponse = await client["session"]!["status"]!()
  const status = (statusResponse.data ?? {}) as Record<string, { type: string }>
  record(
    "session.status derives busy AND idle from active()+list()",
    status[SESSION_A]?.type === "busy" && status[SESSION_B]?.type === "idle",
    JSON.stringify(status),
  )

  // The real 2.1.4 host has no `session.active` on the plugin SessionDomain, so the event stream is
  // the live source; the registry must win over the list() idle default.
  const { noteSessionEvent, resetSessionStatuses } = await import("../adapter/status-registry")
  noteSessionEvent({ id: "evt_1", type: "session.status", data: { sessionID: SESSION_B, status: { type: "busy" } } })
  const registryStatus = (await client["session"]!["status"]!()).data as Record<string, { type: string }>
  record(
    "session.status uses the event-stream registry when the host has no active()",
    registryStatus[SESSION_B]?.type === "busy" && registryStatus[SESSION_A]?.type === "busy",
    JSON.stringify(registryStatus),
  )
  noteSessionEvent({ id: "evt_2", type: "session.idle", data: { sessionID: SESSION_B } })
  const idleAgain = (await client["session"]!["status"]!()).data as Record<string, { type: string }>
  record(
    "session.status follows session.idle back to idle",
    idleAgain[SESSION_B]?.type === "idle",
    JSON.stringify(idleAgain),
  )
  resetSessionStatuses()

  // ---- config.get -------------------------------------------------------------------------
  const configResponse = await client["config"]!["get"]!()
  const config = (configResponse.data ?? {}) as Record<string, unknown>
  const provider = config["provider"] as Record<string, { models?: Record<string, unknown> }> | undefined
  const agents = config["agent"] as Record<string, unknown> | undefined
  record(
    "config.get is not empty and carries model/provider/agent",
    Object.keys(config).length > 0
      && config["model"] === "anthropic/claude-sonnet-4-5"
      && provider?.["anthropic"] !== undefined
      && Object.keys(provider["anthropic"]?.models ?? {}).includes("claude-sonnet-4-5")
      && agents?.["sisyphus"] !== undefined,
    `keys=${Object.keys(config).sort().join(",")} model=${String(config["model"])}`,
  )
  record(
    "config.get reads the same config files the host reads",
    (config["formatter"] as Record<string, unknown> | undefined)?.["prettier"] !== undefined
      && (config["skills"] as { paths?: string[] } | undefined)?.paths?.length === 1,
    `sources=${JSON.stringify(readClientShimStats()?.config.sources)}`,
  )

  // ---- app.skills -------------------------------------------------------------------------
  const skills = (await client["app"]!["skills"]!()).data as Array<Record<string, unknown>>
  record(
    "app.skills lists the host skills",
    skills.length === 1 && skills[0]?.["name"] === "omo-skill" && skills[0]?.["id"] === undefined,
    JSON.stringify(skills),
  )

  // ---- session.summarize ------------------------------------------------------------------
  const summarized = (await client["session"]!["summarize"]!({ path: { id: SESSION_A } })).data as Record<string, unknown>
  record(
    "session.summarize maps to compact() and converts the receipt",
    host.compactCalls.length === 1
      && host.compactCalls[0]?.["sessionID"] === SESSION_A
      && summarized["compacted"] === true
      && summarized["messageID"] === "msg_compact",
    JSON.stringify(summarized),
  )
}

// ---------------------------------------------------------------------------------------------
// Part B: semantic hooks, on the real V1 runtime
// ---------------------------------------------------------------------------------------------

async function runSemanticChecks(): Promise<void> {
  const adapter = await import("../adapter")
  const hooksModule = await import("../hooks")
  const { SEMANTIC_SLOT_OF } = await import("../hooks/semantic-hooks")

  const host = createFakeHost()
  const runtime = await adapter.assembleV1RuntimeOnV2(host.context as unknown as V2ContextLike)
  record("V1 runtime assembled for semantic hooks", runtime.report.hookCount > 0, `${runtime.report.hookCount} hooks`)

  const calls = { system: 0, messages: 0, params: 0, headers: 0, chatMessage: 0 }

  // Wrap the real handlers plus a marker so the assertion is about the *writeback*, not just the call.
  const realChatMessage = runtime.hooks["chat.message"]
  runtime.hooks["chat.message"] = async (input, output) => {
    calls.chatMessage += 1
    await realChatMessage?.(input, output)
    const parts = (output as { parts: Array<Record<string, unknown>> }).parts
    parts.push({ type: "text", text: "SELFTEST_KEYWORD_CONTEXT" })
  }

  runtime.hooks["experimental.chat.system.transform"] = async (_input, output) => {
    calls.system += 1
    ;(output as { system: string[] }).system.push("SELFTEST_SYSTEM_MARKER")
  }

  const realMessagesTransform = runtime.hooks["experimental.chat.messages.transform"]
  runtime.hooks["experimental.chat.messages.transform"] = async (input, output) => {
    calls.messages += 1
    await realMessagesTransform?.(input, output)
    const messages = (output as { messages: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> }).messages
    const last = messages[messages.length - 1]
    last?.parts.push({ type: "text", text: "SELFTEST_MESSAGES_MARKER" })
  }

  runtime.hooks["chat.params"] = async (_input, output) => {
    calls.params += 1
    const out = output as { temperature: number; options: Record<string, unknown> }
    out.temperature = 0.42
    out.options["selftestParam"] = true
  }

  runtime.hooks["chat.headers"] = async (_input, output) => {
    calls.headers += 1
    ;(output as { headers: Record<string, string> }).headers["x-selftest"] = "on"
  }

  const registrations: FakeHost["registrations"] = []
  const context = {
    ...host.context,
    session: {
      ...(host.context["session"] as Record<string, unknown>),
      hook: async (name: string, callback: (input: unknown) => unknown) => {
        const registration = { name, callback, disposed: false }
        registrations.push(registration)
        return {
          dispose: async () => {
            registration.disposed = true
          },
        }
      },
    },
  }

  const cleanup = await hooksModule.registerOpenCodeV2Hooks(context, runtime)
  pendingCleanups.push(cleanup)

  const snapshot = hooksModule.readOpenCodeV2HookBridge()
  const bridged = snapshot?.bridged ?? []
  const expectedSemantic = [
    "chat.message",
    "chat.params",
    "chat.headers",
    "experimental.chat.system.transform",
    "experimental.chat.messages.transform",
  ]
  const missing = expectedSemantic.filter((key) => !bridged.includes(key))
  record(
    "all five semantic keys bridged",
    missing.length === 0,
    missing.length === 0 ? expectedSemantic.join(",") : `missing ${missing.join(",")}`,
  )
  record(
    "semantic keys land on the right V2 slots",
    registrations.some((entry) => entry.name === "prompt")
      && registrations.some((entry) => entry.name === "context")
      && registrations.some((entry) => entry.name === "http.request")
      && SEMANTIC_SLOT_OF["chat.params"] === "context"
      && SEMANTIC_SLOT_OF["chat.headers"] === "http.request",
    registrations.map((entry) => entry.name).join(","),
  )

  const promptRegistration = registrations.find((entry) => entry.name === "prompt")
  const contextRegistration = registrations.find((entry) => entry.name === "context")
  const httpRegistration = registrations.find((entry) => entry.name === "http.request")

  // ---- chat.message <-> prompt ------------------------------------------------------------
  if (promptRegistration === undefined) {
    record("chat.message bridged", false, "no prompt registration")
  } else {
    const event: Record<string, unknown> = {
      sessionID: SESSION_A,
      messageID: "msg_new",
      prompt: { text: "hello world", files: [{ uri: "file:///tmp/a.png", name: "a.png" }] },
      metadata: { agent: "sisyphus", model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } },
      delivery: "steer",
    }
    await promptRegistration.callback(event)
    const prompt = event["prompt"] as { text: string; files?: Array<{ uri: string }> }
    record(
      "chat.message writeback: injected text part reaches prompt.text",
      prompt.text.includes("hello world") && prompt.text.includes("SELFTEST_KEYWORD_CONTEXT"),
      JSON.stringify(prompt.text),
    )
    record(
      "chat.message keeps the prompt attachments",
      Array.isArray(prompt.files) && prompt.files.some((file) => file.uri === "file:///tmp/a.png"),
      JSON.stringify(prompt.files),
    )
    const counter = hooksModule.readOpenCodeV2HookBridge()?.counters["chat.message"]
    record(
      "chat.message counter: fired + wrote back",
      counter !== undefined && counter.fired === 1 && counter.writebacks >= 1,
      JSON.stringify(counter),
    )
  }

  // ---- system.transform + messages.transform + chat.params <-> context --------------------
  if (contextRegistration === undefined) {
    record("context bridged", false, "no context registration")
  } else {
    const providerMessages = [
      { id: "msg_u", role: "user", content: [{ type: "text", text: "first question" }] },
      { id: "msg_a", role: "assistant", content: [{ type: "text", text: "first answer" }] },
      { id: "msg_u2", role: "user", content: [{ type: "text", text: "second question" }] },
    ]
    const event: Record<string, unknown> = {
      sessionID: SESSION_A,
      agent: "sisyphus",
      model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
      system: [{ type: "text", text: "base system prompt" }],
      messages: providerMessages,
      options: { temperature: 0.1, maxTokens: 4096 },
      tools: {},
    }
    await contextRegistration.callback(event)

    const system = event["system"] as Array<{ type: string; text: string }>
    record(
      "system.transform writeback: V1 string lands in SystemPart[]",
      system.length === 2 && system[1]?.text === "SELFTEST_SYSTEM_MARKER" && system[0]?.text === "base system prompt",
      JSON.stringify(system),
    )

    const messages = event["messages"] as Array<{ content: Array<{ type: string; text?: string }> }>
    const lastContent = messages[2]?.content ?? []
    record(
      "messages.transform writeback: appended V1 part lands in provider content",
      lastContent.some((part) => part.type === "text" && part.text === "SELFTEST_MESSAGES_MARKER")
        && messages[0]?.content[0]?.text === "first question",
      JSON.stringify(messages.map((message) => message.content)),
    )

    const options = event["options"] as Record<string, unknown>
    record(
      "chat.params writeback: temperature + options reach the V2 request options",
      options["temperature"] === 0.42 && options["selftestParam"] === true && options["maxTokens"] === 4096,
      JSON.stringify(options),
    )

    const counters = hooksModule.readOpenCodeV2HookBridge()?.counters
    record(
      "context counters: three V1 keys fired, all wrote back",
      (counters?.["experimental.chat.system.transform"]?.fired ?? 0) === 1
        && (counters?.["experimental.chat.messages.transform"]?.fired ?? 0) === 1
        && (counters?.["chat.params"]?.fired ?? 0) === 1
        && (counters?.["experimental.chat.system.transform"]?.writebacks ?? 0) >= 1
        && (counters?.["experimental.chat.messages.transform"]?.writebacks ?? 0) >= 1
        && (counters?.["chat.params"]?.writebacks ?? 0) >= 1,
      JSON.stringify({
        system: counters?.["experimental.chat.system.transform"],
        messages: counters?.["experimental.chat.messages.transform"],
        params: counters?.["chat.params"],
      }),
    )
  }

  // ---- chat.headers <-> http.request ------------------------------------------------------
  if (httpRegistration === undefined) {
    record("chat.headers bridged", false, "no http.request registration")
  } else {
    const request = new Request("https://api.example.com/v1/messages", { headers: { "x-base": "1" } })
    await httpRegistration.callback({
      sessionID: SESSION_A,
      agent: "sisyphus",
      model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
      kind: "primary",
      request,
    })
    record(
      "chat.headers writeback: header set on the V2 Request",
      request.headers.get("x-selftest") === "on" && request.headers.get("x-base") === "1",
      JSON.stringify(Object.fromEntries(request.headers.entries())),
    )
    const counter = hooksModule.readOpenCodeV2HookBridge()?.counters["chat.headers"]
    record(
      "chat.headers counter: fired + wrote back",
      counter !== undefined && counter.fired === 1 && counter.writebacks >= 1,
      JSON.stringify(counter),
    )
  }

  // ---- containment -----------------------------------------------------------------------
  let threw = false
  try {
    await promptRegistration?.callback({ not: "a prompt event" })
    await contextRegistration?.callback({ not: "a context event" })
    await httpRegistration?.callback({ not: "an http event" })
  } catch (error) {
    threw = true
    record("semantic hooks never throw", false, String(error))
  }
  if (!threw) record("semantic hooks never throw", true, "malformed events counted, host untouched")

  record(
    "real V1 handlers ran under the semantic bridge",
    calls.chatMessage >= 1 && calls.system === 1 && calls.messages === 1 && calls.params === 1 && calls.headers >= 1,
    JSON.stringify(calls),
  )

  // ---- S4 disable list -------------------------------------------------------------------
  const disabled = snapshot?.disabled ?? []
  record(
    "S4 disable list: only the two writer-less hooks stay off",
    disabled.length === 2
      && disabled.includes("compaction-todo-preserver")
      && disabled.includes("todo-continuation-enforcer"),
    disabled.join(","),
  )
  // Released = no longer in the V2 default list. `preemptive-compaction` additionally sits behind
  // `experimental.preemptive_compaction` in the V1 config, so its factory proves nothing here.
  const released: ReadonlyArray<readonly [string, string]> = [
    ["claude-code-hooks", "claudeCodeHooks"],
    ["compaction-context-injector", "compactionContextInjector"],
    ["preemptive-compaction", "preemptiveCompaction"],
    ["session-notification", "sessionNotification"],
  ]
  const stillListed = released.filter(([hook]) => disabled.includes(hook)).map(([hook]) => hook)
  const stillOff = released
    .filter(([hook, factory]) => hook !== "preemptive-compaction" && runtime.report.hookFactories[factory] !== true)
    .map(([hook]) => hook)
  record(
    "S4 released hooks left the default list and are assembled",
    stillListed.length === 0 && stillOff.length === 0,
    stillListed.length > 0 ? `still disabled: ${stillListed.join(",")}` : `still off: ${stillOff.join(",")}`,
  )

  await cleanup()
  await runtime.dispose()
  hooksModule._resetOpenCodeV2HooksForTesting()
}

async function main(): Promise<void> {
  await runShimChecks()
  await runSemanticChecks()
}

try {
  await main()
} catch (error) {
  console.error("selftest crashed:", error)
  process.exitCode = 1
} finally {
  for (const cleanup of pendingCleanups) {
    try {
      await cleanup()
    } catch (error) {
      console.error("cleanup failed:", error)
    }
  }
  fs.rmSync(sandbox, { recursive: true, force: true })
}

const failed = checks.filter((check) => !check.ok)
console.log(`\nS4 selftest: ${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) {
  console.error(`failed: ${failed.map((check) => check.name).join(", ")}`)
  process.exitCode = 1
}
